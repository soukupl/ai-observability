import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashUsageName } from '../src/analysis/usage.js';
import { dropCache, readCache, writeCache } from '../src/cc-cache.js';
import { identityOf, loadConfig, removeToken, saveConfig, tokenFingerprint, type TokenEntry } from '../src/config.js';
import { readDelivery, writeTokenDelivery } from '../src/delivery.js';
import { sessionStartEvent, turnSummaryEvent } from '../src/events.js';
import { writeJsonAtomic } from '../src/fsutil.js';
import { writeJob } from '../src/jobs.js';
import { collectorConfigPath } from '../src/paths.js';
import { streamDirName, unresolvedDirName } from '../src/projects.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { EventQueue, type StreamKey } from '../src/queue.js';
import { flushQueue, getCollectorConfig, prepareForSend, probeCollectorConfig } from '../src/sender.js';
import { runWorker } from '../src/worker.js';
import {
  ACME,
  bearerOf,
  cleanupHomes,
  fakeAdapter,
  gitRepo,
  okResponder,
  startServer,
  tmpHome,
  tokenResponder,
  writeProjects,
  writeTestConfig,
  writeTestTokens,
  type Received,
} from './helpers.js';
import { bound, enqueueFor, OPEN, queueStore } from './queue-helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  cleanupHomes();
});

const PK = 'github.com/acme/billing';
const hmac = (key: string, s: string) => createHmac('sha256', key).update(s).digest('hex');

const events = (n: number, start = 0): IngestEvent[] =>
  Array.from({ length: n }, (_, i) => turnSummaryEvent({ harness: 'claude-code', turnId: `t${start + i}`, summary: 'Did a thing', at: 1_700_000_000_000 })!);

/** A session_start carrying the capture-time (plain) project ref, plus a turn with plain skill / MCP names. */
const sessionEvents = (sid = 's1'): IngestEvent[] => [
  sessionStartEvent({ harness: 'claude-code', sessionId: sid, at: 1_700_000_000_000, project: { key: PK, name: 'billing' } }),
  {
    ...turnSummaryEvent({ harness: 'claude-code', turnId: `${sid}-t1`, summary: 'x', at: 1_700_000_000_000 })!,
    type: 'turn',
    skills: { 'ship-check': { model: 1, user: 0 } },
    mcp: { github: { search_code: 2 } },
  } as unknown as IngestEvent,
];


const ingests = (srv: { received: Received[] }) => srv.received.filter((r) => r.url === '/api/v1/ingest');
const sentEvents = (srv: { received: Received[] }) => ingests(srv).flatMap((r) => (r.json as { events: IngestEvent[] }).events);

/** One verified token `acme` (writeTestConfig) at a test server, and a store with one bound stream helper. */
async function setup(respond: Parameters<typeof startServer>[0]) {
  const srv = await startServer(respond);
  closers.push(srv.close);
  const paths = tmpHome();
  const config = writeTestConfig(paths, srv.url);
  const store = queueStore(paths);
  const acme = bound('acme', srv.url, 'acme', 'aiobs_u_testtoken');
  const key = (pk = PK): StreamKey => ({ kind: 'project', pk, bind: acme });
  const token = config.tokens[0] as TokenEntry;
  return { srv, paths, config, store, acme, key, token };
}

