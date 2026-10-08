import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGitBounded } from '../src/git.js';
import { cachedPk, PK_CACHE_MAX, readPkCache, recentKeys, rememberPk } from '../src/pk-cache.js';
import { isPathKey, loadPathSecret, localRef, normalizeRemote, resolveProjectKey, sendRef } from '../src/project-key.js';
import { cleanupHomes, gitRepo, tmpHome } from './helpers.js';

afterEach(cleanupHomes);

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:acme/billing.git', 'github.com/acme/billing'],
    ['git@GitHub.com:Acme/Billing.git', 'github.com/Acme/Billing'],
    ['https://github.com/acme/billing.git', 'github.com/acme/billing'],
    ['https://github.com/acme/billing', 'github.com/acme/billing'],
    ['https://github.com/acme/billing/', 'github.com/acme/billing'],
    ['https://user:s3cret@github.com/acme/billing.git', 'github.com/acme/billing'],
    ['https://oauth2:glpat-xyz@gitlab.example.com:8443/group/sub/repo.git', 'gitlab.example.com/group/sub/repo'],
    ['ssh://git@github.com:22/acme/billing.git', 'github.com/acme/billing'],
    ['ssh://git@github.com/acme/billing.git', 'github.com/acme/billing'],
    ['ssh://git@bitbucket.org:acme/billing.git', 'bitbucket.org/acme/billing'],
    ['git://example.org/proj.git', 'example.org/proj'],
    ['git+ssh://git@github.com/acme/billing.git', 'github.com/acme/billing'],
    ['http://HOST.example.com/a/b.GIT', 'host.example.com/a/b'],
    ['org-123@ssh.dev.azure.com:v3/org/proj/repo', 'ssh.dev.azure.com/v3/org/proj/repo'],
    ['  git@github.com:acme/billing.git\n', 'github.com/acme/billing'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRemote(input)).toBe(expected);
  });

  it.each([
    ['/Users/dev/repos/billing'],
    ['../billing'],
    ['file:///Users/dev/repos/billing.git'],
    ['C:\\repos\\billing'],
    ['C:/repos/billing'],
    [''],
    ['https://github.com'],
  ])('rejects local / unusable remote %j', (input) => {
    expect(normalizeRemote(input)).toBeNull();
  });
});

describe('sendRef', () => {
  const absPath = '/Users/dev/secret-project';

  it('plain mode: the key + its last segment as name', () => {
    expect(sendRef('github.com/acme/billing', { naming: 'plain', pathSecret: null })).toEqual({ key: 'github.com/acme/billing', name: 'billing' });
  });

  it('hashed mode: sha256 of the key, no name', () => {
    const a = sendRef('github.com/acme/billing', { naming: 'hashed', pathSecret: null });
    expect(a.key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.name).toBeUndefined();
  });

  it('path key: hash of the path in both modes, never the path', () => {
    for (const naming of ['plain', 'hashed'] as const) {
      const r = sendRef(absPath, { naming, pathSecret: null });
      expect(r.key).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(r)).not.toContain('secret-project');
    }
    expect(isPathKey(absPath)).toBe(true);
    expect(isPathKey('github.com/acme/billing')).toBe(false);
  });

  it('localRef = the plain send ref (the sender overwrites it per receiving token)', () => {
    expect(localRef('github.com/acme/billing', null)).toEqual({ key: 'github.com/acme/billing', name: 'billing' });
    expect(localRef(absPath, 'a'.repeat(64)).key).toBe(sendRef(absPath, { naming: 'hashed', pathSecret: 'a'.repeat(64) }).key);
  });
});

describe('sendRef: keyed hashes (SEC-11, per receiving token)', () => {
  const absPath = '/Users/alice/src/secret-project';
  const secret = 'a'.repeat(64);
  const sha = (x: string) => createHash('sha256').update(x).digest('hex');
  const hmac = (k: string, x: string) => createHmac('sha256', k).update(x).digest('hex');

  it('path key: HMAC of the path under the local secret, whatever the company salt', () => {
    for (const naming of ['plain', 'hashed'] as const) {
      const r = sendRef(absPath, { naming, pathSecret: secret, salt: 'company-salt-0123456789' });
      expect(r.key).toBe(`sha256:${hmac(secret, `path:${absPath}`)}`);
      expect(r.key).not.toBe(`sha256:${sha(`path:${absPath}`)}`); // what a home-directory dictionary would hit
    }
    expect(sendRef(absPath, { naming: 'hashed', pathSecret: 'b'.repeat(64) }).key).not.toBe(sendRef(absPath, { naming: 'hashed', pathSecret: secret }).key);
  });

  it('hashed remote: HMAC under the receiving company salt; two companies get two keys', () => {
    const sa = 'company-a-salt-0123456789';
    const sb = 'company-b-salt-0123456789';
    const a = sendRef('github.com/acme/billing', { naming: 'hashed', salt: sa, pathSecret: secret });
    const b = sendRef('github.com/acme/billing', { naming: 'hashed', salt: sb, pathSecret: secret });
    expect(a.key).toBe(`sha256:${hmac(sa, 'github.com/acme/billing')}`);
    expect(b.key).toBe(`sha256:${hmac(sb, 'github.com/acme/billing')}`);
    expect(a.key).not.toBe(b.key);
    expect(sendRef('github.com/acme/billing', { naming: 'hashed', pathSecret: null }).key).toBe(`sha256:${sha('github.com/acme/billing')}`); // no salt: plain sha256
  });

  it('plain mode ignores the salt', () => {
    expect(sendRef('github.com/acme/billing', { naming: 'plain', salt: 'x'.repeat(20), pathSecret: secret })).toEqual({ key: 'github.com/acme/billing', name: 'billing' });
  });
});

