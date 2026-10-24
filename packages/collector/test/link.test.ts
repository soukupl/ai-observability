import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { sessionEndEvent } from '../src/events.js';
import type { AiObsPaths } from '../src/paths.js';
import { cleanupHomes, gitRepo, okResponder, startServer, tmpHome, writeDotFile, writeTestConfig, writeTestServers } from './helpers.js';
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

async function server() {
  const srv = await startServer(okResponder('plain'));
  closers.push(srv.close);
  return srv;
}

const PK = 'github.com/acme/billing';
const deps = (paths: AiObsPaths, cwd: string, extra: Record<string, unknown> = {}) => ({
  paths,
  cwd,
  env: {},
  resolveProjectKey: async () => PK,
  spawnWorker: () => {},
  ...extra,
});
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('ai-obs link', () => {
  it('writes .ai-obs.json at the git top level (from a subdirectory), after checking the team on the server', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    const repo = gitRepo();
    const sub = join(repo, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    const c = capture();
    expect(await main(['link', '--team', 'platform'], c.io, deps(paths, sub))).toBe(0);
    expect(readFileSync(join(repo, '.ai-obs.json'), 'utf8')).toBe(`${JSON.stringify({ server: srv.url, team: 'platform' }, null, 2)}\n`);
    expect(existsSync(join(sub, '.ai-obs.json'))).toBe(false);
    expect(c.text()).toContain(`✓ team platform (Platform) on ${srv.url}`);
    expect(c.text()).toContain('commit .ai-obs.json');
    expect(srv.received.some((r) => r.url === '/api/v1/collector-config')).toBe(true);
  });

  it('--project-dir naming a subdirectory (as the SessionStart text may) still writes at the git top level', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    const repo = gitRepo();
    const sub = join(repo, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    const c = capture();
    expect(await main(['link', '--team', 'platform', '--project-dir', sub], c.io, deps(paths, '/'))).toBe(0);
    expect(existsSync(join(repo, '.ai-obs.json'))).toBe(true);
    expect(existsSync(join(sub, '.ai-obs.json'))).toBe(false);
  });

  it('refuses a team the user is not in (nothing written), listing the user’s teams', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    const repo = gitRepo();
    const c = capture();
    expect(await main(['link', '--team', 'mobile'], c.io, deps(paths, repo))).toBe(1);
    expect(c.text()).toContain(`team "mobile" is not one of your teams on ${srv.url} (platform, spectado)`);
    expect(existsSync(join(repo, '.ai-obs.json'))).toBe(false);
  });

  it('a server this machine is not logged in to: warns and writes anyway', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, 'https://obs.first.io');
    const repo = gitRepo();
    const c = capture();
    expect(await main(['link', '--team', 'mobile', '--server', 'https://Obs.Other.io/'], c.io, deps(paths, repo))).toBe(0);
    expect(read(join(repo, '.ai-obs.json'))).toEqual({ server: 'https://obs.other.io', team: 'mobile' });
    expect(c.text()).toContain('not logged in to https://obs.other.io: the team is not checked');
    expect(c.text()).toContain('ai-obs login --server https://obs.other.io');
  });

  it('an unreachable server: the team is checked against the cached answer', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, 'http://127.0.0.1:9');
    const repo = gitRepo();
    const c = capture();
    expect(await main(['link', '--team', 'spectado'], c.io, deps(paths, repo))).toBe(0);
    expect(c.text()).toContain('(from the cached server answer)');
  });

  it('--local writes .ai-obs.local.json and git-ignores it once; it overrides the committed file per key', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    const repo = gitRepo();
    writeFileSync(join(repo, '.gitignore'), 'node_modules');
    writeDotFile(repo, { server: srv.url, team: 'spectado' });
    const c = capture();
    expect(await main(['link', '--team', 'platform', '--local'], c.io, deps(paths, repo))).toBe(0);
    expect(read(join(repo, '.ai-obs.local.json'))).toEqual({ server: srv.url, team: 'platform' });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules\n.ai-obs.local.json\n');
    expect(await main(['link', '--team', 'platform', '--local'], capture().io, deps(paths, repo))).toBe(0);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules\n.ai-obs.local.json\n');
    expect(c.text()).not.toContain('commit');
    // a local file that overrides what `link` just wrote to the committed file says so
    const o = capture();
    expect(await main(['link', '--team', 'spectado'], o.io, deps(paths, repo))).toBe(0);
    expect(o.text()).toContain('.ai-obs.local.json overrides it here: sessions report to');
  });

  it('never puts a token in a dot file: refuses token-looking values, strips a token key, keeps unknown keys', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    const repo = gitRepo();
    const c = capture();
    expect(await main(['link', '--team', 'aiobs_u_secret'], c.io, deps(paths, repo))).toBe(2);
    expect(c.text()).toContain('tokens never go into a dot file');
    expect(existsSync(join(repo, '.ai-obs.json'))).toBe(false);
    writeDotFile(repo, { token: 'aiobs_u_leaked', note: 'keep me', other: 'aiobs_u_x2' });
    const s = capture();
    expect(await main(['link', '--team', 'platform'], s.io, deps(paths, repo))).toBe(0);
    expect(read(join(repo, '.ai-obs.json'))).toEqual({ note: 'keep me', server: srv.url, team: 'platform' });
    expect(s.text()).toContain('removed "token"');
    expect(readFileSync(join(repo, '.ai-obs.json'), 'utf8')).not.toContain('aiobs_');
  });

  it('the server: --server, else the dot file’s, else the only registered one; with several it is required', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestServers(paths, [{ endpoint: srv.url }, { endpoint: 'https://obs.other.io' }]);
    const repo = gitRepo();
    const c = capture();
    expect(await main(['link', '--team', 'platform'], c.io, deps(paths, repo))).toBe(2);
    expect(c.text()).toContain('--server is required: 2 servers are registered');
    writeDotFile(repo, { server: srv.url, team: 'spectado' });
    expect(await main(['link', '--team', 'platform'], capture().io, deps(paths, repo))).toBe(0);
    expect(read(join(repo, '.ai-obs.json'))).toEqual({ server: srv.url, team: 'platform' });
    expect(await main(['link'], capture().io, deps(paths, repo))).toBe(2); // --team is required
    expect(await main(['link', '--team', 'Bad Slug'], capture().io, deps(paths, repo))).toBe(2);
  });

  it('outside a git repository it refuses (unless --project-dir)', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    mkdirSync(paths.root, { recursive: true });
    const c = capture();
    expect(await main(['link', '--team', 'platform', '--server', 'https://obs.x.io'], c.io, deps(paths, paths.root))).toBe(1);
    expect(c.text()).toContain('not inside a git repository');
  });

  it('events this repository recorded while no server was chosen go to the linked server', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestServers(paths, [{ endpoint: srv.url }, { endpoint: 'https://obs.other.io' }]);
    const repo = gitRepo();
    enqueueFor(queueStore(paths), PK, '', [sessionEndEvent({ harness: 'codex', sessionId: 's', reason: 'exit', at: 0 })]);
    let spawned = 0;
    const c = capture();
    expect(await main(['link', '--team', 'platform', '--server', srv.url], c.io, deps(paths, repo, { spawnWorker: () => void spawned++ }))).toBe(0);
    expect(c.text()).toContain(`✓ 1 queued events of this repository recorded without a server now go to ${srv.url}`);
    expect(spawned).toBe(1);
    expect(queueStore(paths).streams()).toEqual([expect.objectContaining({ pk: PK, endpoint: srv.url, team: 'platform' })]);
  });
});