describe('flushQueue (one token)', () => {
  it('POSTs gzip JSON batches with the Bearer token and acks them', async () => {
    const { srv, paths, config, store, key } = await setup(okResponder());
    store.enqueue(events(750), key());
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'ok', batches: 2, sent: 750, accepted: 750, tokens: { acme: { status: 'ok', sent: 750, left: 0 } } });
    expect(srv.received).toHaveLength(2);
    const req = srv.received[0]!;
    expect(req.url).toBe('/api/v1/ingest');
    expect(req.headers.authorization).toBe('Bearer aiobs_u_testtoken');
    expect(req.headers['content-encoding']).toBe('gzip');
    const body = req.json as { schema: number; machine: { id: string }; identity: { git_email?: string }; events: unknown[] };
    expect(body.schema).toBe(1);
    expect(body.machine.id).toBe(config.machine_id);
    expect(body.identity.git_email).toBe('dev@acme.com');
    expect(body.events).toHaveLength(500);
    expect(store.stats().events).toBe(0);
    expect(readDelivery(paths).tokens.acme?.last_success_at).toBeTruthy();
    expect(readdirSync(paths.queueProjects)).toEqual([]); // empty stream dirs pruned
  });

  it('counts duplicates and rejected events as delivered', async () => {
    const { store, paths, key } = await setup(() => ({
      status: 200,
      body: { accepted: 1, duplicates: 2, rejected: [{ event_id: 'x', reason: 'bad' }] },
    }));
    store.enqueue(events(4), key());
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'ok', accepted: 1, duplicates: 2, rejected: 1 });
    expect(store.stats().events).toBe(0);
  });

  it('keeps events queued on 5xx and backs off; force ignores the backoff', async () => {
    let fail = true;
    const { srv, store, paths, key } = await setup((req) => (fail ? { status: 503 } : okResponder()(req)));
    store.enqueue(events(3), key());
    const r1 = await flushQueue(store, { paths });
    expect(r1.status).toBe('failed');
    expect(r1.error).toBe('HTTP 503');
    expect(store.stats().events).toBe(3);
    const st = readDelivery(paths).tokens.acme!;
    expect(st.consecutive_failures).toBe(1);
    expect(Date.parse(st.next_attempt_at!)).toBeGreaterThan(Date.now());

    const r2 = await flushQueue(store, { paths });
    expect(r2.status).toBe('backoff');
    expect(srv.received).toHaveLength(1);

    fail = false;
    const r3 = await flushQueue(store, { paths }, { force: true });
    expect(r3).toMatchObject({ status: 'ok', sent: 3 });
    expect(readDelivery(paths).tokens.acme!.consecutive_failures).toBe(0);
  });

  it('a retry after a lost response re-sends the same event ids (server de-dupes)', async () => {
    let n = 0;
    const { srv, store, paths, key } = await setup((req) => (++n === 1 ? { status: 500 } : okResponder()(req)));
    store.enqueue(events(2), key());
    await flushQueue(store, { paths });
    await flushQueue(store, { paths }, { force: true });
    const ids = ingests(srv).map((r) => (r.json as { events: Array<{ event_id: string }> }).events.map((e) => e.event_id));
    expect(ids[0]).toEqual(ids[1]);
  });

  it('401: auth_error, the token is blocked and its queue kept', async () => {
    const { store, paths, key } = await setup((req) => (req.url === '/api/v1/ingest' ? { status: 401, body: { error: 'invalid or revoked ingest token' } } : okResponder()(req)));
    store.enqueue(events(1), key());
    const r = await flushQueue(store, { paths });
    expect(r.status).toBe('auth_error');
    expect(r.tokens.acme).toMatchObject({ status: 'auth_error', left: 1 });
    expect(readDelivery(paths).tokens.acme!.blocked).toMatchObject({ status: 401, message: 'invalid or revoked ingest token' });
    expect(store.stats().events).toBe(1);
  });

  it('honours Retry-After on 429', async () => {
    const { store, paths, key } = await setup((req) => (req.url === '/api/v1/ingest' ? { status: 429, headers: { 'retry-after': '600' } } : okResponder()(req)));
    store.enqueue(events(1), key());
    await flushQueue(store, { paths });
    const next = Date.parse(readDelivery(paths).tokens.acme!.next_attempt_at!);
    expect(next - Date.now()).toBeGreaterThan(590_000);
  });

  it('halves the batch on 413 and dead-letters on 400 (into the shared queue/dead)', async () => {
    const { srv, store, paths, key } = await setup((req) => {
      const n = (req.json as { events: unknown[] }).events.length;
      if (n > 2) return { status: 413 };
      return n === 1 ? { status: 400, body: { error: 'bad envelope' } } : okResponder()(req);
    });
    store.enqueue(events(5), key());
    const r = await flushQueue(store, { paths });
    expect(r.sent).toBe(4);
    expect(store.stats().events).toBe(0);
    expect(srv.received.length).toBeGreaterThan(3);
    expect(readdirSync(paths.deadLetter).filter((f) => f.endsWith('.ndjson'))).toHaveLength(1);
  });

  it('times out a hanging server and keeps events', async () => {
    const { store, paths, key } = await setup((req) => (req.url === '/api/v1/ingest' ? { status: 200, delayMs: 5000 } : okResponder()(req)));
    store.enqueue(events(1), key());
    const r = await flushQueue(store, {
      paths,
      transport: async (req) => (await import('../src/http.js')).nodeTransport({ ...req, timeoutMs: 200 }),
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/timeout/);
    expect(store.stats().events).toBe(1);
  });

  it('network failure keeps events', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, 'http://127.0.0.1:9');
    const store = queueStore(paths);
    store.enqueue(events(1), { kind: 'project', pk: PK, bind: bound('acme', 'http://127.0.0.1:9', 'acme', 'aiobs_u_testtoken') });
    const r = await flushQueue(store, { paths });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^network:/);
    expect(store.stats().events).toBe(1);
  });

  it('a 0.1.x flat delivery file reads as empty and is replaced', async () => {
    const { store, paths, key } = await setup(okResponder());
    writeJsonAtomic(paths.delivery, { consecutive_failures: 3, next_attempt_at: new Date(Date.now() + 3600_000).toISOString() });
    store.enqueue(events(1), key());
    expect((await flushQueue(store, { paths })).status).toBe('ok');
    expect(readDelivery(paths).tokens.acme!.consecutive_failures).toBe(0);
  });

  it('a replaced token (other fingerprint) starts with a fresh delivery state', async () => {
    const { store, paths, key, token } = await setup(okResponder());
    writeTokenDelivery(paths, { ...token, token: 'aiobs_u_oldtoken' }, { consecutive_failures: 5, next_attempt_at: new Date(Date.now() + 3600_000).toISOString() });
    store.enqueue(events(1), key());
    expect((await flushQueue(store, { paths })).status).toBe('ok');
  });

  it('never sends with a never-fetched collector-config (C4)', async () => {
    const { srv, store, paths, key } = await setup((req) => (req.url === '/api/v1/collector-config' ? { status: 503 } : okResponder()(req)));
    dropCache(paths, 'acme');
    store.enqueue(events(1), key());
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'failed', tokens: { acme: { status: 'failed', left: 1 } } });
    expect(r.error).toMatch(/^collector-config unavailable/);
    expect(ingests(srv)).toHaveLength(0);
  });

  it('pre-upgrade root segments are never sent, even with one token (held pre-upgrade)', async () => {
    const { srv, store, paths } = await setup(okResponder());
    new EventQueue(paths.queue).enqueue(events(2));
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'held', held: { events: 2, byReason: { 'pre-upgrade': 2 } } });
    expect(ingests(srv)).toHaveLength(0);
    expect(new EventQueue(paths.queue).stats().events).toBe(2);
  });

  it('reports held projects with their reason and leaves them queued (open stream, one token)', async () => {
    const { srv, store, paths } = await setup(okResponder());
    enqueueFor(store, PK, OPEN, events(3));
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'held', held: { events: 3, projects: [PK], byReason: { unassigned: 3 } } });
    expect(ingests(srv)).toHaveLength(0);
    expect(store.stats().events).toBe(3);
  });
});