describe('resolveProjectKey (Q4, C2)', () => {
  it('normalized remote: ssh and https clones give the same key, also from a subdirectory', async () => {
    const ssh = gitRepo({ remote: 'git@github.com:acme/billing.git' });
    const https = gitRepo({ remote: 'https://github.com/acme/billing' });
    mkdirSync(join(ssh, 'src', 'deep'), { recursive: true });
    expect(await resolveProjectKey(ssh)).toBe('github.com/acme/billing');
    expect(await resolveProjectKey(https)).toBe('github.com/acme/billing');
    expect(await resolveProjectKey(join(ssh, 'src', 'deep'))).toBe('github.com/acme/billing');
    expect(await resolveProjectKey(ssh, { timeoutMs: 2000, bounded: true })).toBe('github.com/acme/billing');
  });

  it('no (usable) remote: the git top-level, also from a subdirectory', async () => {
    const repo = gitRepo();
    mkdirSync(join(repo, 'pkg'));
    expect(await resolveProjectKey(repo)).toBe(repo);
    expect(await resolveProjectKey(join(repo, 'pkg'))).toBe(repo);
    const local = gitRepo({ remote: '/srv/git/billing.git' });
    expect(await resolveProjectKey(local)).toBe(local);
  });

  it('no remote, linked worktrees: every worktree has the main checkout\'s key (one choice per repository)', async () => {
    const repo = gitRepo();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-qm', 'init');
    const inside = join(repo, '.claude', 'worktrees', 'feat');
    const outside = `${repo}-wt`;
    git('worktree', 'add', '-q', inside);
    git('worktree', 'add', '-q', outside);
    try {
      mkdirSync(join(outside, 'pkg'));
      expect(await resolveProjectKey(inside)).toBe(repo);
      expect(await resolveProjectKey(join(outside, 'pkg'))).toBe(repo);
      expect(await resolveProjectKey(outside, { timeoutMs: 2000, bounded: true })).toBe(repo);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('outside a repo: realpath of the cwd; a missing directory: the resolved path', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ai-obs-norepo-')));
    try {
      expect(await resolveProjectKey(dir)).toBe(dir);
      expect(await resolveProjectKey(join(dir, 'gone', '..', 'gone2'))).toBe(join(dir, 'gone2'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('with a git that hangs', () => {
    const origPath = process.env.PATH;
    let bin = '';
    beforeEach(() => {
      bin = realpathSync(mkdtempSync(join(tmpdir(), 'ai-obs-fakegit-')));
    });
    afterEach(() => {
      process.env.PATH = origPath;
      rmSync(bin, { recursive: true, force: true });
    });
    const fakeGit = (script: string) => {
      writeFileSync(join(bin, 'git'), `#!/bin/sh\n${script}\n`);
      chmodSync(join(bin, 'git'), 0o755);
      process.env.PATH = `${bin}:${origPath}`;
    };

    it('timeout → null (worker path)', async () => {
      fakeGit('exec sleep 2');
      const t = Date.now();
      expect(await resolveProjectKey(bin, { timeoutMs: 100 })).toBeNull();
      expect(Date.now() - t).toBeLessThan(1500);
    });

    it('runGitBounded returns at the deadline even when git ignores SIGTERM and its child keeps the pipe (C26)', async () => {
      fakeGit("trap '' TERM\nsleep 2");
      const deadline = 60;
      const t = performance.now();
      const r = await runGitBounded(['rev-parse', '--show-toplevel'], bin, deadline);
      const took = performance.now() - t;
      expect(r).toEqual({ out: null, timedOut: true });
      expect(took).toBeLessThan(deadline + 60); // ~deadline in isolation; headroom for a loaded test run (the git sleeps 2 s)
      const t2 = performance.now();
      expect(await resolveProjectKey(bin, { timeoutMs: 40, bounded: true })).toBeNull();
      expect(performance.now() - t2).toBeLessThan(40 + 60);
    });

    it('runGitBounded returns output and failures normally', async () => {
      fakeGit('echo "  hello  "');
      expect(await runGitBounded(['x'], bin, 2000)).toEqual({ out: 'hello', timedOut: false });
      fakeGit('exit 3');
      expect(await runGitBounded(['x'], bin, 2000)).toEqual({ out: null, timedOut: false });
      expect(await runGitBounded(['x'], bin, 0)).toEqual({ out: null, timedOut: true });
    });
  });
});

describe('project key cache (pk-cache)', () => {
  it('remembers cwd → key (0600), skips fresh duplicates, keeps the 500 most recent', () => {
    const paths = tmpHome();
    expect(readPkCache(paths)).toEqual({});
    rememberPk(paths, '/repo/a', 'github.com/acme/a', 1000);
    expect(statSync(paths.projectKeyCache).mode & 0o777).toBe(0o600);
    expect(readPkCache(paths)['/repo/a']).toMatchObject({ pk: 'github.com/acme/a', at: 1000 });
    rememberPk(paths, '/repo/a', 'github.com/acme/a', 2000); // fresh hit: not rewritten
    expect(readPkCache(paths)['/repo/a']?.at).toBe(1000);
    rememberPk(paths, '/repo/a', 'github.com/acme/a2', 3000); // changed key: rewritten
    expect(readPkCache(paths)['/repo/a']).toMatchObject({ pk: 'github.com/acme/a2', at: 3000 });
    for (let i = 0; i < PK_CACHE_MAX + 5; i++) rememberPk(paths, `/repo/n${i}`, `k${i}`, 10_000 + i);
    const cache = readPkCache(paths);
    expect(Object.keys(cache)).toHaveLength(PK_CACHE_MAX);
    expect(cache['/repo/a']).toBeUndefined(); // least recent dropped
    expect(cache[`/repo/n${PK_CACHE_MAX + 4}`]?.pk).toBe(`k${PK_CACHE_MAX + 4}`);
  });

  it('cachedPk: a hit only while the directory is the same repository (set-url, re-clone, git init → miss)', () => {
    const paths = tmpHome();
    const repo = gitRepo({ remote: 'git@github.com:acme/x.git' });
    const sub = join(repo, 'src');
    mkdirSync(sub);
    rememberPk(paths, sub, 'github.com/acme/x');
    expect(cachedPk(readPkCache(paths), sub)).toBe('github.com/acme/x');
    execFileSync('git', ['remote', 'set-url', 'origin', 'git@github.com:globex/y.git'], { cwd: repo });
    expect(cachedPk(readPkCache(paths), sub)).toBeNull();

    rememberPk(paths, sub, 'github.com/globex/y');
    expect(cachedPk(readPkCache(paths), sub)).toBe('github.com/globex/y');
    rmSync(join(repo, '.git'), { recursive: true, force: true }); // re-cloned in place
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:globex/y.git'], { cwd: repo });
    expect(cachedPk(readPkCache(paths), sub)).toBeNull();

    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'ai-obs-norepo-')));
    try {
      rememberPk(paths, plain, plain);
      expect(cachedPk(readPkCache(paths), plain)).toBe(plain);
      execFileSync('git', ['init', '-q'], { cwd: plain });
      expect(cachedPk(readPkCache(paths), plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    // an entry written without a stamp (older collector) is not trusted
    writeFileSync(paths.projectKeyCache, JSON.stringify({ [sub]: { pk: 'github.com/acme/x', at: 1 } }));
    expect(cachedPk(readPkCache(paths), sub)).toBeNull();
  });

  it('recentKeys: distinct keys since a timestamp, newest first; garbage reads as empty', () => {
    const paths = tmpHome();
    rememberPk(paths, '/a', 'k1', 100);
    rememberPk(paths, '/b', 'k2', 300);
    rememberPk(paths, '/c', 'k1', 200);
    expect(recentKeys(paths, 150)).toEqual(['k2', 'k1']);
    expect(recentKeys(paths, 1000)).toEqual([]);
    writeFileSync(paths.projectKeyCache, 'nope');
    expect(readPkCache(paths)).toEqual({});
  });
});

describe('loadPathSecret', () => {
  it('creates a random 0600 secret once and returns the same value afterwards', () => {
    const file = join(tmpHome().root, 'project-secret');
    const a = loadPathSecret(file);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadPathSecret(file)).toBe(a);
    expect(readFileSync(file, 'utf8').trim()).toBe(a);
    expect(loadPathSecret(join(tmpHome().root, 'project-secret'))).not.toBe(a); // per machine
  });

  it('returns null when the secret cannot be created', () => {
    expect(loadPathSecret('/dev/null/nope/project-secret')).toBeNull();
  });
});
