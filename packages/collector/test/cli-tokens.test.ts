import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../src/cli.js';
import { loadConfig, tokenFingerprint } from '../src/config.js';
import { readDelivery, recordDropped, writeTokenDelivery } from '../src/delivery.js';
import { sessionEndEvent } from '../src/events.js';
import { writeJsonAtomic } from '../src/fsutil.js';
import type { Transport } from '../src/http.js';
import type { AiObsPaths } from '../src/paths.js';
import { rememberPk } from '../src/pk-cache.js';
import { loadProjects } from '../src/projects.js';
import { LEGACY_TEAM_TOKEN_PREFIX as OLD } from '../src/protocol-types.js';
import { EventQueue } from '../src/queue.js';
import { buildEnvelope } from '../src/sender.js';
import { cleanupHomes, fakeAdapter, gitRepo, tmpHome, tokenResponder, writeProjects, writeTestTokens, type TokenResponse } from './helpers.js';
import { bound, enqueueFor, OPEN, queueStore } from './queue-helpers.js';

afterEach(() => cleanupHomes());

const A = 'https://a.example';
const B = 'https://b.example';
const KEY = 'github.com/acme/billing';
const ACME = { name: 'Acme Corp', slug: 'acme' };
const GLOBEX = { name: 'Globex', slug: 'globex' };

type Spec = TokenResponse & { network?: boolean };

/** In-memory servers per endpoint, answering per bearer token (tokenResponder); unknown endpoints refuse to connect. */
function fakeNet(servers: Record<string, Record<string, Spec>>) {
  const calls: Array<{ endpoint: string; path: string; bearer: string | null; events: number }> = [];
  const transport: Transport = async (req) => {
    const u = new URL(req.url);
    const endpoint = `${u.protocol}//${u.host}`;
    const auth = req.headers?.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const map = servers[endpoint];
    if (!map || (bearer && map[bearer]?.network)) throw new Error('connect ECONNREFUSED');
    const json = req.body ? (JSON.parse(gunzipSync(req.body).toString('utf8')) as { events?: unknown[] }) : null;
    calls.push({ endpoint, path: u.pathname, bearer, events: json?.events?.length ?? 0 });
    const r = tokenResponder(map)({ method: req.method, url: u.pathname, headers: { authorization: auth }, json });
    return { status: r.status, headers: r.headers ?? {}, body: r.body === undefined ? '' : JSON.stringify(r.body) };
  };
  const ingests = () => calls.filter((c) => c.path === '/api/v1/ingest');
  return { transport, calls, ingests };
}

function setup(net: ReturnType<typeof fakeNet> = fakeNet({})) {
  const paths = tmpHome();
  const runtimes: string[] = [];
  const spawned: string[] = [];
  const sleeps: number[] = [];
  const adapter = fakeAdapter();
  const deps: Partial<CliDeps> & { paths: AiObsPaths } = {
    paths,
    env: {},
    cwd: '/work/repo',
    transport: net.transport,
    adapters: [adapter],
    installRuntime: (p) => {
      runtimes.push(p.root);
      return { entry: `${p.app}/bin/ai-obs.js`, node: '/usr/bin/node', copied: false };
    },
    spawnWorker: (p) => spawned.push(p.root),
    resolveProjectKey: async () => KEY,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    lockWaitMs: 50,
  };
  const run = async (argv: string[], extra: Partial<CliDeps> = {}) => {
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
    const code = await main(argv, io, { ...deps, ...extra });
    return { code, text: lines.join('\n') };
  };
  return { paths, deps, run, runtimes, spawned, sleeps, adapter, net };
}

const ev = (sid = 's') => [sessionEndEvent({ harness: 'codex', sessionId: sid, reason: 'exit', at: 0 })];
const read = (f: string) => readFileSync(f, 'utf8');
const twoTokens = (paths: AiObsPaths) =>
  writeTestTokens(paths, [
    { name: 'acme', endpoint: A, token: 'aiobs_u_acme-token', company: ACME, email: 'dev@acme.com' },
    { name: 'globex', endpoint: B, token: 'aiobs_c_globex-token', company: GLOBEX },
  ]);
const acmeBind = () => bound('acme', A, 'acme', 'aiobs_u_acme-token');
const globexBind = () => bound('globex', B, 'globex', 'aiobs_c_globex-token');