describe('flushQueue (several tokens)', () => {
  async function twoServers(a: Parameters<typeof tokenResponder>[0], b: Parameters<typeof tokenResponder>[0]) {
    const A = await startServer(tokenResponder(a));
    const B = await startServer(tokenResponder(b));
    closers.push(A.close, B.close);
    return { A, B };
  }

  it('sends each stream only to its own token and endpoint; held streams are not sent or acked', async () => {
    const { A, B } = await twoServers({ aiobs_u_a: { company: ACME } }, { aiobs_c_b: { company: { name: 'Globex', slug: 'globex' } } });
    const paths = tmpHome();
    writeTestTokens(paths, [
      { name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME },
      { name: 'globex', endpoint: B.url, token: 'aiobs_c_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme', A.url, 'acme', 'aiobs_u_a'), events(2));
    enqueueFor(store, 'github.com/globex/web', bound('globex', B.url, 'globex', 'aiobs_c_b'), events(3, 10));
    enqueueFor(store, 'github.com/x/held', OPEN, events(4, 20));
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'ok', sent: 5, tokens: { acme: { sent: 2 }, globex: { sent: 3 } }, held: { events: 4, projects: ['github.com/x/held'] } });
    expect(ingests(A).every((x) => bearerOf(x) === 'aiobs_u_a')).toBe(true);
    expect(ingests(B).every((x) => bearerOf(x) === 'aiobs_c_b')).toBe(true);
    expect(sentEvents(A)).toHaveLength(2);
    expect(sentEvents(B)).toHaveLength(3);
    expect(store.stats().events).toBe(4);
  });

  it('names and hashes per receiving token: A hashed with its salt, B plain', async () => {
    const SA = 'salt-of-acme-0123456789';
    const { A, B } = await twoServers({ aiobs_u_a: { company: ACME, naming: 'hashed', salt: SA } }, { aiobs_c_b: { company: { name: 'Globex', slug: 'globex' } } });
    const paths = tmpHome();
    writeTestTokens(paths, [
      { name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME, cache: { naming: 'hashed', salt: SA } },
      { name: 'globex', endpoint: B.url, token: 'aiobs_c_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme', A.url, 'acme', 'aiobs_u_a'), sessionEvents('sa'));
    enqueueFor(store, PK, bound('globex', B.url, 'globex', 'aiobs_c_b'), sessionEvents('sb'));
    expect((await flushQueue(store, { paths })).status).toBe('ok');

    const [aStart, aTurn] = sentEvents(A) as unknown as Array<Record<string, unknown>>;
    expect(aStart!.project).toEqual({ key: `sha256:${hmac(SA, PK)}` });
    expect(Object.keys(aTurn!.skills as object)).toEqual([hashUsageName('skill:ship-check', SA)]);
    expect(Object.keys(aTurn!.mcp as object)).toEqual([hashUsageName('mcp:github', SA)]);
    expect(JSON.stringify(sentEvents(A))).not.toMatch(/billing|ship-check|github/);

    const [bStart, bTurn] = sentEvents(B) as unknown as Array<Record<string, unknown>>;
    expect(bStart!.project).toEqual({ key: PK, name: 'billing' });
    expect(bTurn!.skills).toEqual({ 'ship-check': { model: 1, user: 0 } });
  });

  it('re-assignment keeps captures with their token (C12); --move-queued moves them', async () => {
    const { A, B } = await twoServers({ aiobs_u_a: { status: 401 } }, { aiobs_c_b: { company: { name: 'Globex', slug: 'globex' } } });
    const paths = tmpHome();
    const config = writeTestTokens(paths, [
      { name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME },
      { name: 'globex', endpoint: B.url, token: 'aiobs_c_b' },
    ]);
    const [acme, globex] = config.tokens as [TokenEntry, TokenEntry];
    const assign = (t: TokenEntry) => ({ token: t.name, ...identityOf(t), assigned_at: new Date().toISOString() });
    writeProjects(paths, { [PK]: assign(acme) });
    const store = queueStore(paths);
    const aBind = bound('acme', A.url, 'acme', 'aiobs_u_a');
    enqueueFor(store, PK, aBind, events(2)); // captured while assigned to acme
    const r1 = await flushQueue(store, { paths });
    expect(r1.tokens.acme!.status).toBe('auth_error');

    writeProjects(paths, { [PK]: assign(globex) }); // `use globex`
    enqueueFor(store, PK, OPEN, events(1, 10)); // open data of the key
    enqueueFor(store, PK, bound('globex', B.url, 'globex', 'aiobs_c_b'), events(1, 20)); // a new session
    const r2 = await flushQueue(store, { paths });
    expect(r2.tokens.globex).toMatchObject({ status: 'ok', sent: 2 });
    expect(r2.tokens.acme!.status).toBe('blocked');
    expect(sentEvents(B).map((e) => (e as { turn_id: string }).turn_id).sort()).toEqual(['t10', 't20']);
    expect(store.stats().events).toBe(2);

    expect(store.rebind(PK, bound('globex', B.url, 'globex', 'aiobs_c_b'))).toBe(2); // --move-queued
    const r3 = await flushQueue(store, { paths });
    expect(r3.tokens.globex).toMatchObject({ status: 'ok', sent: 2 });
    expect(store.stats().events).toBe(0);
    expect(ingests(A)).toHaveLength(1); // only the first, refused attempt: acme stays blocked
  });

  it('1 → 2 tokens: data captured with one token stays with it (C12 / C18)', async () => {
    const { A, B } = await twoServers({ aiobs_u_a: { company: ACME } }, { aiobs_c_b: { company: { name: 'Globex', slug: 'globex' } } });
    const paths = tmpHome();
    writeTestTokens(paths, [{ name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME }]);
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme', A.url, 'acme', 'aiobs_u_a'), events(2));
    writeTestTokens(paths, [
      { name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME },
      { name: 'globex', endpoint: B.url, token: 'aiobs_c_b' },
    ]);
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'ok', sent: 2, held: { events: 0 } });
    expect(sentEvents(A)).toHaveLength(2);
    expect(ingests(B)).toHaveLength(0);
  });

  it('2 → 1 tokens (C18): data captured with two tokens stays held until `use`; new sessions bind to the remaining token', async () => {
    const A = await startServer(tokenResponder({ aiobs_u_a: { company: ACME } }));
    closers.push(A.close);
    const paths = tmpHome();
    const t0 = Date.now() - 60_000;
    writeTestTokens(
      paths,
      [
        { name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME },
        { name: 'globex', endpoint: 'http://127.0.0.1:9', token: 'aiobs_c_b' },
      ],
      { epochs: [{ since: new Date(t0).toISOString(), single: null }] },
    );
    const store = queueStore(paths);
    enqueueFor(store, PK, OPEN, events(1)); // an open session captured with two tokens
    const repo = gitRepo({ remote: 'git@github.com:acme/unres.git' });
    store.enqueue(events(1, 10), { kind: 'unresolved', cwd: repo, bind: OPEN }); // git timed out at capture
    const job = (session: string, cwd: string, receivedAt: number) => ({ harness: 'claude-code' as const, hook: 'Stop', payload: { session_id: session }, cwd, env: {}, received_at: new Date(receivedAt).toISOString() });
    writeJob(paths.jobs, job('pending', '/work/job', t0 + 1000), t0 + 1000); // still in jobs/ at the removal

    const config = loadConfig(paths)!;
    saveConfig(paths, removeToken(config, 'globex')); // `ai-obs token remove globex`

    const adapter = fakeAdapter();
    const holders = new Map<string, { pkCwd: string; stream?: StreamKey }>();
    adapter.handleHook = async (event, ctx) => {
      const sid = (event.payload as { session_id: string }).session_id;
      const holder = holders.get(sid) ?? { pkCwd: event.cwd };
      holders.set(sid, holder);
      ctx.queue.enqueue(events(1, sid === 'pending' ? 20 : 30), await ctx.streamFor(holder, Date.parse(event.receivedAt)));
    };
    const keys: Record<string, string> = { '/work/job': 'github.com/acme/job', '/work/new': 'github.com/acme/new', [repo]: 'github.com/acme/unres' };
    const keyOf = async (cwd: string) => keys[cwd] ?? null;
    const w1 = await runWorker({ paths, adapters: [adapter], resolveProject: keyOf });
    expect(w1.flush).toMatchObject({ status: 'held', held: { events: 3, byReason: { unassigned: 3 } } });
    expect(ingests(A)).toHaveLength(0);

    writeJob(paths.jobs, job('new', '/work/new', Date.now()), Date.now()); // a session after the removal
    const w2 = await runWorker({ paths, adapters: [adapter], resolveProject: keyOf });
    expect(w2.flush).toMatchObject({ status: 'ok', sent: 1, held: { events: 3 } });

    const acme = loadConfig(paths)!.tokens[0]!;
    const a = { token: 'acme', ...identityOf(acme), assigned_at: new Date().toISOString() };
    writeProjects(paths, { [PK]: a, 'github.com/acme/unres': a, 'github.com/acme/job': a }); // `use acme` in each repo
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'ok', sent: 3, held: { events: 0 } });
    expect(sentEvents(A)).toHaveLength(4);
  });

  it('a damaged config (malformed entry) captures new sessions open; a rewrite keeps them held (C22)', async () => {
    const { createContext } = await import('../src/context.js');
    const { fakeAdapter } = await import('./helpers.js');
    const { nullLogger } = await import('../src/log.js');
    const A = await startServer(tokenResponder({ aiobs_u_a: { company: ACME } }));
    closers.push(A.close);
    const paths = tmpHome();
    const config = writeTestTokens(paths, [{ name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME }], { invalid: [{ name: 'Bad Name', token: 'x' }] });
    const store = queueStore(paths);
    const ctx = createContext({ adapter: fakeAdapter(), config, paths, queue: store, log: nullLogger, resolveProject: async () => PK });
    const holder = { pkCwd: '/work/billing' } as { pkCwd: string; stream?: StreamKey };
    const key = await ctx.streamFor(holder, Date.now());
    expect(key).toMatchObject({ kind: 'project', pk: PK, bind: OPEN });
    store.enqueue(events(1), key);
    const again = loadConfig(paths)!; // e.g. `token confirm acme` rewrites the file
    saveConfig(paths, again);
    expect(loadConfig(paths)!.invalidTokens).toHaveLength(1);
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'held', held: { byReason: { unassigned: 1 } } });
    expect(ingests(A)).toHaveLength(0);
  });

  it('re-reads routing before every POST: `use --none` mid-flush stops the stream (C17)', async () => {
    const paths = tmpHome();
    let posts = 0;
    const A = await startServer((req) => {
      if (req.url === '/api/v1/ingest' && ++posts === 1) writeProjects(paths, { [PK]: { token: null, none: true, assigned_at: new Date().toISOString() } });
      return tokenResponder({ aiobs_u_a: { company: ACME } })(req);
    });
    closers.push(A.close);
    writeTestTokens(paths, [{ name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME }]);
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme', A.url, 'acme', 'aiobs_u_a'), events(3));
    const r = await flushQueue(store, { paths }, { limits: { maxEvents: 1 } });
    expect(posts).toBe(1);
    expect(r).toMatchObject({ sent: 1, held: { events: 2, byReason: { 'opted-out': 2 } } });
    expect(store.stats().events).toBe(2);
  });

  it('unverified tokens (C9): nothing is sent while the cache reports another slug; sent once slug = name', async () => {
    const A = await startServer(tokenResponder({ aiobs_u_a: { company: ACME }, aiobs_c_lab: { company: { name: 'Lab', slug: 'lab' } } }));
    closers.push(A.close);
    const paths = tmpHome();
    writeTestTokens(paths, [
      { name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME },
      { name: 'lab', endpoint: A.url, token: 'aiobs_c_lab', company: null, cache: { company: { name: 'Other', slug: 'other' } } },
    ]);
    const store = queueStore(paths);
    const labBind = bound('lab', A.url, null, 'aiobs_c_lab'); // bound by fingerprint
    enqueueFor(store, PK, labBind, events(1));
    const r1 = await flushQueue(store, { paths });
    expect(r1).toMatchObject({ status: 'held', held: { byReason: { unverified: 1 } } });
    expect(ingests(A)).toHaveLength(0);

    const lab = loadConfig(paths)!.tokens[1]!;
    writeCache(paths, lab, { fetched_at: new Date().toISOString(), value: { project_naming: 'plain', min_collector_version: '0', company: { name: 'Lab', slug: 'lab' } } });
    const r2 = await flushQueue(store, { paths });
    expect(r2).toMatchObject({ status: 'ok', tokens: { lab: { sent: 1 } } });
    expect(bearerOf(ingests(A)[0]!)).toBe('aiobs_c_lab');
  });

  it('single token registered offline (`default`, provisional) is confirmed by the first fetch, renamed and sends', async () => {
    const A = await startServer(tokenResponder({ aiobs_u_a: { company: ACME, user: { email: 'dev@acme.com' } } }));
    closers.push(A.close);
    const paths = tmpHome();
    writeTestTokens(paths, [{ name: 'default', endpoint: A.url, token: 'aiobs_u_a', company: null, provisional_name: true, cache: false }]);
    writeTokenDelivery(paths, loadConfig(paths)!.tokens[0]!, { consecutive_failures: 0 });
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('default', A.url, null, 'aiobs_u_a'), events(2));
    const r = await flushQueue(store, { paths });
    expect(r.confirmed).toEqual({ from: 'default', to: 'acme', company: ACME });
    expect(r).toMatchObject({ status: 'ok', sent: 2, tokens: { acme: { status: 'ok' } } });
    const entry = loadConfig(paths)!.tokens[0]!;
    expect(entry).toMatchObject({ name: 'acme', company: ACME, email: 'dev@acme.com' });
    expect(entry.provisional_name).toBeUndefined();
    expect(existsSync(collectorConfigPath(paths, 'acme'))).toBe(true);
    expect(existsSync(collectorConfigPath(paths, 'default'))).toBe(false);
    expect(Object.keys(readDelivery(paths).tokens)).toEqual(['acme']);
  });

  it('adopts an unresolved stream once its key resolves, then sends it (C16)', async () => {
    const A = await startServer(tokenResponder({ aiobs_u_a: { company: ACME } }));
    closers.push(A.close);
    const paths = tmpHome();
    writeTestTokens(paths, [{ name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME }]);
    const repo = gitRepo({ remote: 'git@github.com:acme/billing.git' });
    const store = queueStore(paths);
    const bind = bound('acme', A.url, 'acme', 'aiobs_u_a');
    store.enqueue(sessionEvents(), { kind: 'unresolved', cwd: repo, bind });
    expect(readdirSync(paths.queueUnresolved)).toEqual([unresolvedDirName(repo, bind)]);
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'ok', sent: 2 });
    expect((sentEvents(A)[0] as { project?: unknown }).project).toEqual({ key: PK, name: 'billing' });
    expect(existsSync(join(paths.queueUnresolved, unresolvedDirName(repo, bind)))).toBe(false);
  });

  it('an unresolved stream whose key still times out stays held (unresolved)', async () => {
    const A = await startServer(tokenResponder({ aiobs_u_a: { company: ACME } }));
    closers.push(A.close);
    const paths = tmpHome();
    writeTestTokens(paths, [{ name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME }]);
    const store = queueStore(paths);
    store.enqueue(events(1), { kind: 'unresolved', cwd: '/work/slow', bind: bound('acme', A.url, 'acme', 'aiobs_u_a') });
    const r = await flushQueue(store, { paths, resolveProjectKey: async () => null });
    expect(r).toMatchObject({ status: 'held', held: { byReason: { unresolved: 1 } } });
    expect(ingests(A)).toHaveLength(0);
  });

  it('401 on A blocks only A; B delivers in the same flush; automatic flushes skip A; forced retry clears it', async () => {
    let aStatus = 401;
    const A = await startServer((req) => (req.url === '/api/v1/ingest' ? { status: aStatus, body: { error: 'invalid or revoked ingest token' } } : tokenResponder({ aiobs_u_a: { company: ACME } })(req)));
    const B = await startServer(tokenResponder({ aiobs_c_b: { company: { name: 'Globex', slug: 'globex' } } }));
    closers.push(A.close, B.close);
    const paths = tmpHome();
    writeTestTokens(paths, [
      { name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME },
      { name: 'globex', endpoint: B.url, token: 'aiobs_c_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme', A.url, 'acme', 'aiobs_u_a'), events(2));
    enqueueFor(store, 'github.com/globex/web', bound('globex', B.url, 'globex', 'aiobs_c_b'), events(1, 10));
    const r1 = await flushQueue(store, { paths });
    expect(r1).toMatchObject({ status: 'ok', sent: 1, tokens: { acme: { status: 'auth_error', left: 2 }, globex: { status: 'ok' } } });
    expect(readDelivery(paths).tokens.acme!.blocked).toMatchObject({ status: 401 });

    const before = A.received.length;
    const r2 = await flushQueue(store, { paths });
    expect(r2.tokens.acme!.status).toBe('blocked');
    expect(A.received.length).toBe(before); // no request

    aStatus = 200;
    const r3 = await flushQueue(store, { paths }, { force: true });
    expect(r3.tokens.acme).toMatchObject({ status: 'ok', sent: 2 });
    expect(readDelivery(paths).tokens.acme!.blocked).toBeNull();
  });

  it('403 → suspended with the server message; other tokens unaffected', async () => {
    const A = await startServer(tokenResponder({ aiobs_u_a: { status: 403 } }));
    closers.push(A.close);
    const paths = tmpHome();
    writeTestTokens(paths, [{ name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME }]);
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme', A.url, 'acme', 'aiobs_u_a'), events(1));
    const r = await flushQueue(store, { paths }, { force: true });
    expect(r.status).toBe('auth_error');
    expect(r.tokens.acme).toMatchObject({ status: 'suspended', error: 'HTTP 403: company is suspended' });
    expect(readDelivery(paths).tokens.acme!.blocked).toMatchObject({ status: 403, message: 'company is suspended' });
    expect(store.stats().events).toBe(1);
  });

  it('429 on A (Retry-After: 7) backs off only A', async () => {
    const A = await startServer((req) => (req.url === '/api/v1/ingest' ? { status: 429, headers: { 'retry-after': '7' } } : tokenResponder({ aiobs_u_a: { company: ACME } })(req)));
    const B = await startServer(tokenResponder({ aiobs_c_b: { company: { name: 'Globex', slug: 'globex' } } }));
    closers.push(A.close, B.close);
    const paths = tmpHome();
    writeTestTokens(paths, [
      { name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME },
      { name: 'globex', endpoint: B.url, token: 'aiobs_c_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme', A.url, 'acme', 'aiobs_u_a'), events(1));
    enqueueFor(store, 'github.com/globex/web', bound('globex', B.url, 'globex', 'aiobs_c_b'), events(1, 10));
    const r = await flushQueue(store, { paths });
    expect(r.tokens).toMatchObject({ acme: { status: 'failed' }, globex: { status: 'ok' } });
    const d = readDelivery(paths).tokens;
    const wait = Date.parse(d.acme!.next_attempt_at!) - Date.now();
    expect(wait).toBeGreaterThan(5000);
    expect(wait).toBeLessThanOrEqual(7000);
    expect(d.globex!.next_attempt_at).toBeNull();
  });

  it('dead-letters a refused batch of one stream and goes on with the next stream', async () => {
    const A = await startServer((req) => {
      const evs = (req.json as { events?: Array<{ turn_id?: string }> } | null)?.events ?? [];
      if (req.url === '/api/v1/ingest' && evs.some((e) => e.turn_id === 't0')) return { status: 400, body: { error: 'bad' } };
      return tokenResponder({ aiobs_u_a: { company: ACME } })(req);
    });
    closers.push(A.close);
    const paths = tmpHome();
    writeTestTokens(paths, [{ name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME }]);
    const store = queueStore(paths);
    const bind = bound('acme', A.url, 'acme', 'aiobs_u_a');
    enqueueFor(store, PK, bind, events(1));
    enqueueFor(store, 'github.com/acme/web', bind, events(2, 10));
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'ok', sent: 2, batches: 2 });
    expect(store.stats().events).toBe(0);
    expect(readdirSync(paths.deadLetter).filter((f) => f.endsWith('.ndjson'))).toHaveLength(1);
  });

  it('maxBatches applies per token (C14)', async () => {
    const { A, B } = await twoServers({ aiobs_u_a: { company: ACME } }, { aiobs_c_b: { company: { name: 'Globex', slug: 'globex' } } });
    const paths = tmpHome();
    writeTestTokens(paths, [
      { name: 'acme', endpoint: A.url, token: 'aiobs_u_a', company: ACME },
      { name: 'globex', endpoint: B.url, token: 'aiobs_c_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme', A.url, 'acme', 'aiobs_u_a'), events(5));
    enqueueFor(store, 'github.com/globex/web', bound('globex', B.url, 'globex', 'aiobs_c_b'), events(2, 10));
    const r = await flushQueue(store, { paths }, { maxBatches: 2, limits: { maxEvents: 1 } });
    expect(r.tokens).toMatchObject({ acme: { sent: 2, left: 3 }, globex: { sent: 2, left: 0 } });
  });

  it('a token replaced by another one of the same name never receives the old binding (identity, C8)', async () => {
    const { A, B } = await twoServers({ aiobs_u_a: { company: ACME } }, { aiobs_u_other: { company: ACME } });
    const paths = tmpHome();
    writeTestTokens(paths, [{ name: 'acme', endpoint: B.url, token: 'aiobs_u_other', company: ACME }]); // other endpoint now
    const store = queueStore(paths);
    enqueueFor(store, PK, bound('acme', A.url, 'acme', 'aiobs_u_a'), events(1));
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'held', held: { byReason: { dangling: 1 } } });
    expect(ingests(A)).toHaveLength(0);
    expect(ingests(B)).toHaveLength(0);
  });
});

