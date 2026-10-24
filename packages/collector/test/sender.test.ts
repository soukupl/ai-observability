import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashUsageName } from '../src/analysis/usage.js';
import { dropCache, readCache } from '../src/cc-cache.js';
import { loadConfig, tokenFingerprint, type ServerEntry } from '../src/config.js';
import { readDelivery, writeServerDelivery } from '../src/delivery.js';
import { sessionStartEvent, turnSummaryEvent } from '../src/events.js';
import { writeJsonAtomic } from '../src/fsutil.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { EventQueue } from '../src/queue.js';
import { unresolvedDirName, type StreamKey } from '../src/routing.js';
import { flushQueue, getCollectorConfig, prepareForSend, probeCollectorConfig, rejectedMessage } from '../src/sender.js';
import { readWarnings } from '../src/warnings.js';
import {
  bearerOf,
  ccValue,
  cleanupHomes,
  gitRepo,
  okResponder,
  startServer,
  tmpHome,
  tokenResponder,
  writeTestConfig,
  writeTestServers,
  type Received,
} from './helpers.js';
import { enqueueFor, queueStore } from './queue-helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  cleanupHomes();
});

const PK = 'github.com/acme/billing';
const DAY = 86_400_000;
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
const host = (url: string) => new URL(url).host;

/** One server (writeTestConfig) at a test server, and a store. */
async function setup(respond: Parameters<typeof startServer>[0], spec: Parameters<typeof writeTestConfig>[2] = {}) {
  const srv = await startServer(respond);
  closers.push(srv.close);
  const paths = tmpHome();
  const config = writeTestConfig(paths, srv.url, spec);
  const store = queueStore(paths);
  const key = (pk = PK, team = ''): StreamKey => ({ kind: 'project', pk, endpoint: srv.url, team });
  const server = config.servers[0] as ServerEntry;
  return { srv, paths, config, store, key, server };
}