describe('init / token add', () => {
  it('init names the token after company.slug, --name overrides, re-init keeps the machine and the count', async () => {
    const t = setup(fakeNet({ [A]: { aiobs_u_one: { company: ACME, user: { email: 'dev@acme.com' } } } }));
    const r = await t.run(['init', '--token', 'aiobs_u_one', '--endpoint', A, '--git-email', 'dev@acme.com']);
    expect(r.code).toBe(0);
    expect(r.text).toContain('✓ token acme registered: Acme Corp (user token, dev@acme.com)');
    const c1 = loadConfig(t.paths)!;
    expect(c1.tokens).toEqual([expect.objectContaining({ name: 'acme', company: ACME, email: 'dev@acme.com', endpoint: A })]);
    expect(c1.routingEpochs).toHaveLength(1);
    expect((await t.run(['init', '--token', 'aiobs_u_one', '--endpoint', A])).code).toBe(0);
    const c2 = loadConfig(t.paths)!;
    expect(c2.machine_id).toBe(c1.machine_id);
    expect(c2.tokens).toHaveLength(1);

    const named = setup(fakeNet({ [A]: { aiobs_u_one: { company: ACME } } }));
    expect((await named.run(['init', '--token', 'aiobs_u_one', '--endpoint', A, '--name', 'work'])).code).toBe(0);
    expect(loadConfig(named.paths)!.tokens[0]!.name).toBe('work');
    expect((await named.run(['init', '--token', 'aiobs_u_one', '--endpoint', A, '--name', 'Bad_Name'])).code).toBe(2);
  });

  it('migrates a 0.1.x config: banner before, legacy record, old cache deleted, pre-upgrade queue moved aside and never sent', async () => {
    const t = setup(fakeNet({ [A]: { aiobs_u_new: { company: ACME } } }));
    mkdirSync(t.paths.state, { recursive: true });
    writeJsonAtomic(t.paths.config, { endpoint: A, token: `${OLD}legacytoken1234`, machine_id: 'machine-1', created_at: '2026-01-01T00:00:00.000Z' });
    writeJsonAtomic(t.paths.collectorConfigCache, { fetched_at: '2026-01-01T00:00:00.000Z', value: { project_naming: 'hashed', min_collector_version: '0.0.1' } });
    new EventQueue(t.paths.queue).enqueue(ev('old'));

    for (const cmd of ['status', 'flush', 'doctor']) {
      const r = await t.run([cmd]);
      expect(r.code, cmd).toBe(1);
      expect(r.text, cmd).toContain(`no longer accepts the token from before the upgrade (${OLD}…1234)`);
    }
    expect((await t.run(['doctor'])).text).toContain(`the token from before the upgrade, ${OLD}…1234, was revoked`);
    const noToken = await t.run(['init']);
    expect(noToken.code).toBe(2);
    expect(noToken.text).toContain('no longer accepts the token');

    const r = await t.run(['init', '--token', 'aiobs_u_new']); // endpoint from the old config
    expect(r.code).toBe(0);
    expect(r.text).not.toContain('no longer accepts');
    expect(r.text).toContain('1 pre-upgrade batches (1 events, recorded by ai-obs 0.1) moved to');
    const raw = JSON.parse(read(t.paths.config)) as { legacy: Record<string, unknown>; machine_id: string };
    expect(raw.machine_id).toBe('machine-1');
    expect(raw.legacy).toEqual({ endpoint: A, token_mask: `${OLD}…1234`, found_at: expect.any(String) });
    expect(existsSync(t.paths.collectorConfigCache)).toBe(false);
    expect(new EventQueue(t.paths.queue, { autoCap: false }).segments()).toHaveLength(0);
    expect(readdirSync(t.paths.deadPreUpgrade).filter((f) => f.endsWith('.ndjson'))).toHaveLength(1);

    const s1 = await t.run(['status']);
    expect(s1.text).toContain('1 pre-upgrade batches kept in');
    expect(s1.text).toContain('not sent: tokens were reset');
    expect((await t.run(['status'])).text).not.toContain('pre-upgrade batches'); // once
    expect((await t.run(['flush'])).text).toContain('queue is empty');
    expect(t.net.ingests()).toHaveLength(0);
  });

  it('a pre-upgrade root segment is held, never sent, even with one token', async () => {
    const t = setup(fakeNet({ [A]: { 'aiobs_u_test-acme': { company: { name: 'Acme', slug: 'acme' } } } }));
    writeTestTokens(t.paths, [{ name: 'acme', endpoint: A }]);
    new EventQueue(t.paths.queue).enqueue(ev('old'));
    const f = await t.run(['flush']);
    expect(f.code).toBe(0);
    expect(f.text).toContain('kept: 1 events (queued before the upgrade, never sent: tokens were reset)');
    expect(t.net.ingests()).toHaveLength(0);
  });

  it('token add refreshes the runtime without touching hooks; 1 → 2 tokens lists recent repositories and --all-held', async () => {
    const t = setup(fakeNet({ [A]: { aiobs_u_one: { company: ACME } }, [B]: { aiobs_c_two: { company: GLOBEX, user: null } } }));
    expect((await t.run(['init', '--token', 'aiobs_u_one', '--endpoint', A])).code).toBe(0);
    expect(t.adapter.installs).toHaveLength(1);
    rememberPk(t.paths, '/work/web', 'github.com/acme/web');
    const r = await t.run(['token', 'add', '--token', 'aiobs_c_two', '--endpoint', B]);
    expect(r.code).toBe(0);
    expect(r.text).toContain('✓ token globex registered: Globex (company token)');
    expect(r.text).toContain('2 tokens are registered (acme, globex)');
    expect(r.text).toContain('Events already queued stay with acme');
    expect(r.text).toContain('github.com/acme/web');
    expect(r.text).toContain('--all-held');
    expect(t.adapter.installs).toHaveLength(1); // no hook changes
    expect(t.runtimes).toHaveLength(2); // init + token add (C25)
    expect(loadConfig(t.paths)!.tokens.map((x) => x.name)).toEqual(['acme', 'globex']);
    expect(loadConfig(t.paths)!.routingEpochs.at(-1)!.single).toBeNull();
  });

  it('token add without a config says hooks are not installed; the endpoint is required', async () => {
    const t = setup(fakeNet({ [A]: { aiobs_u_one: { company: ACME } } }));
    expect((await t.run(['token', 'add', '--token', 'aiobs_u_one'])).code).toBe(2);
    const r = await t.run(['token', 'add', '--token', 'aiobs_u_one', '--endpoint', A]);
    expect(r.code).toBe(0);
    expect(r.text).toContain('hooks are not installed yet: run `ai-obs init`');
  });

  it('same slug from another endpoint asks for --name; --name registers both', async () => {
    const t = setup(fakeNet({ [A]: { aiobs_u_one: { company: ACME } }, [B]: { aiobs_u_two: { company: ACME } } }));
    await t.run(['init', '--token', 'aiobs_u_one', '--endpoint', A]);
    const before = read(t.paths.config);
    const r = await t.run(['token', 'add', '--token', 'aiobs_u_two', '--endpoint', B]);
    expect(r.code).toBe(1);
    expect(r.text).toContain('company slug acme is already registered as acme');
    expect(read(t.paths.config)).toBe(before);
    expect((await t.run(['token', 'add', '--token', 'aiobs_u_two', '--endpoint', B, '--name', 'acme-eu'])).code).toBe(0);
    expect(loadConfig(t.paths)!.tokens.map((x) => x.name)).toEqual(['acme', 'acme-eu']);
  });

  it('offline: --name over a verified entry is refused; a second token without --name is refused', async () => {
    const t = setup(fakeNet({ [A]: { aiobs_u_one: { company: ACME }, aiobs_u_off: { network: true } } }));
    await t.run(['init', '--token', 'aiobs_u_one', '--endpoint', A]);
    const before = read(t.paths.config);
    const over = await t.run(['token', 'add', '--token', 'aiobs_u_off', '--endpoint', A, '--name', 'acme']);
    expect(over.code).toBe(1);
    expect(over.text).toContain('token acme belongs to company acme');
    const unnamed = await t.run(['token', 'add', '--token', 'aiobs_u_off', '--endpoint', 'https://down.example']);
    expect(unnamed.code).toBe(1);
    expect(unnamed.text).toContain('Pass --name <name> to register the token anyway');
    expect(read(t.paths.config)).toBe(before);
    const named = await t.run(['token', 'add', '--token', 'aiobs_u_off', '--endpoint', 'https://down.example', '--name', 'lab']);
    expect(named.code).toBe(0);
    expect(named.text).toContain('It sends nothing until its company is confirmed: run `ai-obs token confirm lab`');
    expect(loadConfig(t.paths)!.tokens.find((x) => x.name === 'lab')!.company).toBeUndefined();
  });

  it('a user token replaced by a company token of the same company says how attribution changes', async () => {
    const t = setup(fakeNet({ [A]: { aiobs_u_one: { company: ACME }, aiobs_c_one: { company: ACME, user: null } } }));
    await t.run(['init', '--token', 'aiobs_u_one', '--endpoint', A]);
    const r = await t.run(['token', 'add', '--token', 'aiobs_c_one', '--endpoint', A]);
    expect(r.code).toBe(0);
    expect(r.text).toContain('✓ token acme replaced');
    expect(r.text).toContain('replaced a user token with a company token: activity is now matched by git e-mail instead of verified');
    const [entry] = loadConfig(t.paths)!.tokens;
    expect(entry).toMatchObject({ name: 'acme', token: 'aiobs_c_one', prior_fps: [tokenFingerprint('aiobs_u_one')] });
  });

  it('the same token at a new endpoint warns about the events and repositories left with the old endpoint', async () => {
    const t = setup(fakeNet({ [A]: { aiobs_u_one: { company: ACME } }, [B]: { aiobs_u_one: { company: ACME } } }));
    await t.run(['init', '--token', 'aiobs_u_one', '--endpoint', A]);
    expect((await t.run(['use', 'acme'])).code).toBe(0);
    enqueueFor(queueStore(t.paths), KEY, bound('acme', A, 'acme', 'aiobs_u_one'), [...ev('a'), ...ev('b')]);
    const r = await t.run(['token', 'add', '--token', 'aiobs_u_one', '--endpoint', B]);
    expect(r.code).toBe(0);
    expect(r.text).toContain('✓ token acme replaced');
    expect(r.text).toContain(`! token acme now reports to ${B} instead of ${A}: 2 queued events recorded for ${A} stay on this machine and 1 repositories assigned to it ask for a token again`);
    expect(r.text).toContain('`ai-obs use acme --move-queued`');
  });

  it('each token keeps the git e-mail of the directory it was registered in (identity sent with that token only)', async () => {
    const t = setup(fakeNet({ [A]: { aiobs_c_acme: { company: ACME, user: null } }, [B]: { aiobs_c_globex: { company: GLOBEX, user: null } } }));
    await t.run(['init', '--token', 'aiobs_c_acme', '--endpoint', A, '--git-email', 'alice@acme.com']);
    await t.run(['init', '--token', 'aiobs_c_globex', '--endpoint', B, '--git-email', 'alice@globex.com']);
    const config = loadConfig(t.paths)!;
    expect(config.tokens.map((x) => [x.name, x.git_email])).toEqual([
      ['acme', 'alice@acme.com'],
      ['globex', 'alice@globex.com'],
    ]);
    expect(config.git_email).toBe('alice@acme.com'); // the machine fallback is not overwritten
    expect(buildEnvelope(config, [], config.tokens[0]).identity).toEqual({ git_email: 'alice@acme.com' });
    expect(buildEnvelope(config, [], config.tokens[1]).identity).toEqual({ git_email: 'alice@globex.com' });
    // re-registering acme without an e-mail keeps its own
    await t.run(['token', 'add', '--token', 'aiobs_c_acme', '--endpoint', A]);
    expect(loadConfig(t.paths)!.tokens[0]!.git_email).toBe('alice@acme.com');
  });

  it('401 / 403 / exhausted 429 change nothing; a 401 with the endpoint from config.json hints at --endpoint', async () => {
    const t = setup(
      fakeNet({
        [A]: {
          aiobs_u_one: { company: ACME },
          aiobs_u_gone: { status: 403 },
          aiobs_u_busy: { status: 429, retryAfter: 120 },
        },
      }),
    );
    await t.run(['init', '--token', 'aiobs_u_one', '--endpoint', A]);
    const before = read(t.paths.config);
    const r401 = await t.run(['token', 'add', '--token', 'aiobs_u_bad']);
    expect(r401.code).toBe(1);
    expect(r401.text).toContain(`✗ ${A} rejected token aiobs_u_… (HTTP 401: invalid or revoked ingest token). Nothing was changed.`);
    expect(r401.text).toContain('was taken from your last registration; pass --endpoint');
    const flag401 = await t.run(['token', 'add', '--token', 'aiobs_u_bad', '--endpoint', A]);
    expect(flag401.text).not.toContain('was taken from');
    const env401 = await t.run(['token', 'add', '--token', 'aiobs_u_bad'], { env: { AI_OBS_ENDPOINT: A } });
    expect(env401.text).toContain('was taken from AI_OBS_ENDPOINT');
    const r403 = await t.run(['token', 'add', '--token', 'aiobs_u_gone', '--endpoint', A]);
    expect(r403.code).toBe(1);
    expect(r403.text).toContain('company is suspended (HTTP 403). Nothing was changed.');
    const r429 = await t.run(['token', 'add', '--token', 'aiobs_u_busy', '--endpoint', A]);
    expect(r429.code).toBe(1);
    expect(r429.text).toContain('is rate limiting this machine (HTTP 429, 1 attempts, server asks to wait 120 s)');
    expect(t.sleeps).toEqual([]); // the wait would pass the 60 s budget
    expect(read(t.paths.config)).toBe(before);
  });

  it('429 then 200 retries after Retry-After (injected sleep)', async () => {
    let n = 0;
    const base = fakeNet({ [A]: { aiobs_u_one: { company: ACME } } });
    const transport: Transport = async (req) => (n++ === 0 ? { status: 429, headers: { 'retry-after': '2' }, body: '{"error":"rate limit exceeded"}' } : base.transport(req));
    const t = setup({ ...base, transport });
    const r = await t.run(['init', '--token', 'aiobs_u_one', '--endpoint', A]);
    expect(r.code).toBe(0);
    expect(t.sleeps).toEqual([2000]);
  });

  it('a busy worker lock refuses token add / token remove / use --move-queued and changes nothing', async () => {
    const t = setup(fakeNet({ [A]: { 'aiobs_u_acme-token': { company: ACME } }, [B]: { 'aiobs_c_globex-token': { company: GLOBEX } } }));
    twoTokens(t.paths);
    enqueueFor(queueStore(t.paths), KEY, globexBind(), ev());
    mkdirSync(t.paths.root, { recursive: true });
    writeFileSync(t.paths.workerLock, `${process.pid} ${new Date().toISOString()}`);
    const config = read(t.paths.config);
    const queue = JSON.stringify(queueStore(t.paths).stats());
    for (const argv of [
      ['token', 'add', '--token', 'aiobs_u_acme-token', '--endpoint', A],
      ['token', 'remove', 'globex'],
      ['use', 'acme', '--move-queued'],
    ]) {
      const r = await t.run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.text).toContain('the background worker is busy');
    }
    expect(read(t.paths.config)).toBe(config);
    expect(JSON.stringify(queueStore(t.paths).stats())).toBe(queue);
    expect(existsSync(t.paths.projects)).toBe(false);
  });
});