describe('prepareForSend', () => {
  it('rewrites session_start.project from the plain stream key; path keys always hashed with the path secret', () => {
    const evs = sessionEvents();
    const plain = prepareForSend(evs, { kind: 'project', pk: PK, bind: OPEN }, { naming: 'plain', pathSecret: 'p'.repeat(64) });
    expect((plain[0] as { project?: unknown }).project).toEqual({ key: PK, name: 'billing' });
    const path = prepareForSend(evs, { kind: 'project', pk: '/Users/dev/notes', bind: OPEN }, { naming: 'plain', pathSecret: 'p'.repeat(64) });
    expect((path[0] as { project?: unknown }).project).toEqual({ key: `sha256:${hmac('p'.repeat(64), 'path:/Users/dev/notes')}` });
    const hashed = prepareForSend(evs, { kind: 'project', pk: PK, bind: OPEN }, { naming: 'hashed', salt: null, pathSecret: null });
    expect((hashed[0] as { project?: { key: string; name?: string } }).project!.name).toBeUndefined();
    // idempotent on already hashed names
    expect(prepareForSend(hashed, { kind: 'project', pk: PK, bind: OPEN }, { naming: 'hashed', salt: null, pathSecret: null })).toEqual(hashed);
  });
});

describe('getCollectorConfig (per token)', () => {
  it('fetches, caches with a TTL in state/collector-config/<name>.json, and falls back to the cache when offline', async () => {
    const { srv, paths, token } = await setup(okResponder('plain'));
    const a = await getCollectorConfig({ token, paths }, { force: true });
    expect(a).toMatchObject({ source: 'fresh', value: { project_naming: 'plain', company: ACME, user: { email: 'dev@acme.com' } } });
    expect(JSON.parse(readFileSync(join(paths.collectorConfigDir, 'acme.json'), 'utf8'))).toMatchObject({ token_fp: tokenFingerprint(token.token), endpoint: srv.url });
    const b = await getCollectorConfig({ token, paths });
    expect(b.source).toBe('cache');
    expect(srv.received).toHaveLength(1);
    const offline = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const c = await getCollectorConfig({ token, paths, transport: offline }, { force: true });
    expect(c).toMatchObject({ source: 'cache', value: { project_naming: 'plain' } });
  });

  it("A's cache does not satisfy B; replacing A's token invalidates its cache", async () => {
    const { paths, token } = await setup(okResponder('plain'));
    expect(readCache(paths, token)).not.toBeNull();
    const other: TokenEntry = { ...token, name: 'globex', token: 'aiobs_c_b' };
    expect(readCache(paths, other)).toBeNull();
    const replaced: TokenEntry = { ...token, token: 'aiobs_u_rotated' };
    expect(readCache(paths, replaced)).toBeNull();
    const r = await getCollectorConfig({ token: replaced, paths, transport: async () => ({ status: 503, headers: {}, body: '' }) });
    expect(r.source).toBe('default');
  });

  it('keeps the company project_salt (and ignores an implausible one); tolerates a body without company / user', async () => {
    const salted = await setup(() => ({ status: 200, body: { project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: 's'.repeat(32) } }));
    const a = await getCollectorConfig({ token: salted.token, paths: salted.paths }, { force: true });
    expect(a.value).toEqual({ project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: 's'.repeat(32) });
    expect((await getCollectorConfig({ token: salted.token, paths: salted.paths })).value.project_salt).toBe('s'.repeat(32)); // from cache
    const short = await setup(() => ({ status: 200, body: { project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: 'abc' } }));
    expect((await getCollectorConfig({ token: short.token, paths: short.paths }, { force: true })).value).toEqual({ project_naming: 'hashed', min_collector_version: '0.0.1' });
  });

  it('defaults to hashed project naming when the server was never reached', async () => {
    const paths = tmpHome();
    const config = writeTestConfig(paths);
    dropCache(paths, 'acme');
    const r = await getCollectorConfig({ token: config.tokens[0]!, paths });
    expect(r).toMatchObject({ source: 'default', value: { project_naming: 'hashed' } });
    expect(r.error).toBeTruthy();
  });

  it('reports a 401 status and body', async () => {
    const { paths, token } = await setup(() => ({ status: 401, body: { error: 'invalid or revoked ingest token' } }));
    const r = await getCollectorConfig({ token, paths }, { force: true });
    expect(r).toMatchObject({ source: 'cache', status: 401 });
  });
});

