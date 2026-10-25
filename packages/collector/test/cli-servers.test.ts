import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { readDelivery, writeServerDelivery } from '../src/delivery.js';
import { sessionEndEvent } from '../src/events.js';
import { tryLock } from '../src/lock.js';
import type { AiObsPaths } from '../src/paths.js';
import { cleanupHomes, fakeAdapter, gitRepo, okResponder, startServer, tmpHome, tokenResponder, writeDotFile, writeTestConfig, writeTestServers } from './helpers.js';
import { enqueueFor, queueStore } from './queue-helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  cleanupHomes();
});

function capture() {
  const lines: string[] = [];
  return { text: () => lines.join('\n'), io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
}

const PK = 'github.com/acme/billing';
const DAY = 86_400_000;
const one = (paths: AiObsPaths, pk: string, endpoint: string, team = '') =>
  enqueueFor(queueStore(paths), pk, endpoint, [sessionEndEvent({ harness: 'codex', sessionId: `s-${pk}`, reason: 'exit', at: 0 })], team);
const deps = (paths: AiObsPaths, cwd: string, extra: Record<string, unknown> = {}) => ({ paths, cwd, env: {}, resolveProjectKey: async () => PK, ...extra });

describe('token list / remove', () => {
  it('token list: one row per server with account, deployment, label, expiry, repositories, queued events and state', async () => {
    const paths = tmpHome();
    const cfg = writeTestServers(paths, [
      { endpoint: 'https://obs.a.io', expiresAt: new Date(Date.now() + 5 * DAY + 3600_000).toISOString() },
      { endpoint: 'https://obs.b.io', email: null, expiresAt: new Date(Date.now() - DAY).toISOString() },
    ]);
    writeServerDelivery(paths, cfg.servers[0]!, { repos: { [PK]: new Date().toISOString(), 'github.com/acme/web': new Date().toISOString() } });
    one(paths, PK, 'https://obs.b.io');
    const c = capture();
    expect(await main(['token', 'list'], c.io, deps(paths, paths.root))).toBe(0);
    const lines = c.text().split('\n');
    expect(lines[0]).toMatch(/^SERVER\s+E-MAIL\s+DEPLOYMENT\s+LABEL\s+EXPIRES\s+REPOSITORIES\s+QUEUED\s+STATE$/);
    expect(lines[1]).toMatch(/^https:\/\/obs\.a\.io\s+dev@acme\.com\s+SPECTADO\s+test-mac\s+\d{4}-\d\d-\d\d\s+2\s+0\s+never sent; expires in 5 days/);
    expect(lines[2]).toMatch(/^https:\/\/obs\.b\.io\s+\(service user\)\s+SPECTADO.*\s+0\s+1\s+EXPIRED: run `ai-obs login --server https:\/\/obs\.b\.io`/);
    expect(c.text()).not.toContain('aiobs_');
  });

  it('token remove <server|host>: the token goes, its queued events stay', async () => {
    const paths = tmpHome();
    const cfg = writeTestServers(paths, [{ endpoint: 'https://obs.a.io' }, { endpoint: 'http://localhost:3000' }]);
    writeServerDelivery(paths, cfg.servers[1]!, { consecutive_failures: 1 });
    one(paths, PK, 'http://localhost:3000');
    const c = capture();
    expect(await main(['token', 'remove', 'localhost:3000'], c.io, deps(paths, paths.root))).toBe(0);
    expect(loadConfig(paths)!.servers.map((s) => s.endpoint)).toEqual(['https://obs.a.io']);
    expect(Object.keys(readDelivery(paths).servers)).toEqual([]);
    expect(c.text()).toContain('! 1 queued events for http://localhost:3000 stay on this machine');
    expect(c.text()).toContain('now report to https://obs.a.io (the only server)');
    expect(queueStore(paths).stats().events).toBe(1);
    expect(await main(['token', 'remove', 'nope.io'], capture().io, deps(paths, paths.root))).toBe(1);
    expect(await main(['token', 'remove'], capture().io, deps(paths, paths.root))).toBe(2);
    expect(await main(['token', 'add', '--token', 'x'], capture().io, deps(paths, paths.root))).toBe(2);
    expect(await main(['token', 'confirm', 'x'], capture().io, deps(paths, paths.root))).toBe(2);
  });

  it('a busy worker lock refuses token remove and changes nothing', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    const release = tryLock(paths.workerLock)!;
    try {
      const c = capture();
      expect(await main(['token', 'remove', 'http://127.0.0.1:9'], c.io, deps(paths, paths.root, { lockWaitMs: 50 }))).toBe(1);
      expect(c.text()).toContain('Nothing was changed');
      expect(loadConfig(paths)!.servers).toHaveLength(1);
    } finally {
      release();
    }
  });
});