describe('token list / confirm / remove', () => {
  it('token list shows masked tokens, kind, account, projects, queued events and state', async () => {
    const t = setup();
    twoTokens(t.paths);
    writeProjects(t.paths, { [KEY]: { token: 'acme', endpoint: A, company_slug: 'acme', token_fp: tokenFingerprint('aiobs_u_acme-token'), assigned_at: '2026-10-08T00:00:00.000Z' } });
    enqueueFor(queueStore(t.paths), KEY, acmeBind(), ev('a'));
    enqueueFor(queueStore(t.paths), 'github.com/globex/x', globexBind(), [...ev('b'), ...ev('c')]);
    const g = loadConfig(t.paths)!.tokens[1]!;
    writeTokenDelivery(t.paths, g, { blocked: { status: 401, at: new Date().toISOString(), message: 'invalid or revoked ingest token' } });
    const r = await t.run(['token', 'list']);
    expect(r.code).toBe(0);
    const [header, acme, globex] = r.text.split('\n');
    expect(header).toMatch(/^NAME\s+COMPANY\s+KIND\s+ACCOUNT\s+ENDPOINT\s+TOKEN\s+ADDED\s+PROJECTS\s+QUEUED\s+STATE$/);
    expect(acme).toMatch(/^acme\s+Acme Corp\s+user\s+dev@acme\.com\s+https:\/\/a\.example\s+aiobs_u_…\s+\S+\s+1\s+1\s+never sent$/);
    expect(globex).toMatch(/^globex\s+Globex\s+company\s+–.*\s+0\s+2\s+rejected \(401\): new token needed; `ai-obs flush` retries$/);
    expect(r.text).not.toContain('acme-token');
  });

  it('token confirm: nothing to confirm, server company, older server, conflict', async () => {
    const net = fakeNet({
      [A]: { 'aiobs_u_acme-token': { company: ACME }, 'aiobs_u_test-lab': { company: { name: 'Lab', slug: 'lab' } }, 'aiobs_u_test-old': {} },
      [B]: {},
    });
    const t = setup(net);
    writeTestTokens(t.paths, [
      { name: 'acme', endpoint: A, token: 'aiobs_u_acme-token', company: ACME },
      { name: 'lab', endpoint: A, company: null, cache: false },
      { name: 'old', endpoint: A, company: null, cache: false },
    ]);
    const same = await t.run(['token', 'confirm', 'acme']);
    expect(same.code).toBe(0);
    expect(same.text).toContain('✓ acme is Acme Corp (acme), nothing to confirm');
    expect((await t.run(['token', 'confirm', 'nope'])).code).toBe(1);

    const lab = await t.run(['token', 'confirm', 'lab']);
    expect(lab.code).toBe(0);
    expect(lab.text).toContain('✓ lab confirmed: Lab (lab)');
    expect(loadConfig(t.paths)!.tokens[1]!.company).toEqual({ name: 'Lab', slug: 'lab' });
    expect(t.spawned).toHaveLength(1);

    const old = await t.run(['token', 'confirm', 'old']);
    expect(old.code).toBe(0);
    expect(old.text).toContain('confirmed by you');
    expect(loadConfig(t.paths)!.tokens[2]!.company).toEqual({ name: 'old', slug: 'old' });

    const c = setup(fakeNet({ [A]: { 'aiobs_u_acme-token': { company: ACME }, 'aiobs_u_test-dup': { company: ACME } } }));
    writeTestTokens(c.paths, [
      { name: 'acme', endpoint: A, token: 'aiobs_u_acme-token', company: ACME },
      { name: 'dup', endpoint: A, company: null, cache: false },
    ]);
    const before = read(c.paths.config);
    const dup = await c.run(['token', 'confirm', 'dup']);
    expect(dup.code).toBe(1);
    expect(dup.text).toContain('acme is already acme at https://a.example');
    expect(read(c.paths.config)).toBe(before);
  });

  it('token remove keeps the queue, counts bound events, lists assignments and appends an epoch', async () => {
    const t = setup();
    twoTokens(t.paths);
    writeProjects(t.paths, { [KEY]: { token: 'globex', endpoint: B, company_slug: 'globex', token_fp: tokenFingerprint('aiobs_c_globex-token'), assigned_at: '2026-10-08T00:00:00.000Z' } });
    enqueueFor(queueStore(t.paths), KEY, globexBind(), [...ev('a'), ...ev('b')]);
    writeTokenDelivery(t.paths, loadConfig(t.paths)!.tokens[1]!, { last_error: 'x' });
    const queue = JSON.stringify(queueStore(t.paths).stats());
    const projects = read(t.paths.projects);
    const epochs = loadConfig(t.paths)!.routingEpochs.length;
    const r = await t.run(['token', 'remove', 'globex']);
    expect(r.code).toBe(0);
    expect(r.text).toContain('✓ token globex (Globex) removed');
    expect(r.text).toContain('2 queued events recorded with globex stay on this machine');
    expect(r.text).toContain(`1 repositories were assigned to globex: their next sessions ask again (\`ai-obs use <other>\` in each): ${KEY}`);
    expect(r.text).toContain('new sessions report to acme (the only token)');
    const config = loadConfig(t.paths)!;
    expect(config.tokens.map((x) => x.name)).toEqual(['acme']);
    expect(config.routingEpochs).toHaveLength(epochs + 1);
    expect(config.routingEpochs.at(-1)!.single).toMatchObject({ endpoint: A, company_slug: 'acme' });
    expect(readDelivery(t.paths).tokens.globex).toBeUndefined();
    expect(existsSync(join(t.paths.collectorConfigDir, 'globex.json'))).toBe(false);
    expect(JSON.stringify(queueStore(t.paths).stats())).toBe(queue);
    expect(read(t.paths.projects)).toBe(projects);

    const last = await t.run(['token', 'remove', 'acme']);
    expect(last.text).toContain('no tokens left: nothing is recorded');
    expect((await t.run(['token', 'remove', 'acme'])).code).toBe(1);
  });

  it('token remove --invalid deletes malformed entries only', async () => {
    const t = setup();
    writeTestTokens(t.paths, [{ name: 'acme', endpoint: A }], { invalid: [{ name: 'Bad!', token: 'aiobs_u_broken-entry' }, 42] });
    expect((await t.run(['token', 'list'])).text).toContain('2 malformed entries in config.json');
    const r = await t.run(['token', 'remove', '--invalid']);
    expect(r.code).toBe(0);
    expect(r.text).toContain('removed malformed entry Bad! (aiobs_u_…ntry)');
    expect(r.text).toContain('removed malformed entry (unreadable entry)');
    const config = loadConfig(t.paths)!;
    expect(config.invalidTokens).toEqual([]);
    expect(config.tokens.map((x) => x.name)).toEqual(['acme']);
    expect((await t.run(['token', 'remove', '--invalid'])).text).toContain('no malformed token entries');
  });
});