describe('probeCollectorConfig (init / token add)', () => {
  function transportOf(responses: Array<{ status: number; retryAfter?: string }>) {
    let i = 0;
    const calls: number[] = [];
    const transport = async () => {
      const r = responses[Math.min(i++, responses.length - 1)]!;
      calls.push(r.status);
      return r.status === 200
        ? { status: 200, headers: {}, body: JSON.stringify({ project_naming: 'plain', min_collector_version: '0', company: ACME, user: null }) }
        : { status: r.status, headers: r.retryAfter ? { 'retry-after': r.retryAfter } : {}, body: JSON.stringify({ error: 'rate limit exceeded' }) };
    };
    return { transport, calls };
  }
  const base = { endpoint: 'http://obs.example', token: 'aiobs_u_x' };

  it('429 + Retry-After: 2, then 200: waits 2 s and succeeds', async () => {
    const { transport } = transportOf([{ status: 429, retryAfter: '2' }, { status: 200 }]);
    const slept: number[] = [];
    const r = await probeCollectorConfig({ ...base, transport, sleep: async (ms) => void slept.push(ms) });
    expect(r).toMatchObject({ status: 200, attempts: 2, exhausted: false, value: { company: ACME } });
    expect(slept).toEqual([2000]);
  });

  it('429 three times: exhausted after 3 attempts; a missing header waits the 5 s default', async () => {
    const { transport, calls } = transportOf([{ status: 429 }]);
    const slept: number[] = [];
    const r = await probeCollectorConfig({ ...base, transport, sleep: async (ms) => void slept.push(ms) });
    expect(r).toMatchObject({ status: 429, attempts: 3, exhausted: true, serverError: 'rate limit exceeded' });
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([5000, 5000]);
  });

  it('429 with Retry-After: 120 is exhausted after 1 attempt without sleeping', async () => {
    const { transport } = transportOf([{ status: 429, retryAfter: '120' }]);
    let slept = false;
    const r = await probeCollectorConfig({ ...base, transport, sleep: async () => void (slept = true) });
    expect(r).toMatchObject({ attempts: 1, exhausted: true, retryAfterMs: 120_000 });
    expect(slept).toBe(false);
  });
});

describe('queue layout', () => {
  it('streams live under queue/p/<o|t>-<id>/ with a stream.json', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    const store = queueStore(paths);
    const bind = bound('acme', 'http://127.0.0.1:9', 'acme', 'aiobs_u_testtoken');
    enqueueFor(store, PK, bind, events(1));
    const dir = join(paths.queueProjects, streamDirName(PK, bind));
    expect(JSON.parse(readFileSync(join(dir, 'stream.json'), 'utf8'))).toMatchObject({ pk: PK, bind });
  });
});