describe('status', () => {
  it('servers, this repository (dot file, server, how the team is set), kept events per reason', async () => {
    const paths = tmpHome();
    writeTestServers(paths, [{ endpoint: 'https://obs.a.io' }, { endpoint: 'https://obs.b.io', expiresAt: new Date(Date.now() + 3 * DAY + 3600_000).toISOString() }]);
    const repo = gitRepo();
    writeDotFile(repo, { server: 'https://obs.b.io', team: 'mobile' });
    one(paths, 'github.com/x/none', '');
    one(paths, 'github.com/x/other', 'https://obs.other.io');
    const c = capture();
    expect(await main(['status'], c.io, deps(paths, repo))).toBe(0);
    const t = c.text();
    expect(t).toMatch(/servers\s+https:\/\/obs\.a\.io\s+dev@acme\.com · SPECTADO · test-mac, no expiry · never sent/);
    expect(t).toContain('https://obs.b.io  dev@acme.com · SPECTADO');
    expect(t).toContain('expires in 3 days');
    expect(t).toContain(`repository ${repo}/.ai-obs.json: server https://obs.b.io`);
    expect(t).toContain(`${repo}/.ai-obs.json: "team" is ignored (an admin assigns projects to teams on the server): remove the key`);
    expect(t).toContain('server https://obs.b.io (from the dot file): never sent; expires in 3 days');
    expect(t).toContain('team: set on the server by an admin (project mapping), else your primary team (spectado)');
    expect(t).not.toContain('team mobile');
    expect(t).toContain('1 events of repositories without a server (several are registered)');
    expect(t).toContain('1 events for https://obs.other.io, which this machine is not logged in to: run `ai-obs login --server https://obs.other.io`');
  });

  it('a malformed dot file is reported; two servers and no dot-file server ask for a link', async () => {
    const paths = tmpHome();
    writeTestServers(paths, [{ endpoint: 'https://obs.a.io' }, { endpoint: 'https://obs.b.io' }]);
    const repo = gitRepo();
    writeDotFile(repo, '{"server": 12}');
    const c = capture();
    expect(await main(['status'], c.io, deps(paths, repo))).toBe(0);
    expect(c.text()).toContain(`✗ ${repo}/.ai-obs.json: "server" must be an http(s) URL (ignored): fix or delete it`);
    expect(c.text()).toContain('! no server chosen (2 servers are registered and no dot file names one)');
  });

  it('with no server: the banner, "servers none", exit 1; not configured: exit 1', async () => {
    const paths = tmpHome();
    writeTestServers(paths, []);
    const c = capture();
    expect(await main(['status'], c.io, deps(paths, paths.root))).toBe(1);
    expect(c.text()).toContain('! not logged in to any ai-obs server: nothing is recorded. Run `ai-obs login --server <url>`.');
    expect(c.text()).toContain('servers    none');
    expect(await main(['status'], capture().io, deps(tmpHome(), '/'))).toBe(1);
  });
});