describe('use', () => {
  it('assigns the repository by its normalized remote (0600, identity fields) and releases its open events', async () => {
    const t = setup();
    twoTokens(t.paths);
    const repo = gitRepo({ remote: 'git@github.com:Acme/Billing.git' });
    const pk = 'github.com/Acme/Billing';
    enqueueFor(queueStore(t.paths), pk, OPEN, [...ev('a'), ...ev('b')]);
    enqueueFor(queueStore(t.paths), pk, globexBind(), ev('c'));
    const r = await t.run(['use', 'acme', '--project-dir', repo], { resolveProjectKey: undefined });
    expect(r.code).toBe(0);
    expect(r.text).toContain(`✓ ${pk} → acme (Acme Corp)`);
    expect(r.text).toContain('→ 2 waiting events will be sent to acme');
    expect(r.text).toContain('1 events recorded while this repository used globex stay with globex; `ai-obs use acme --move-queued`');
    expect(statSync(t.paths.projects).mode & 0o777).toBe(0o600);
    const p = loadProjects(t.paths);
    expect(p.status === 'ok' && p.entries[pk]).toEqual({
      token: 'acme',
      endpoint: A,
      company_slug: 'acme',
      token_fp: tokenFingerprint('aiobs_u_acme-token'),
      assigned_at: expect.any(String),
    });
    expect(t.spawned).toHaveLength(1);

    const again = await t.run(['use', 'globex', '--project-dir', repo], { resolveProjectKey: undefined });
    expect(again.text).toContain('sessions already running here keep reporting to acme until they end');
  });

  it('refuses unknown (usage) and unconfirmed (exit 1) tokens', async () => {
    const t = setup();
    writeTestTokens(t.paths, [{ name: 'acme', endpoint: A }, { name: 'lab', endpoint: A, company: null, cache: false }]);
    const unknown = await t.run(['use', 'nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.text).toContain('no token named nope; registered: acme, lab');
    const lab = await t.run(['use', 'lab']);
    expect(lab.code).toBe(1);
    expect(lab.text).toContain('token lab is not confirmed: run `ai-obs token confirm lab` first');
    expect(existsSync(t.paths.projects)).toBe(false);
    expect((await t.run(['use', 'acme', '--none'])).code).toBe(2);
    expect((await t.run(['use', '--discard-queued'])).code).toBe(2);
  });

  it('--none keeps queued events and stops recording; --discard-queued deletes them; --clear undoes the choice', async () => {
    const t = setup();
    twoTokens(t.paths);
    enqueueFor(queueStore(t.paths), KEY, OPEN, ev('a'));
    const none = await t.run(['use', '--none']);
    expect(none.code).toBe(0);
    expect(none.text).toContain(`✓ ${KEY} will not be reported; new sessions are not recorded. 1 queued events of it are kept`);
    const store = queueStore(t.paths);
    store.enqueue(ev('b'), { kind: 'project', pk: KEY, bind: OPEN }); // dropped: opted out
    expect(store.stats().events).toBe(1);
    const status = await t.run(['status']);
    expect(status.text).toContain(`project    ${KEY} is not reported`);

    const clear = await t.run(['use', '--clear']);
    expect(clear.text).toContain('→ new sessions wait for a token');
    expect((await t.run(['use', '--clear'])).text).toContain(`${KEY} had no choice`);

    const gone = await t.run(['use', '--none', '--discard-queued']);
    expect(gone.code).toBe(0);
    expect(gone.text).toContain(`deleted 1 queued events of ${KEY}`);
    expect(queueStore(t.paths).stats().events).toBe(0);
  });

  it('--none / --clear re-read projects.json before writing: a choice another `use` saved meanwhile survives', async () => {
    const t = setup();
    twoTokens(t.paths);
    const other = 'github.com/acme/other';
    const otherChoice = { token: 'globex', endpoint: B, company_slug: 'globex', token_fp: tokenFingerprint('aiobs_c_globex-token'), assigned_at: new Date().toISOString() };
    // another agent's `ai-obs use globex` in another repository lands while this command waits for git
    const racing = async () => {
      const p = loadProjects(t.paths);
      writeProjects(t.paths, { ...(p.status === 'ok' ? p.entries : {}), [other]: otherChoice });
      return KEY;
    };
    const entries = () => {
      const p = loadProjects(t.paths);
      return p.status === 'ok' ? p.entries : {};
    };
    expect((await t.run(['use', '--none'], { resolveProjectKey: racing })).code).toBe(0);
    expect(entries()).toMatchObject({ [KEY]: { token: null, none: true }, [other]: otherChoice });
    writeProjects(t.paths, { [KEY]: { token: null, none: true, assigned_at: new Date().toISOString() } });
    expect((await t.run(['use', '--clear'], { resolveProjectKey: racing })).code).toBe(0);
    expect(entries()).toEqual({ [other]: otherChoice });
    writeProjects(t.paths, {});
    expect((await t.run(['use', '--none', '--discard-queued'], { resolveProjectKey: racing })).code).toBe(0);
    expect(entries()).toMatchObject({ [KEY]: { token: null, none: true }, [other]: otherChoice });
  });

  it('--move-queued moves events bound to another token into the new choice', async () => {
    const t = setup();
    twoTokens(t.paths);
    enqueueFor(queueStore(t.paths), KEY, globexBind(), [...ev('a'), ...ev('b')]);
    const r = await t.run(['use', 'acme', '--move-queued']);
    expect(r.code).toBe(0);
    expect(r.text).toContain(`moving 2 queued events of ${KEY} from globex to acme`);
    const streams = queueStore(t.paths).stats().streams;
    expect(streams).toHaveLength(1);
    expect(streams[0]!.stream.bind).toMatchObject({ kind: 'token', name: 'acme' });
    expect(streams[0]!.events).toBe(2);
  });

  it('--all-held assigns every repository whose open events wait', async () => {
    const t = setup();
    twoTokens(t.paths);
    enqueueFor(queueStore(t.paths), 'github.com/acme/web', OPEN, ev('a'));
    enqueueFor(queueStore(t.paths), '/Users/x/scratch', OPEN, ev('b'));
    enqueueFor(queueStore(t.paths), KEY, acmeBind(), ev('c'));
    const r = await t.run(['use', 'globex', '--all-held']);
    expect(r.code).toBe(0);
    expect(r.text).toContain('✓ 2 repositories → globex (Globex); 2 waiting events will be sent');
    const p = loadProjects(t.paths);
    expect(p.status === 'ok' && Object.keys(p.entries).sort()).toEqual(['/Users/x/scratch', 'github.com/acme/web']);
    expect((await t.run(['use', 'globex', '--all-held'])).text).toContain('no repository is waiting for a token');
  });

  it('an unreadable projects.json is never rewritten except by --reset-projects, which sets it aside', async () => {
    const t = setup(fakeNet({ [A]: { 'aiobs_u_acme-token': { company: ACME } }, [B]: { aiobs_c_new: { company: { name: 'Initech', slug: 'initech' } } } }));
    twoTokens(t.paths);
    enqueueFor(queueStore(t.paths), 'github.com/acme/web', OPEN, ev('a'));
    writeFileSync(t.paths.projects, '{ broken', { mode: 0o600 });
    for (const argv of [['use', 'acme'], ['use', '--none'], ['use', '--clear'], ['use', 'acme', '--all-held']]) {
      const r = await t.run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.text).toContain('cannot be read');
      expect(r.text).toContain('ai-obs use --reset-projects');
      expect(read(t.paths.projects)).toBe('{ broken');
    }
    expect((await t.run(['token', 'remove', 'globex'])).code).toBe(0);
    expect((await t.run(['token', 'add', '--token', 'aiobs_c_new', '--endpoint', B])).code).toBe(0);
    expect(read(t.paths.projects)).toBe('{ broken');
    const doctor = await t.run(['doctor']);
    expect(doctor.text).toContain('✗ project projects.json cannot be read');

    const reset = await t.run(['use', '--reset-projects']);
    expect(reset.code).toBe(0);
    expect(reset.text).toContain('moved the unreadable file to');
    expect(JSON.parse(read(t.paths.projects))).toEqual({});
    expect(readdirSync(t.paths.root).filter((f) => f.startsWith('projects.json.broken-'))).toHaveLength(1);
    expect((await t.run(['use', '--reset-projects'])).text).toContain('projects.json is fine; nothing to reset');
  });
});

describe('status / doctor / flush / uninstall', () => {
  it('status with zero tokens prints the banner and exits 1', async () => {
    const t = setup();
    writeTestTokens(t.paths, []);
    const r = await t.run(['status']);
    expect(r.code).toBe(1);
    expect(r.text).toContain('! no tokens registered: nothing is recorded');
  });

  it('status with two tokens: token states, unassigned project, waiting, kept and dropped lines', async () => {
    const t = setup();
    twoTokens(t.paths);
    const store = queueStore(t.paths);
    enqueueFor(store, KEY, OPEN, ev('a'));
    enqueueFor(store, 'github.com/acme/web', OPEN, ev('b'));
    enqueueFor(store, 'github.com/old/x', bound('old', A, 'oldco', 'aiobs_u_gone'), ev('c'));
    enqueueFor(store, 'github.com/globex/x', globexBind(), [...ev('d'), ...ev('e')]);
    writeTokenDelivery(t.paths, loadConfig(t.paths)!.tokens[1]!, { blocked: { status: 403, at: new Date().toISOString(), message: 'company is suspended' } });
    recordDropped(t.paths, { held: 7, sendable: 0 });
    recordDropped(t.paths, { held: 0, sendable: 5 }); // the worker's age / size cap on a sendable stream (C13)
    const r = await t.run(['status']);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/tokens\s+acme\s+Acme Corp · user dev@acme\.com · https:\/\/a\.example · aiobs_u_… · ok, last send never/);
    expect(r.text).toContain('globex  Globex · company token · https://b.example · aiobs_c_…oken · company Globex is SUSPENDED; `ai-obs flush` retries once it is active again');
    expect(r.text).toContain(`project    ${KEY} not assigned: new sessions are kept here (1 events waiting). Run \`ai-obs use <acme|globex>\``);
    expect(r.text).toMatch(/queue\s+5 events/);
    expect(r.text).toContain('waiting    2 projects waiting for a token (2 events)');
    expect(r.text).toContain('2 events for globex (suspended); `ai-obs flush` retries it');
    expect(r.text).toContain('1 events recorded with tokens that are no longer registered');
    expect(r.text).toContain('dropped    7 kept events were dropped by the 50 MB cap; 5 events that could not be sent were dropped by the 30-day / 50 MB queue caps');
    expect(r.text).not.toContain('last send  '); // single-token lines only
  });

  it('doctor flags malformed entries, unknown streams, waiting projects and a stale hook runtime', async () => {
    const t = setup(fakeNet({ [A]: { 'aiobs_u_acme-token': { company: ACME } }, [B]: { 'aiobs_c_globex-token': { company: GLOBEX } } }));
    writeTestTokens(
      t.paths,
      [
        { name: 'acme', endpoint: A, token: 'aiobs_u_acme-token', company: ACME, email: 'dev@acme.com' },
        { name: 'globex', endpoint: B, token: 'aiobs_c_globex-token', company: GLOBEX },
      ],
      { invalid: [{ name: 'x' }] },
    );
    enqueueFor(queueStore(t.paths), 'github.com/acme/web', OPEN, ev('a'));
    const unknown = join(t.paths.queueProjects, 't-0123456789abcdef0123456789abcdef');
    mkdirSync(unknown, { recursive: true });
    writeFileSync(join(unknown, '01JABCDEFGHJKMNPQRSTVWXYZ0.ndjson'), `${JSON.stringify(ev('z')[0])}\n`);
    mkdirSync(join(t.paths.app, 'bin'), { recursive: true });
    writeFileSync(join(t.paths.app, 'bin', 'ai-obs.js'), '');
    writeFileSync(join(t.paths.app, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    t.adapter.installs.push({});
    recordDropped(t.paths, { held: 0, sendable: 3 });
    const r = await t.run(['doctor']);
    expect(r.code).toBe(1);
    expect(r.text).toContain('✓ config');
    expect(r.text).toContain('2 token(s)');
    expect(r.text).toContain('✗ 1 malformed token entries in config.json');
    expect(r.text).toContain('✓ token valid (acme: Acme Corp, user dev@acme.com)');
    expect(r.text).toContain('✓ token valid (globex: Globex, company token)');
    expect(r.text).toContain('! project config.json has malformed token entries');
    expect(r.text).toContain('! 1 projects waiting for a token (1 events)');
    expect(r.text).toContain(`✗ queue stream ${unknown} has no readable stream.json; its 1 events are kept and never sent`);
    expect(r.text).toContain('! hook runtime is 0.1.0, collector is');
    expect(r.text).toContain('! 3 events that could not be sent were dropped by the 30-day / 50 MB queue caps');
  });

  it('flush with only held events exits 0 and says what is kept; uninstall --purge then needs --yes', async () => {
    const t = setup();
    twoTokens(t.paths);
    enqueueFor(queueStore(t.paths), KEY, OPEN, [...ev('a'), ...ev('b')]);
    const f = await t.run(['flush']);
    expect(f.code).toBe(0);
    expect(f.text).toContain('! kept: 2 events of 1 project(s) waiting for a token');
    expect(t.net.ingests()).toHaveLength(0);

    const refused = await t.run(['uninstall', '--purge']);
    expect(refused.code).toBe(1);
    expect(refused.text).toContain(`will delete ${t.paths.root}: tokens acme, globex; 0 project assignments; 2 unsent events (2 of them waiting for a token or a working token)`);
    expect(refused.text).toContain('add --yes to delete them');
    expect(t.adapter.uninstalls).toHaveLength(0);
    expect(existsSync(t.paths.root)).toBe(true);
    const purged = await t.run(['uninstall', '--purge', '--yes']);
    expect(purged.code).toBe(0);
    expect(purged.text).toContain('(2 unsent events discarded)');
    expect(existsSync(t.paths.root)).toBe(false);
  });

  it('flush sends each stream with its own token and reports per token', async () => {
    const t = setup(fakeNet({ [A]: { 'aiobs_u_acme-token': { company: ACME } }, [B]: { 'aiobs_c_globex-token': { status: 401 } } }));
    twoTokens(t.paths);
    enqueueFor(queueStore(t.paths), KEY, acmeBind(), ev('a'));
    enqueueFor(queueStore(t.paths), 'github.com/globex/x', globexBind(), ev('b'));
    const f = await t.run(['flush']);
    expect(f.code).toBe(1);
    expect(f.text).toContain('sent 1 events to acme in 1 batch(es)');
    expect(f.text).toContain('✗ globex: token rejected (HTTP 401): create a new token and run `ai-obs token add --token <new token> --name globex`; 1 events stay queued');
    // each token sent only its own stream; globex's refusal kept its event
    expect(t.net.ingests().map((c) => [c.endpoint, c.bearer, c.events]).sort()).toEqual([
      [A, 'aiobs_u_acme-token', 1],
      [B, 'aiobs_c_globex-token', 1],
    ]);
    expect(queueStore(t.paths).stats().events).toBe(1);
  });
});
