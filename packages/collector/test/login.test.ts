import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import type { AiObsPaths } from '../src/paths.js';
import { sessionEndEvent } from '../src/events.js';
import { COLLECTOR_VERSION } from '../src/version.js';
import { enqueueFor, queueStore } from './queue-helpers.js';
import { bearerOf, ccValue, cleanupHomes, startServer, tmpHome, writeTestConfig, writeTestServers, type Received, type ServerReply } from './helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  cleanupHomes();
});

function capture() {
  const lines: string[] = [];
  return { lines, text: () => lines.join('\n'), io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
}

const EXP = '2027-01-22T10:00:00.000Z';
const DEVICE_CODE = 'd'.repeat(43);

/**
 * A device-login server (appendix B) on node:http: `/device/code` answers a code, `/device/token` answers the
 * scripted `polls` in order (then the last one), and collector-config accepts the minted token.
 */
async function deviceServer(polls: ServerReply[], opts: { code?: ServerReply; token?: string; email?: string | null } = {}) {
  const token = opts.token ?? 'aiobs_u_minted';
  let poll = 0;
  const srv = await startServer((req: Received): ServerReply => {
    if (req.url === '/api/v1/device/code') {
      return opts.code ?? { status: 200, body: { device_code: DEVICE_CODE, user_code: 'ABCDEFGH', verification_uri: 'https://evil.example/device', expires_in: 600, interval: 5 } };
    }
    if (req.url === '/api/v1/device/token') return polls[Math.min(poll++, polls.length - 1)]!;
    if (req.url === '/api/v1/collector-config') {
      return bearerOf(req) === token
        ? { status: 200, body: ccValue({ expiresAt: EXP, label: 'mac-dev', ...(opts.email !== undefined ? { email: opts.email } : {}) }) }
        : { status: 401, body: { error: 'expired or revoked' } };
    }
    return { status: 404 };
  });
  closers.push(srv.close);
  return srv;
}

/** Deps with a fake clock that the injected sleep advances. */
function deps(paths: AiObsPaths, extra: Record<string, unknown> = {}) {
  let clock = Date.parse('2026-10-24T10:00:00Z');
  const slept: number[] = [];
  const opened: string[] = [];
  let runtimes = 0;
  return {
    slept,
    opened,
    runtimes: () => runtimes,
    deps: {
      paths,
      env: { DISPLAY: ':0' } as NodeJS.ProcessEnv,
      now: () => clock,
      sleep: async (ms: number) => {
        slept.push(ms);
        clock += ms;
      },
      openBrowser: (url: string) => void opened.push(url),
      hostname: () => 'mac-dev',
      installRuntime: (p: AiObsPaths) => (runtimes++, { entry: `${p.app}/bin/ai-obs.js`, node: '/usr/bin/node', copied: false }),
      cwd: paths.root,
      ...extra,
    },
  };
}

const pending = { status: 400, body: { error: 'authorization_pending' } };
const minted = { status: 200, body: { token: 'aiobs_u_minted', expires_at: EXP, label: 'mac-dev' } };

describe('ai-obs login (device flow)', () => {
  it('requests a code, prints and opens <server>/device, polls with interval and slow_down, verifies and stores the token', async () => {
    const srv = await deviceServer([pending, { status: 400, body: { error: 'slow_down' } }, pending, minted]);
    const paths = tmpHome();
    const d = deps(paths);
    const c = capture();
    expect(await main(['login', '--server', `${srv.url}/`], c.io, d.deps)).toBe(0);
    const codeReq = srv.received.find((r) => r.url === '/api/v1/device/code')!;
    expect(codeReq.json).toEqual({ client_name: 'mac-dev', client_version: COLLECTOR_VERSION });
    const polls = srv.received.filter((r) => r.url === '/api/v1/device/token');
    expect(polls).toHaveLength(4);
    expect(polls[0]!.json).toEqual({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: DEVICE_CODE });
    expect(d.slept).toEqual([5000, 5000, 10000, 10000]); // interval, then +5 s after slow_down
    // the URL is built here, never taken from the answer
    expect(c.text()).toContain(`Open ${srv.url}/device and enter the code ABCD-EFGH`);
    expect(d.opened).toEqual([`${srv.url}/device`]);
    expect(c.text()).not.toContain('evil.example');
    expect(loadConfig(paths)!.servers).toEqual([
      { endpoint: srv.url, token: 'aiobs_u_minted', email: 'dev@acme.com', deployment: { name: 'SPECTADO', slug: 'spectado' }, label: 'mac-dev', expires_at: EXP, source: 'device', added_at: expect.any(String) },
    ]);
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(c.text()).toContain(`✓ logged in to ${srv.url}: dev@acme.com · SPECTADO · mac-dev, expires 2027-01-22`);
    expect(c.text()).toContain('your teams: platform, spectado (primary: spectado)');
    expect(c.text()).toContain('→ run `ai-obs init` to install the harness hooks');
    expect(d.runtimes()).toBe(1); // the hook runtime is refreshed with the new config format
    expect(c.text()).not.toContain('aiobs_u_minted');
  });

  it('--no-browser (or no display) only prints the URL; --label names the client', async () => {
    const srv = await deviceServer([minted]);
    const paths = tmpHome();
    const d = deps(paths);
    expect(await main(['login', '--server', srv.url, '--no-browser', '--label', 'ci-runner'], capture().io, d.deps)).toBe(0);
    expect(d.opened).toEqual([]);
    expect(srv.received.find((r) => r.url === '/api/v1/device/code')!.json).toMatchObject({ client_name: 'ci-runner' });
    const ssh = tmpHome();
    const s = deps(ssh, { env: { SSH_CONNECTION: '1 2 3 4' } });
    expect(await main(['login', '--server', srv.url], capture().io, s.deps)).toBe(0);
    expect(s.opened).toEqual([]);
  });

  it('access_denied, expired_token and invalid_grant stop with exit 1 and change nothing', async () => {
    for (const [error, text] of [
      ['access_denied', 'denied in the browser'],
      ['expired_token', 'code expired'],
      ['invalid_grant', 'no longer valid'],
    ] as const) {
      const srv = await deviceServer([pending, { status: 400, body: { error } }]);
      const paths = tmpHome();
      const c = capture();
      expect(await main(['login', '--server', srv.url], c.io, deps(paths).deps)).toBe(1);
      expect(c.text()).toContain(text);
      expect(existsSync(paths.config)).toBe(false);
    }
  });

  it('gives up when the code expires while pending; keeps polling through network errors and 5xx', async () => {
    const srv = await deviceServer([{ status: 503 }, pending], { code: { status: 200, body: { device_code: DEVICE_CODE, user_code: 'ABCD-EFGH', expires_in: 30, interval: 10 } } });
    const paths = tmpHome();
    const d = deps(paths);
    const c = capture();
    expect(await main(['login', '--server', srv.url], c.io, d.deps)).toBe(1);
    expect(c.text()).toContain('the code expired before it was approved');
    expect(d.slept).toEqual([10000, 10000, 10000]);
    expect(existsSync(paths.config)).toBe(false);
  });

  it('an unexpected code answer or a server without device login fails clearly', async () => {
    const bad = await deviceServer([], { code: { status: 200, body: { device_code: DEVICE_CODE, user_code: 'abc' } } });
    const c = capture();
    expect(await main(['login', '--server', bad.url], c.io, deps(tmpHome()).deps)).toBe(1);
    expect(c.text()).toContain('unexpected answer');
    const old = await deviceServer([], { code: { status: 404 } });
    const o = capture();
    expect(await main(['login', '--server', old.url], o.io, deps(tmpHome()).deps)).toBe(1);
    expect(o.text()).toContain('--token -');
    // a real 0.3 / 0.4 server: its proxy answers 401 for every non-public /api/ path without a session
    const v04 = await deviceServer([], { code: { status: 401, body: { error: 'unauthorized' } } });
    const v = capture();
    const vHome = tmpHome();
    expect(await main(['login', '--server', v04.url], v.io, deps(vHome).deps)).toBe(1);
    expect(v.text()).toContain('does not offer device login (HTTP 401: an older server?)');
    expect(v.text()).toContain(`ai-obs login --server ${v04.url} --token -`);
    expect(existsSync(vHome.config)).toBe(false);
    const down = capture();
    expect(await main(['login', '--server', 'http://127.0.0.1:9'], down.io, deps(tmpHome()).deps)).toBe(1);
    expect(down.text()).toContain('not reachable');
  });

  it('a 429 from /device/code names the limit and the server\'s Retry-After', async () => {
    const busy = await deviceServer([], { code: { status: 429, body: { error: 'too_many_open_codes' }, headers: { 'retry-after': '60' } } });
    const b = capture();
    expect(await main(['login', '--server', busy.url], b.io, deps(tmpHome()).deps)).toBe(1);
    expect(b.text()).toContain('too many logins are waiting for approval');
    expect(b.text()).toContain('server-wide limit');
    expect(b.text()).toContain('try again in 60 s');
    const limited = await deviceServer([], { code: { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '17' } } });
    const l = capture();
    expect(await main(['login', '--server', limited.url], l.io, deps(tmpHome()).deps)).toBe(1);
    expect(l.text()).toContain('rate limiting device logins from this address (HTTP 429); try again in 17 s');
  });

  it('a 429 while polling waits at least the server\'s Retry-After', async () => {
    const srv = await deviceServer([{ status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '30' } }, minted]);
    const paths = tmpHome();
    const d = deps(paths);
    expect(await main(['login', '--server', srv.url], capture().io, d.deps)).toBe(0);
    expect(d.slept).toEqual([5000, 30000]);
  });
});