describe('doctor', () => {
  it('checks each server (token, expiry, teams), the dot file and this repository’s server and team', async () => {
    const A = await startServer(tokenResponder({ aiobs_u_a: {} }));
    const B = await startServer(tokenResponder({}));
    closers.push(A.close, B.close);
    const paths = tmpHome();
    writeTestServers(paths, [
      { endpoint: A.url, token: 'aiobs_u_a', expiresAt: new Date(Date.now() + 10 * DAY + 3600_000).toISOString() },
      { endpoint: B.url, token: 'aiobs_u_revoked' },
    ]);
    const repo = gitRepo();
    writeDotFile(repo, { server: 'https://obs.unknown.io', team: 'platform' });
    writeDotFile(repo, 'nope', true);
    const cc = fakeAdapter();
    cc.installs.push({});
    const c = capture();
    expect(await main(['doctor'], c.io, deps(paths, repo, { adapters: [cc] }))).toBe(1);
    const t = c.text();
    const hostA = new URL(A.url).host;
    const hostB = new URL(B.url).host;
    expect(t).toContain(`! ${hostA}: token expires in 10 days`);
    expect(t).toContain(`✓ ${hostA}: reachable, token valid (SPECTADO, dev@acme.com)`);
    expect(t).toContain(`✓ ${hostA}: teams: platform, spectado (primary spectado)`);
    expect(t).toContain(`✗ ${hostB}: token expired or revoked: run ai-obs login --server ${B.url}`);
    expect(t).toContain(`✗ repository: ${repo}/.ai-obs.local.json: not valid JSON (ignored): fix or delete it`);
    expect(t).toContain('✗ repository: server https://obs.unknown.io (from the dot file): this machine is not logged in to it');
    expect(t).toContain('hooks installed (user)');
  });

  it('a fresh collector-config updates the server entry (e-mail, deployment, expiry), as a send does', async () => {
    const exp = new Date(Date.now() + 80 * DAY).toISOString();
    const srv = await startServer(okResponder('plain', { expiresAt: exp, email: 'alice@spectado.io' }));
    closers.push(srv.close);
    const paths = tmpHome();
    writeTestConfig(paths, srv.url, { email: 'old@acme.com', cache: false });
    const cc = fakeAdapter();
    cc.installs.push({});
    await main(['doctor'], capture().io, deps(paths, paths.root, { adapters: [cc] }));
    expect(loadConfig(paths)!.servers[0]).toMatchObject({ email: 'alice@spectado.io', expires_at: exp, deployment: { slug: 'spectado' } });
  });

  it('an expired token is a failure even when the server is reachable', async () => {
    const srv = await startServer(okResponder());
    closers.push(srv.close);
    const paths = tmpHome();
    writeTestConfig(paths, srv.url, { expiresAt: new Date(Date.now() - DAY).toISOString() });
    const cc = fakeAdapter();
    cc.installs.push({});
    const c = capture();
    expect(await main(['doctor'], c.io, deps(paths, paths.root, { adapters: [cc] }))).toBe(1);
    expect(c.text()).toContain(`token expired on`);
    expect(c.text()).toContain(`run \`ai-obs login --server ${srv.url}\``);
  });
});

describe('flush / uninstall', () => {
  it('flush reports per server, what waits for a server, and exits 1 when a server refused', async () => {
    const A = await startServer(tokenResponder({ aiobs_u_a: {} }));
    const B = await startServer(tokenResponder({}));
    closers.push(A.close, B.close);
    const paths = tmpHome();
    writeTestServers(paths, [
      { endpoint: A.url, token: 'aiobs_u_a' },
      { endpoint: B.url, token: 'aiobs_u_revoked' },
    ]);
    one(paths, PK, A.url, 'platform');
    one(paths, 'github.com/b/web', B.url);
    one(paths, 'github.com/x/none', '');
    const c = capture();
    expect(await main(['flush'], c.io, deps(paths, paths.root, { adapters: [] }))).toBe(1);
    expect(c.text()).toContain(`sent 1 events to ${A.url} in 1 batch(es)`);
    expect(c.text()).toContain(`✗ ${B.url}: HTTP 401: token expired or revoked: run ai-obs login --server ${B.url}; 1 events stay queued`);
    expect(c.text()).toContain('! kept: 1 events of repositories without a server');
  });

  it('flush with nothing to send to: exit 0; uninstall --purge names tokens and queue and needs --yes while events wait', async () => {
    const paths = tmpHome();
    writeTestServers(paths, [{ endpoint: 'https://obs.a.io' }, { endpoint: 'https://obs.b.io' }]);
    one(paths, 'github.com/x/none', '');
    const f = capture();
    expect(await main(['flush'], f.io, deps(paths, paths.root, { adapters: [] }))).toBe(0);
    expect(f.text()).toContain('without a server');
    const cc = fakeAdapter();
    const u = capture();
    expect(await main(['uninstall', '--purge'], u.io, deps(paths, paths.root, { adapters: [cc] }))).toBe(1);
    expect(u.text()).toContain(`will delete ${paths.root}: tokens for https://obs.a.io, https://obs.b.io; queue of 1 unsent events (1 of them waiting for a server or a working token)`);
    expect(existsSync(paths.root)).toBe(true);
    expect(await main(['uninstall', '--purge', '--yes'], capture().io, deps(paths, paths.root, { adapters: [cc] }))).toBe(0);
    expect(existsSync(paths.root)).toBe(false);
  });
});