describe('flushQueue (one server)', () => {
  it('POSTs gzip JSON batches with the Bearer token and acks them; no git e-mail is sent', async () => {
    const { srv, paths, config, store, key } = await setup(okResponder());
    store.enqueue(events(750), key());
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'ok', batches: 2, sent: 750, accepted: 750, servers: { [srv.url]: { status: 'ok', sent: 750, left: 0 } } });
    expect(srv.received).toHaveLength(2);
    const req = srv.received[0]!;
    expect(req.url).toBe('/api/v1/ingest');
    expect(req.headers.authorization).toBe('Bearer aiobs_u_testtoken');
    expect(req.headers['content-encoding']).toBe('gzip');
    const body = req.json as { schema: number; machine: { id: string }; identity: Record<string, unknown>; events: unknown[] };
    expect(body.schema).toBe(1);
    expect(body.machine.id).toBe(config.machine_id);
    expect(body.identity).toEqual({});
    expect(body.events).toHaveLength(500);
    expect(store.stats().events).toBe(0);
    const st = readDelivery(paths).servers[host(srv.url)]!;
    expect(st.last_success_at).toBeTruthy();
    expect(Object.keys(st.repos)).toEqual([PK]); // `token list` REPOSITORIES
    expect(readdirSync(paths.queueProjects)).toEqual([]); // empty stream dirs pruned
  });

  it('session_start.project carries the stream’s dot-file team; no team key without one', async () => {
    const { srv, paths, store, key } = await setup(okResponder());
    store.enqueue(sessionEvents('a'), key(PK, 'platform'));
    store.enqueue(sessionEvents('b'), key(PK, ''));
    expect((await flushQueue(store, { paths })).status).toBe('ok');
    const starts = sentEvents(srv).filter((e) => e.type === 'session_start') as Array<{ session_id: string; project: unknown }>;
    expect(starts.find((e) => e.session_id === 'a')!.project).toEqual({ key: PK, name: 'billing', team: 'platform' });
    expect(starts.find((e) => e.session_id === 'b')!.project).toEqual({ key: PK, name: 'billing' });
  });

  it('counts duplicates and rejected events as delivered', async () => {
    const { store, paths, key } = await setup(() => ({ status: 200, body: { accepted: 1, duplicates: 2, rejected: [{ event_id: 'x', reason: 'bad' }] } }));
    store.enqueue(events(4), key());
    expect(await flushQueue(store, { paths })).toMatchObject({ status: 'ok', accepted: 1, duplicates: 2, rejected: 1 });
    expect(store.stats().events).toBe(0);
  });

  it('keeps events queued on 5xx and backs off; force ignores the backoff', async () => {
    let fail = true;
    const { srv, store, paths, key } = await setup((req) => (fail ? { status: 503 } : okResponder()(req)));
    store.enqueue(events(3), key());
    const r1 = await flushQueue(store, { paths });
    expect(r1).toMatchObject({ status: 'failed', error: 'HTTP 503' });
    expect(store.stats().events).toBe(3);
    const st = readDelivery(paths).servers[host(srv.url)]!;
    expect(st.consecutive_failures).toBe(1);
    expect(Date.parse(st.next_attempt_at!)).toBeGreaterThan(Date.now());
    expect((await flushQueue(store, { paths })).status).toBe('backoff');
    expect(srv.received).toHaveLength(1);
    fail = false;
    expect(await flushQueue(store, { paths }, { force: true })).toMatchObject({ status: 'ok', sent: 3 });
    expect(readDelivery(paths).servers[host(srv.url)]!.consecutive_failures).toBe(0);
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

  it('401: auth_error with the login message, the server is blocked and its queue kept', async () => {
    const { srv, store, paths, key } = await setup((req) => (req.url === '/api/v1/ingest' ? { status: 401, body: { error: 'expired or revoked' } } : okResponder()(req)));
    store.enqueue(events(1), key());
    const r = await flushQueue(store, { paths });
    expect(r.status).toBe('auth_error');
    expect(r.servers[srv.url]).toMatchObject({ status: 'auth_error', left: 1, error: `HTTP 401: ${rejectedMessage(srv.url)}` });
    expect(rejectedMessage(srv.url)).toBe(`token expired or revoked: run ai-obs login --server ${srv.url}`);
    expect(readDelivery(paths).servers[host(srv.url)]!.blocked).toMatchObject({ status: 401, message: rejectedMessage(srv.url) });
    expect(store.stats().events).toBe(1);
    // a new login (another token) starts fresh: the block is gone
    const cfg = loadConfig(paths)!;
    writeServerDelivery(paths, { ...cfg.servers[0]!, token: 'aiobs_u_new' }, {});
    expect(readDelivery(paths).servers[host(srv.url)]!.blocked).toBeNull();
  });

  it('an expired token sends nothing, not even on a forced flush (local pre-check)', async () => {
    const { srv, store, paths, key } = await setup(okResponder(), { expiresAt: new Date(Date.now() - 1000).toISOString() });
    store.enqueue(events(2), key());
    const r = await flushQueue(store, { paths }, { force: true });
    expect(r).toMatchObject({ status: 'backoff', servers: { [srv.url]: { status: 'expired', left: 2, error: `token expired: run ai-obs login --server ${srv.url}` } } });
    expect(srv.received).toHaveLength(0);
  });

  it('learns the token expiry, deployment and e-mail from a fresh collector-config (config.json updated)', async () => {
    const exp = new Date(Date.now() + 80 * DAY).toISOString();
    const { paths, store, key, server } = await setup(okResponder('plain', { expiresAt: exp, email: 'alice@spectado.io' }));
    dropCache(paths, server.endpoint);
    store.enqueue(events(1), key());
    expect((await flushQueue(store, { paths })).status).toBe('ok');
    expect(loadConfig(paths)!.servers[0]).toMatchObject({ expires_at: exp, email: 'alice@spectado.io', deployment: { slug: 'spectado' }, source: 'device' });
  });

  it('records ingest warnings per project (latest wins) and clears them when a session starts without one', async () => {
    let warn = true;
    const { paths, store, key, srv } = await setup(
      okResponder('plain', { warnings: (evs) => (warn ? evs.filter((e) => e.type === 'session_start').map((e) => ({ code: 'team_not_member' as const, team: 'mobile', session_id: e.session_id! })) : []) }),
    );
    store.enqueue(sessionEvents('s1'), key(PK, 'mobile'));
    await flushQueue(store, { paths });
    expect(readWarnings(paths)[PK]).toMatchObject({ code: 'team_not_member', team: 'mobile', endpoint: srv.url, session_id: 's1' });
    warn = false;
    store.enqueue(events(1, 50), key(PK, 'mobile')); // no session_start: the warning stays
    await flushQueue(store, { paths });
    expect(readWarnings(paths)[PK]).toBeTruthy();
    store.enqueue(sessionEvents('s2'), key(PK, 'platform'));
    await flushQueue(store, { paths });
    expect(readWarnings(paths)[PK]).toBeUndefined();
  });

  it('a replayed session_start (server duplicates, so no team resolution and no warning) keeps the warning', async () => {
    let n = 0;
    const { paths, store, key } = await setup((req) => {
      if (req.url !== '/api/v1/ingest') return okResponder()(req);
      const evs = (req.json as { events: Array<{ type: string; session_id?: string }> }).events;
      return n++ === 0
        ? { status: 200, body: { accepted: evs.length, duplicates: 0, rejected: [], warnings: [{ code: 'team_not_member', team: 'mobile', session_id: 's1' }] } }
        : { status: 200, body: { accepted: 0, duplicates: evs.length, rejected: [], warnings: [] } };
    });
    store.enqueue(sessionEvents('s1'), key(PK, 'mobile'));
    await flushQueue(store, { paths });
    expect(readWarnings(paths)[PK]).toMatchObject({ team: 'mobile' });
    store.enqueue(sessionEvents('s1'), key(PK, 'mobile')); // the same batch again, after a lost response
    await flushQueue(store, { paths });
    expect(readWarnings(paths)[PK]).toMatchObject({ team: 'mobile' });
  });

  it('ignores malformed warnings', async () => {
    const { paths, store, key } = await setup(() => ({ status: 200, body: { accepted: 2, duplicates: 0, rejected: [], warnings: [{ code: 'nope', team: 'x', session_id: 's' }, { code: 'team_unknown', team: 'BAD SLUG', session_id: 's' }] } }));
    store.enqueue(sessionEvents(), key());
    await flushQueue(store, { paths });
    expect(readWarnings(paths)).toEqual({});
  });

  it('honours Retry-After on 429', async () => {
    const { srv, store, paths, key } = await setup((req) => (req.url === '/api/v1/ingest' ? { status: 429, headers: { 'retry-after': '600' } } : okResponder()(req)));
    store.enqueue(events(1), key());
    await flushQueue(store, { paths });
    expect(Date.parse(readDelivery(paths).servers[host(srv.url)]!.next_attempt_at!) - Date.now()).toBeGreaterThan(590_000);
  });

  it('halves the batch on 413 and dead-letters on 400 (into the shared queue/dead)', async () => {
    const { srv, store, paths, key } = await setup((req) => {
      const n = (req.json as { events: unknown[] }).events.length;
      if (n > 2) return { status: 413 };
      return n === 1 ? { status: 400, body: { error: 'bad envelope' } } : okResponder()(req);
    });
    store.enqueue(events(5), key());
    expect((await flushQueue(store, { paths })).sent).toBe(4);
    expect(store.stats().events).toBe(0);
    expect(srv.received.length).toBeGreaterThan(3);
    expect(readdirSync(paths.deadLetter).filter((f) => f.endsWith('.ndjson'))).toHaveLength(1);
  });

  it('times out a hanging server and keeps events', async () => {
    const { store, paths, key } = await setup((req) => (req.url === '/api/v1/ingest' ? { status: 200, delayMs: 5000 } : okResponder()(req)));
    store.enqueue(events(1), key());
    const r = await flushQueue(store, { paths, transport: async (req) => (await import('../src/http.js')).nodeTransport({ ...req, timeoutMs: 200 }) });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/timeout/);
    expect(store.stats().events).toBe(1);
  });

  it('network failure keeps events', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, 'http://127.0.0.1:9');
    const store = queueStore(paths);
    enqueueFor(store, PK, 'http://127.0.0.1:9', events(1));
    const r = await flushQueue(store, { paths });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^network:/);
    expect(store.stats().events).toBe(1);
  });

  it('a 0.4 delivery file (per token name) reads as empty and is replaced', async () => {
    const { srv, store, paths, key } = await setup(okResponder());
    writeJsonAtomic(paths.delivery, { v: 2, tokens: { acme: { token_fp: 'x', consecutive_failures: 3, next_attempt_at: new Date(Date.now() + 3600_000).toISOString() } } });
    store.enqueue(events(1), key());
    expect((await flushQueue(store, { paths })).status).toBe('ok');
    expect(readDelivery(paths)).toMatchObject({ v: 3, servers: { [host(srv.url)]: { consecutive_failures: 0 } } });
  });

  it('never sends with a never-fetched collector-config (C4)', async () => {
    const { srv, store, paths, key, server } = await setup((req) => (req.url === '/api/v1/collector-config' ? { status: 503 } : okResponder()(req)));
    dropCache(paths, server.endpoint);
    store.enqueue(events(1), key());
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({ status: 'failed', servers: { [srv.url]: { status: 'failed', left: 1 } } });
    expect(r.error).toMatch(/^collector-config unavailable/);
    expect(ingests(srv)).toHaveLength(0);
  });

  it('pre-upgrade root segments are never sent (held pre-upgrade)', async () => {
    const { srv, store, paths } = await setup(okResponder());
    new EventQueue(paths.queue).enqueue(events(2));
    expect(await flushQueue(store, { paths })).toMatchObject({ status: 'held', held: { events: 2, byReason: { 'pre-upgrade': 2 } } });
    expect(ingests(srv)).toHaveLength(0);
  });

  it('a stream without a chosen server goes to the only server', async () => {
    const { srv, store, paths } = await setup(okResponder());
    enqueueFor(store, PK, '', events(3));
    expect(await flushQueue(store, { paths })).toMatchObject({ status: 'ok', sent: 3 });
    expect(sentEvents(srv)).toHaveLength(3);
  });
});

