import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hookCommandFactory, isAiObsHookCommand, shellQuote } from '../src/adapters/hook-command.js';
import { COMMANDS, extractHome, main } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { sessionEndEvent } from '../src/events.js';
import { aiObsPaths, type AiObsPaths } from '../src/paths.js';
import { cleanupHomes, fakeAdapter, okResponder, startServer, tmpHome, writeTestConfig } from './helpers.js';
import { enqueueFor, queueStore } from './queue-helpers.js';

const bin = fileURLToPath(new URL('../bin/ai-obs.js', import.meta.url));
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  cleanupHomes();
});

function capture() {
  const lines: string[] = [];
  return { lines, text: () => lines.join('\n'), io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
}

const fakeRuntime = (paths: AiObsPaths) => ({ entry: `${paths.app}/bin/ai-obs.js`, node: '/usr/bin/node', copied: false });
const resolveProjectKey = async () => 'github.com/acme/billing';

/** One event in the stream of github.com/acme/billing for the test server (writeTestConfig). */
function enqueueOne(paths: AiObsPaths, endpoint = 'http://127.0.0.1:9') {
  enqueueFor(queueStore(paths), 'github.com/acme/billing', endpoint, [
    sessionEndEvent({ harness: 'codex', sessionId: 's', reason: 'exit', at: 0 }),
  ]);
}

async function server(naming: 'plain' | 'hashed' = 'plain', status?: number) {
  const srv = await startServer((req, n) => (status ? { status } : okResponder(naming)(req)));
  closers.push(srv.close);
  return srv;
}

describe('ai-obs cli', () => {
  it('exits 0 immediately with no output when AI_OBS_SUMMARIZING is set', () => {
    const res = spawnSync(process.execPath, [bin, 'hook', 'claude-code', 'Stop'], {
      env: { ...process.env, AI_OBS_SUMMARIZING: '1' },
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout + res.stderr).toBe('');
  });

  it('prints usage, rejects unknown commands and bad flags', async () => {
    const c = capture();
    expect(await main([], c.io)).toBe(1);
    expect(c.text()).toContain('Usage: ai-obs');
    const help = capture();
    expect(await main(['--help'], help.io)).toBe(0);
    expect(help.text()).toContain('live [--cwd] [--once]');
    expect(await main(['bogus'], capture().io)).toBe(2);
    const paths = tmpHome();
    expect(await main(['status', '--nope'], capture().io, { paths })).toBe(2);
    expect(COMMANDS).toContain('hook');
    expect(COMMANDS).toContain('token');
    expect(COMMANDS).toEqual(expect.arrayContaining(['login', 'link', 'live']));
    expect(COMMANDS).not.toContain('use');
    expect(help.text()).not.toMatch(/\buse <name>|token confirm|token add/);
  });

  it('extracts --home from anywhere in argv', () => {
    expect(extractHome(['hook', 'codex', 'stop', '--home', '/h'])).toEqual({ home: '/h', rest: ['hook', 'codex', 'stop'] });
    expect(extractHome(['--home=/x', 'status'])).toEqual({ home: '/x', rest: ['status'] });
    expect(extractHome(['status'])).toEqual({ home: undefined, rest: ['status'] });
  });

  describe('init', () => {
    it('validates the token and the flags; nothing is written for a bad token', async () => {
      const paths = tmpHome();
      const env = {};
      const c = capture();
      expect(await main(['init', '--endpoint', 'https://x.io'], c.io, { paths, env })).toBe(2);
      expect(c.text()).toContain('--endpoint and --label need --token');
      expect(await main(['init', '--token', 'aiobs_u_x'], capture().io, { paths, env })).toBe(2); // no server known
      const bad = capture();
      expect(await main(['init', '--token', 'sk-123', '--endpoint', 'https://x.io'], bad.io, { paths, env })).toBe(2);
      expect(bad.text()).toContain('aiobs_u_');
      for (const old of ['aiobs_t_old', 'aiobs_c_old']) {
        const legacy = capture();
        expect(await main(['init', '--token', old, '--endpoint', 'https://x.io'], legacy.io, { paths, env })).toBe(2);
        expect(legacy.text()).toContain('no longer exist');
      }
      expect(existsSync(paths.config)).toBe(false);
      expect(await main(['init', '--token', 'aiobs_u_x', '--endpoint', 'ftp://x'], capture().io, { paths, env })).toBe(2);
    });

    it('without a server it installs the hooks and says to log in', async () => {
      const paths = tmpHome();
      const cc = fakeAdapter();
      const c = capture();
      expect(await main(['init'], c.io, { paths, adapters: [cc], installRuntime: fakeRuntime, env: {} })).toBe(0);
      expect(cc.installs).toHaveLength(1);
      expect(c.text()).toContain('not logged in to any ai-obs server yet');
      expect(c.text()).toContain('ai-obs login --server <url>');
    });

    it('--token --endpoint logs in (config v3, 0600), installs hooks for detected harnesses and fetches collector-config', async () => {
      const exp = '2027-01-22T10:00:00.000Z';
      const srv = await startServer(okResponder('hashed', { expiresAt: exp }));
      closers.push(srv.close);
      const paths = tmpHome();
      const cc = fakeAdapter();
      const codex = fakeAdapter({
        name: 'codex',
        displayName: 'Fake Codex',
        async detect() {
          return { installed: false, version: null, versionSupported: null, hooksInstalled: { user: false, project: null } };
        },
      });
      const c = capture();
      const code = await main(['init', '--token', 'aiobs_u_abc', '--endpoint', `${srv.url}/`], c.io, { paths, adapters: [cc, codex], installRuntime: fakeRuntime, env: {} });
      expect(code).toBe(0);
      const config = loadConfig(paths)!;
      expect(config.servers).toEqual([
        { endpoint: srv.url, token: 'aiobs_u_abc', email: 'dev@acme.com', deployment: { name: 'SPECTADO', slug: 'spectado' }, label: 'test-mac', expires_at: exp, source: 'device', added_at: expect.any(String) },
      ]);
      expect(statSync(paths.config).mode & 0o777).toBe(0o600);
      expect(cc.installs).toHaveLength(1);
      expect(codex.installs).toHaveLength(0);
      const opts = cc.installs[0] as { scope: string; hookCommand: (h: string) => { argv: string[] } };
      expect(opts.scope).toBe('user');
      expect(opts.hookCommand('Stop').argv).toEqual(['/usr/bin/node', `${paths.app}/bin/ai-obs.js`, 'hook', 'claude-code', 'Stop', '--home', paths.root]);
      expect(c.text()).toContain('project naming: hashed');
      expect(c.text()).toContain('Fake Codex: not found');
      expect(c.text()).not.toContain('→ run `ai-obs init`');

      // re-running init with another token keeps the machine id and replaces the token of that server
      await main(['init', '--token', 'aiobs_u_new', '--endpoint', srv.url], capture().io, { paths, adapters: [cc], installRuntime: fakeRuntime, env: {} });
      const again = loadConfig(paths)!;
      expect(again.machine_id).toBe(config.machine_id);
      expect(again.servers.map((s) => s.token)).toEqual(['aiobs_u_new']);
    });

    it('--project installs project-scope hooks', async () => {
      const srv = await server();
      const paths = tmpHome();
      const cc = fakeAdapter();
      await main(['init', '--token', 'aiobs_u_abc', '--endpoint', srv.url, '--project', '--project-dir', '/work/repo'], capture().io, { paths, adapters: [cc], installRuntime: fakeRuntime, env: {} });
      expect(cc.installs[0]).toMatchObject({ scope: 'project', projectDir: '/work/repo' });
    });

    it('aborts without changes when the server rejects the token', async () => {
      const srv = await server('plain', 401);
      const paths = tmpHome();
      const cc = fakeAdapter();
      const c = capture();
      expect(await main(['init', '--token', 'aiobs_u_bad', '--endpoint', srv.url], c.io, { paths, adapters: [cc], installRuntime: fakeRuntime, env: {} })).toBe(1);
      expect(c.text()).toContain('rejected token');
      expect(existsSync(paths.config)).toBe(false);
      expect(cc.installs).toHaveLength(0);
    });

    it('works offline: the token is stored unchecked and nothing is sent until the server answers', async () => {
      const paths = tmpHome();
      const c = capture();
      expect(await main(['init', '--token', 'aiobs_u_abc', '--endpoint', 'http://127.0.0.1:9'], c.io, { paths, adapters: [fakeAdapter()], installRuntime: fakeRuntime, env: {} })).toBe(0);
      expect(c.text()).toContain('could not check the token now');
      // unchecked: no source yet, so it reads "not checked yet", never "service user" (source comes with collector-config)
      expect(loadConfig(paths)!.servers[0]).toMatchObject({ endpoint: 'http://127.0.0.1:9', token: 'aiobs_u_abc', deployment: null, email: null, source: null });
      expect(c.text()).toContain('✓ logged in to http://127.0.0.1:9: (not checked yet)');
      expect(c.text()).not.toContain('service user');
    });
  });

  it('doctor reports green with a reachable server and installed hooks, red otherwise', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    const cc = fakeAdapter();
    cc.installs.push({});
    const c = capture();
    expect(await main(['doctor'], c.io, { paths, adapters: [cc], env: {}, resolveProjectKey })).toBe(0);
    expect(c.text()).toContain('reachable, token valid (SPECTADO, dev@acme.com)');
    expect(c.text()).toContain('hooks installed (user)');

    const offline = tmpHome();
    writeTestConfig(offline);
    const d = capture();
    expect(await main(['doctor'], d.io, { paths: offline, adapters: [fakeAdapter()], env: {}, resolveProjectKey })).toBe(1);
    expect(d.text()).toContain('✗ 127.0.0.1:9: unreachable');
    expect(d.text()).toContain('hooks NOT installed');
    expect(await main(['doctor'], capture().io, { paths: tmpHome(), env: {} })).toBe(1);
  });

  it('status and flush', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    enqueueOne(paths, srv.url);
    const s = capture();
    expect(await main(['status'], s.io, { paths, env: {}, resolveProjectKey })).toBe(0);
    expect(s.text()).toMatch(/queue\s+1 events/);
    const f = capture();
    expect(await main(['flush'], f.io, { paths, env: {} })).toBe(0);
    expect(f.text()).toContain('sent 1 events');
    expect(await main(['flush'], capture().io, { paths, env: {} })).toBe(0);
    expect(await main(['status'], capture().io, { paths: tmpHome(), env: {}, resolveProjectKey })).toBe(1);
  });

  it('flush fails (exit 1) and keeps events when the server is down', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    enqueueOne(paths);
    const f = capture();
    expect(await main(['flush'], f.io, { paths, env: {} })).toBe(1);
    expect(f.text()).toContain('1 events stay queued');
  });

  it('uninstall removes hooks; --purge removes the home', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    const cc = fakeAdapter();
    expect(await main(['uninstall', '--project-dir', '/work/repo'], capture().io, { paths, adapters: [cc] })).toBe(0);
    expect(cc.uninstalls).toEqual([{ scope: 'user' }, { scope: 'project', projectDir: '/work/repo' }]);
    expect(existsSync(paths.config)).toBe(true);
    expect(await main(['uninstall', '--purge'], capture().io, { paths, adapters: [cc] })).toBe(0);
    expect(existsSync(paths.root)).toBe(false);
  });

  it('hook commands are quoted and recognizable', () => {
    const make = hookCommandFactory({ node: '/opt/node 22/bin/node', entry: '/h/.ai-obs/app/bin/ai-obs.js', harness: 'codex' });
    const cmd = make('stop');
    expect(cmd.shell).toBe("'/opt/node 22/bin/node' /h/.ai-obs/app/bin/ai-obs.js hook codex stop");
    expect(isAiObsHookCommand(cmd.shell)).toBe(true);
    expect(isAiObsHookCommand(cmd.argv)).toBe(true);
    expect(isAiObsHookCommand('npm test')).toBe(false);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('keeps local files under ~/.ai-obs', () => {
    const p = aiObsPaths('/h/.ai-obs');
    expect([p.config, p.state, p.queue]).toEqual(['/h/.ai-obs/config.json', '/h/.ai-obs/state', '/h/.ai-obs/queue']);
    expect([p.collectorConfigDir, p.dotFileCache, p.queueProjects]).toEqual([
      '/h/.ai-obs/state/collector-config',
      '/h/.ai-obs/state/dot-files.json',
      '/h/.ai-obs/queue/p',
    ]);
  });
});