describe('ai-obs login as another account', () => {
  const queueOf = (paths: AiObsPaths, endpoint: string) =>
    enqueueFor(queueStore(paths), 'github.com/acme/billing', endpoint, [
      sessionEndEvent({ harness: 'codex', sessionId: 's1', reason: 'exit', at: 0 }),
      sessionEndEvent({ harness: 'codex', sessionId: 's2', reason: 'exit', at: 0 }),
    ]);

  it('sets the previous account\'s queued events aside instead of sending them as the new account', async () => {
    const srv = await deviceServer([], { token: 'aiobs_u_bob' });
    const paths = tmpHome();
    writeTestConfig(paths, srv.url, { email: 'alice@acme.com' });
    queueOf(paths, srv.url);
    queueOf(paths, ''); // no dot-file server: goes to the only server, so it is alice's too
    const c = capture();
    expect(await main(['login', '--server', srv.url, '--token', 'aiobs_u_bob'], c.io, deps(paths).deps)).toBe(0);
    expect(loadConfig(paths)!.servers).toMatchObject([{ token: 'aiobs_u_bob', email: 'dev@acme.com' }]);
    expect(c.text()).toContain('! the previous token for this server belonged to alice@acme.com, the new one to dev@acme.com');
    expect(c.text()).toContain('4 queued events recorded as alice@acme.com were set aside in');
    expect(c.text()).not.toContain('are sent with the new one');
    expect(queueStore(paths).stats().events).toBe(0);
    const aside = join(paths.queue, 'set-aside');
    const [batch] = readdirSync(aside);
    expect(readdirSync(join(aside, batch!, 'p'))).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(aside, batch!, 'about.json'), 'utf8'))).toMatchObject({ from: 'alice@acme.com', to: 'dev@acme.com', endpoint: srv.url, events: 4, streams: 2 });
    expect(c.text()).toContain('the previous token stays valid on the server until it expires');
  });

  it('--keep-queue sends them with the new token; the same account (or an unchecked one) changes nothing', async () => {
    const srv = await deviceServer([], { token: 'aiobs_u_bob' });
    const keep = tmpHome();
    writeTestConfig(keep, srv.url, { email: 'alice@acme.com' });
    queueOf(keep, srv.url);
    const k = capture();
    expect(await main(['login', '--server', srv.url, '--token', 'aiobs_u_bob', '--keep-queue'], k.io, deps(keep).deps)).toBe(0);
    expect(k.text()).toContain('--keep-queue: 2 queued events recorded as alice@acme.com are sent with the new token');
    expect(queueStore(keep).stats().events).toBe(2);
    expect(existsSync(join(keep.queue, 'set-aside'))).toBe(false);

    const same = tmpHome();
    writeTestConfig(same, srv.url, { email: 'DEV@acme.com' });
    queueOf(same, srv.url);
    const s = capture();
    expect(await main(['login', '--server', srv.url, '--token', 'aiobs_u_bob'], s.io, deps(same).deps)).toBe(0);
    expect(s.text()).toContain('replaced the previous token for this server; events queued for it are sent with the new one');
    expect(queueStore(same).stats().events).toBe(2);

    const service = await deviceServer([], { token: 'aiobs_u_ci', email: null });
    const toService = tmpHome();
    writeTestConfig(toService, service.url, { email: 'alice@acme.com' });
    queueOf(toService, service.url);
    const t = capture();
    expect(await main(['login', '--server', service.url, '--token', 'aiobs_u_ci'], t.io, deps(toService).deps)).toBe(0);
    expect(t.text()).toContain('belonged to alice@acme.com, the new one to a service user');
    expect(queueStore(toService).stats().events).toBe(0);
  });
});