describe('flushQueue (several servers)', () => {
  async function twoServers(a: Parameters<typeof tokenResponder>[0], b: Parameters<typeof tokenResponder>[0]) {
    const A = await startServer(tokenResponder(a));
    const B = await startServer(tokenResponder(b));
    closers.push(A.close, B.close);
    const paths = tmpHome();
    return { A, B, paths };
  }

  it('sends each stream only to its own server with that server’s token; held streams are not sent or acked', async () => {
    const { A, B, paths } = await twoServers({ aiobs_u_a: {} }, { aiobs_u_b: {} });
    writeTestServers(paths, [
      { endpoint: A.url, token: 'aiobs_u_a' },
      { endpoint: B.url, token: 'aiobs_u_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, A.url, events(2));
    enqueueFor(store, 'github.com/globex/web', B.url, events(3, 10), 'platform');
    enqueueFor(store, 'github.com/x/none', '', events(4, 20)); // no server chosen
    enqueueFor(store, 'github.com/x/other', 'https://obs.other.io', events(1, 30)); // not logged in there
    const r = await flushQueue(store, { paths });
    expect(r).toMatchObject({
      status: 'ok',
      sent: 5,
      servers: { [A.url]: { sent: 2 }, [B.url]: { sent: 3 } },
      held: { events: 5, byReason: { 'no-server': 5 } },
    });
    expect(r.held.projects.sort()).toEqual(['github.com/x/none', 'github.com/x/other']);
    expect(ingests(A).every((x) => bearerOf(x) === 'aiobs_u_a')).toBe(true);
    expect(ingests(B).every((x) => bearerOf(x) === 'aiobs_u_b')).toBe(true);
    expect(store.stats().events).toBe(5);
  });

  it('names and hashes per receiving server: A hashed with its salt, B plain', async () => {
    const SA = 'salt-of-a-0123456789';
    const { A, B, paths } = await twoServers({ aiobs_u_a: { naming: 'hashed', salt: SA } }, { aiobs_u_b: {} });
    writeTestServers(paths, [
      { endpoint: A.url, token: 'aiobs_u_a', cache: { naming: 'hashed', salt: SA } },
      { endpoint: B.url, token: 'aiobs_u_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, A.url, sessionEvents('sa'), 'platform');
    enqueueFor(store, PK, B.url, sessionEvents('sb'));
    expect((await flushQueue(store, { paths })).status).toBe('ok');
    const [aStart, aTurn] = sentEvents(A) as unknown as Array<Record<string, unknown>>;
    expect(aStart!.project).toEqual({ key: `sha256:${hmac(SA, PK)}`, team: 'platform' });
    expect(Object.keys(aTurn!.skills as object)).toEqual([hashUsageName('skill:ship-check', SA)]);
    expect(Object.keys(aTurn!.mcp as object)).toEqual([hashUsageName('mcp:github', SA)]);
    expect(JSON.stringify(sentEvents(A))).not.toMatch(/billing|ship-check|github/);
    const [bStart, bTurn] = sentEvents(B) as unknown as Array<Record<string, unknown>>;
    expect(bStart!.project).toEqual({ key: PK, name: 'billing' });
    expect(bTurn!.skills).toEqual({ 'ship-check': { model: 1, user: 0 } });
  });

  it('401 on A blocks only A; B delivers in the same flush; automatic flushes skip A; forced retry clears it', async () => {
    let aStatus = 401;
    const A = await startServer((req) => (req.url === '/api/v1/ingest' ? { status: aStatus, body: { error: 'expired or revoked' } } : tokenResponder({ aiobs_u_a: {} })(req)));
    const B = await startServer(tokenResponder({ aiobs_u_b: {} }));
    closers.push(A.close, B.close);
    const paths = tmpHome();
    writeTestServers(paths, [
      { endpoint: A.url, token: 'aiobs_u_a' },
      { endpoint: B.url, token: 'aiobs_u_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, A.url, events(2));
    enqueueFor(store, 'github.com/globex/web', B.url, events(1, 10));
    const r1 = await flushQueue(store, { paths });
    expect(r1).toMatchObject({ status: 'ok', sent: 1, servers: { [A.url]: { status: 'auth_error', left: 2 }, [B.url]: { status: 'ok' } } });
    expect(readDelivery(paths).servers[host(A.url)]!.blocked).toMatchObject({ status: 401 });
    const before = A.received.length;
    expect((await flushQueue(store, { paths })).servers[A.url]!.status).toBe('blocked');
    expect(A.received.length).toBe(before); // no request
    aStatus = 200;
    expect((await flushQueue(store, { paths }, { force: true })).servers[A.url]).toMatchObject({ status: 'ok', sent: 2 });
    expect(readDelivery(paths).servers[host(A.url)]!.blocked).toBeNull();
  });

  it('a new login for A (same endpoint, new token) sends A’s queued data with the new token', async () => {
    const { A, paths } = await twoServers({ aiobs_u_new: {} }, {});
    writeTestServers(paths, [{ endpoint: A.url, token: 'aiobs_u_old' }]);
    const store = queueStore(paths);
    enqueueFor(store, PK, A.url, events(2));
    writeTestServers(paths, [{ endpoint: A.url, token: 'aiobs_u_new' }]);
    expect(await flushQueue(store, { paths })).toMatchObject({ status: 'ok', sent: 2 });
    expect(ingests(A).every((x) => bearerOf(x) === 'aiobs_u_new')).toBe(true);
  });

  it('429 on A (Retry-After: 7) backs off only A', async () => {
    const A = await startServer((req) => (req.url === '/api/v1/ingest' ? { status: 429, headers: { 'retry-after': '7' } } : tokenResponder({ aiobs_u_a: {} })(req)));
    const B = await startServer(tokenResponder({ aiobs_u_b: {} }));
    closers.push(A.close, B.close);
    const paths = tmpHome();
    writeTestServers(paths, [
      { endpoint: A.url, token: 'aiobs_u_a' },
      { endpoint: B.url, token: 'aiobs_u_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, A.url, events(1));
    enqueueFor(store, 'github.com/globex/web', B.url, events(1, 10));
    const r = await flushQueue(store, { paths });
    expect(r.servers).toMatchObject({ [A.url]: { status: 'failed' }, [B.url]: { status: 'ok' } });
    const d = readDelivery(paths).servers;
    const wait = Date.parse(d[host(A.url)]!.next_attempt_at!) - Date.now();
    expect(wait).toBeGreaterThan(5000);
    expect(wait).toBeLessThanOrEqual(7000);
    expect(d[host(B.url)]!.next_attempt_at).toBeNull();
  });

  it('maxBatches applies per server (C14)', async () => {
    const { A, B, paths } = await twoServers({ aiobs_u_a: {} }, { aiobs_u_b: {} });
    writeTestServers(paths, [
      { endpoint: A.url, token: 'aiobs_u_a' },
      { endpoint: B.url, token: 'aiobs_u_b' },
    ]);
    const store = queueStore(paths);
    enqueueFor(store, PK, A.url, events(5));
    enqueueFor(store, 'github.com/globex/web', B.url, events(2, 10));
    const r = await flushQueue(store, { paths }, { maxBatches: 2, limits: { maxEvents: 1 } });
    expect(r.servers).toMatchObject({ [A.url]: { sent: 2, left: 3 }, [B.url]: { sent: 2, left: 0 } });
  });

  it('adopts an unresolved stream once its key resolves, then sends it with its team (C16)', async () => {
    const { A, paths } = await twoServers({ aiobs_u_a: {} }, {});
    writeTestServers(paths, [{ endpoint: A.url, token: 'aiobs_u_a' }]);
    const repo = gitRepo({ remote: 'git@github.com:acme/billing.git' });
    const store = queueStore(paths);
    store.enqueue(sessionEvents(), { kind: 'unresolved', cwd: repo, endpoint: A.url, team: 'platform' });
    expect(readdirSync(paths.queueUnresolved)).toEqual([unresolvedDirName(repo, A.url, 'platform')]);
    expect(await flushQueue(store, { paths })).toMatchObject({ status: 'ok', sent: 2 });
    expect((sentEvents(A)[0] as { project?: unknown }).project).toEqual({ key: PK, name: 'billing', team: 'platform' });
    expect(existsSync(join(paths.queueUnresolved, unresolvedDirName(repo, A.url, 'platform')))).toBe(false);
  });

  it('an unresolved stream whose key still times out stays held (unresolved)', async () => {
    const { A, paths } = await twoServers({ aiobs_u_a: {} }, {});
    writeTestServers(paths, [{ endpoint: A.url, token: 'aiobs_u_a' }]);
    const store = queueStore(paths);
    store.enqueue(events(1), { kind: 'unresolved', cwd: '/work/slow', endpoint: A.url, team: '' });
    expect(await flushQueue(store, { paths, resolveProjectKey: async () => null })).toMatchObject({ status: 'held', held: { byReason: { unresolved: 1 } } });
    expect(ingests(A)).toHaveLength(0);
  });
});

describe('prepareForSend', () => {
  it('rewrites session_start.project from the plain stream key; path keys always hashed with the path secret', () => {
    const evs = sessionEvents();
    const id = (pk: string, team = '') => ({ kind: 'project' as const, pk, endpoint: 'https://x.io', team });
    expect((prepareForSend(evs, id(PK), { naming: 'plain', pathSecret: 'p'.repeat(64) })[0] as { project?: unknown }).project).toEqual({ key: PK, name: 'billing' });
    const path = prepareForSend(evs, id('/Users/dev/notes', 'platform'), { naming: 'plain', pathSecret: 'p'.repeat(64) });
    expect((path[0] as { project?: unknown }).project).toEqual({ key: `sha256:${hmac('p'.repeat(64), 'path:/Users/dev/notes')}`, team: 'platform' });
    const hashed = prepareForSend(evs, id(PK), { naming: 'hashed', salt: null, pathSecret: null });
    expect((hashed[0] as { project?: { key: string; name?: string } }).project!.name).toBeUndefined();
    expect(prepareForSend(hashed, id(PK), { naming: 'hashed', salt: null, pathSecret: null })).toEqual(hashed);
  });
});

describe('getCollectorConfig (per server)', () => {
  it('fetches, caches with a TTL in state/collector-config/<host>.json, and falls back to the cache when offline', async () => {
    const { srv, paths, server } = await setup(okResponder('plain'));
    const a = await getCollectorConfig({ server, paths }, { force: true });
    expect(a).toMatchObject({ source: 'fresh', value: { project_naming: 'plain', deployment: { slug: 'spectado' }, user: { email: 'dev@acme.com', kind: 'person' }, teams: [{ slug: 'platform' }, { slug: 'spectado' }] } });
    const file = join(paths.collectorConfigDir, `${host(srv.url).replace(':', '_')}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ token_fp: tokenFingerprint(server.token), endpoint: srv.url });
    expect((await getCollectorConfig({ server, paths })).source).toBe('cache');
    expect(srv.received).toHaveLength(1);
    const offline = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    expect(await getCollectorConfig({ server, paths, transport: offline }, { force: true })).toMatchObject({ source: 'cache', value: { project_naming: 'plain' } });
  });

  it('a replaced token invalidates the cache', async () => {
    const { paths, server } = await setup(okResponder('plain'));
    expect(readCache(paths, server)).not.toBeNull();
    const replaced = { ...server, token: 'aiobs_u_rotated' };
    expect(readCache(paths, replaced)).toBeNull();
    expect((await getCollectorConfig({ server: replaced, paths, transport: async () => ({ status: 503, headers: {}, body: '' }) })).source).toBe('default');
  });

  it('keeps a plausible salt; tolerates an older body; drops malformed fields', async () => {
    const salted = await setup(() => ({ status: 200, body: { project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: 's'.repeat(32) } }));
    expect((await getCollectorConfig({ server: salted.server, paths: salted.paths }, { force: true })).value).toEqual({ project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: 's'.repeat(32) });
    const odd = await setup(() => ({ status: 200, body: { ...ccValue(), project_salt: 'abc', teams: [{ slug: 'BAD', name: 'x' }, { slug: 'ok', name: 'Ok' }], token: { expires_at: 'never', source: 'device' } } }));
    const v = (await getCollectorConfig({ server: odd.server, paths: odd.paths }, { force: true })).value;
    expect(v.project_salt).toBeUndefined();
    expect(v.teams).toEqual([{ slug: 'ok', name: 'Ok' }]);
    expect(v.token).toBeUndefined();
  });

  it('defaults to hashed project naming when the server was never reached', async () => {
    const paths = tmpHome();
    const config = writeTestConfig(paths, 'http://127.0.0.1:9', { cache: false });
    const r = await getCollectorConfig({ server: config.servers[0]!, paths });
    expect(r).toMatchObject({ source: 'default', value: { project_naming: 'hashed' } });
    expect(r.error).toBeTruthy();
  });

  it('reports a 401 status and body', async () => {
    const { paths, server } = await setup(() => ({ status: 401, body: { error: 'expired or revoked' } }));
    expect(await getCollectorConfig({ server, paths }, { force: true })).toMatchObject({ source: 'cache', status: 401 });
  });
});

describe('probeCollectorConfig (login)', () => {
  function transportOf(responses: Array<{ status: number; retryAfter?: string }>) {
    let i = 0;
    const calls: number[] = [];
    const transport = async () => {
      const r = responses[Math.min(i++, responses.length - 1)]!;
      calls.push(r.status);
      return r.status === 200
        ? { status: 200, headers: {}, body: JSON.stringify(ccValue()) }
        : { status: r.status, headers: r.retryAfter ? { 'retry-after': r.retryAfter } : {}, body: JSON.stringify({ error: 'rate limit exceeded' }) };
    };
    return { transport, calls };
  }
  const base = { endpoint: 'http://obs.example', token: 'aiobs_u_x' };

  it('429 + Retry-After: 2, then 200: waits 2 s and succeeds', async () => {
    const { transport } = transportOf([{ status: 429, retryAfter: '2' }, { status: 200 }]);
    const slept: number[] = [];
    const r = await probeCollectorConfig({ ...base, transport, sleep: async (ms) => void slept.push(ms) });
    expect(r).toMatchObject({ status: 200, attempts: 2, exhausted: false, value: { deployment: { slug: 'spectado' } } });
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

describe('delivery state', () => {
  it('is keyed by host and keeps the repositories seen across a new login', () => {
    const paths = tmpHome();
    const config = writeTestConfig(paths);
    const s = config.servers[0]!;
    writeServerDelivery(paths, s, { repos: { [PK]: '2026-10-01T00:00:00.000Z' }, consecutive_failures: 2 });
    expect(Object.keys(readDelivery(paths).servers)).toEqual(['127.0.0.1:9']);
    const fresh = writeServerDelivery(paths, { ...s, token: 'aiobs_u_rotated' }, {});
    expect(fresh).toMatchObject({ consecutive_failures: 0, repos: { [PK]: '2026-10-01T00:00:00.000Z' } });
  });
});