describe('ai-obs login --token', () => {
  it('a pasted token (argument or stdin) is verified and stored as a manual login', async () => {
    const srv = await deviceServer([], { token: 'aiobs_u_pasted' });
    const paths = tmpHome();
    expect(await main(['login', '--server', srv.url, '--token', 'aiobs_u_pasted'], capture().io, deps(paths).deps)).toBe(0);
    expect(loadConfig(paths)!.servers[0]).toMatchObject({ token: 'aiobs_u_pasted', expires_at: EXP, source: 'device', email: 'dev@acme.com' });
    const viaStdin = tmpHome();
    expect(await main(['login', '--server', srv.url, '--token', '-'], capture().io, deps(viaStdin, { readStdin: async () => 'aiobs_u_pasted\n' }).deps)).toBe(0);
    expect(loadConfig(viaStdin)!.servers[0]!.token).toBe('aiobs_u_pasted');
    expect(srv.received.some((r) => r.url.startsWith('/api/v1/device'))).toBe(false);
  });

  it('refuses retired and foreign tokens (exit 2) and a rejected one (exit 1), changing nothing', async () => {
    const srv = await deviceServer([], { token: 'aiobs_u_good' });
    const paths = tmpHome();
    const c = capture();
    expect(await main(['login', '--server', srv.url, '--token', 'aiobs_c_company'], c.io, deps(paths).deps)).toBe(2);
    expect(c.text()).toContain('aiobs_c_ no longer exist');
    expect(await main(['login', '--server', srv.url, '--token', 'sk-123'], capture().io, deps(paths).deps)).toBe(2);
    const rejected = capture();
    expect(await main(['login', '--server', srv.url, '--token', 'aiobs_u_revoked'], rejected.io, deps(paths).deps)).toBe(1);
    expect(rejected.text()).toContain('rejected token aiobs_u_…');
    expect(existsSync(paths.config)).toBe(false);
    expect(await main(['login', '--server', srv.url, '--token', '-'], capture().io, deps(paths, { readStdin: async () => '' }).deps)).toBe(2);
  });

  it('logging in to the same server again replaces its token (one entry per endpoint) and keeps the machine', async () => {
    const srv = await deviceServer([], { token: 'aiobs_u_new' });
    const paths = tmpHome();
    const before = writeTestConfig(paths, srv.url);
    const c = capture();
    expect(await main(['login', '--server', srv.url, '--token', 'aiobs_u_new'], c.io, deps(paths).deps)).toBe(0);
    const after = loadConfig(paths)!;
    expect(after.machine_id).toBe(before.machine_id);
    expect(after.servers.map((s) => s.token)).toEqual(['aiobs_u_new']);
    expect(c.text()).toContain('replaced the previous token for this server; events queued for it are sent with the new one');
    expect(c.text()).not.toContain('→ run `ai-obs init`');
  });

  it('the server defaults to AI_OBS_ENDPOINT, else the only registered one; with several it is required', async () => {
    const srv = await deviceServer([], { token: 'aiobs_u_t' });
    const env = tmpHome();
    const c = capture();
    expect(await main(['login', '--token', 'aiobs_u_t'], c.io, deps(env, { env: { AI_OBS_ENDPOINT: srv.url } }).deps)).toBe(0);
    expect(c.text()).toContain(`server ${srv.url} (from AI_OBS_ENDPOINT)`);
    const only = tmpHome();
    writeTestConfig(only, srv.url);
    const o = capture();
    expect(await main(['login', '--token', 'aiobs_u_t'], o.io, deps(only).deps)).toBe(0);
    expect(o.text()).toContain('(from the only registered server)');
    const two = tmpHome();
    writeTestServers(two, [{ endpoint: srv.url }, { endpoint: 'https://obs.other.io' }]);
    const t = capture();
    expect(await main(['login', '--token', 'aiobs_u_t'], t.io, deps(two).deps)).toBe(2);
    expect(t.text()).toContain('--server is required: 2 servers are registered');
    expect(await main(['login', '--token', 'aiobs_u_t'], capture().io, deps(tmpHome()).deps)).toBe(2);
  });

  it('a second server: both kept, with a hint about `ai-obs link`', async () => {
    const srv = await deviceServer([], { token: 'aiobs_u_b' });
    const paths = tmpHome();
    writeTestConfig(paths, 'https://obs.first.io');
    const c = capture();
    expect(await main(['login', '--server', srv.url, '--token', 'aiobs_u_b'], c.io, deps(paths).deps)).toBe(0);
    expect(loadConfig(paths)!.servers.map((s) => s.endpoint)).toEqual(['https://obs.first.io', srv.url]);
    expect(c.text()).toContain('2 servers are registered');
    expect(c.text()).toContain('ai-obs link --server <url> --team <slug>');
  });
});
