import { createHash, createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPathSecret, normalizeRemote, projectRef } from '../src/project-key.js';
import { cleanupHomes, tmpHome } from './helpers.js';

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

describe('projectRef', () => {
  const absPath = '/Users/dev/secret-project';

  it('plain mode: normalized remote + name', () => {
    expect(projectRef({ remote: 'git@github.com:acme/billing.git', absPath, naming: 'plain' })).toEqual({
      key: 'github.com/acme/billing',
      name: 'billing',
    });
  });

  it('hashed mode: sha256 of the normalized remote, no name', () => {
    const a = projectRef({ remote: 'git@github.com:acme/billing.git', absPath, naming: 'hashed' });
    const b = projectRef({ remote: 'https://github.com/acme/billing', absPath: '/elsewhere', naming: 'hashed' });
    expect(a.key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).toEqual(b); // same repo, different clone URL / path → same key
    expect(a.name).toBeUndefined();
  });

  it('no remote: hash of the path in both modes, never the path', () => {
    for (const naming of ['plain', 'hashed'] as const) {
      const r = projectRef({ remote: null, absPath, naming });
      expect(r.key).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(r)).not.toContain('secret-project');
    }
    expect(projectRef({ remote: '/local/path/repo', absPath, naming: 'plain' }).key).toMatch(/^sha256:/);
  });
});

describe('projectRef: keyed hashes (SEC-11)', () => {
  const absPath = '/Users/alice/src/secret-project';
  const secret = 'a'.repeat(64);
  const sha = (x: string) => createHash('sha256').update(x).digest('hex');
  const hmac = (k: string, x: string) => createHmac('sha256', k).update(x).digest('hex');

  it('no remote: HMAC of the path under the local secret, not a dictionary-reversible sha256', () => {
    for (const naming of ['plain', 'hashed'] as const) {
      const r = projectRef({ remote: null, absPath, naming, pathSecret: secret });
      expect(r.key).toBe(`sha256:${hmac(secret, `path:${absPath}`)}`);
      expect(r.key).not.toBe(`sha256:${sha(`path:${absPath}`)}`); // what a home-directory dictionary would hit
    }
    const other = projectRef({ remote: null, absPath, naming: 'hashed', pathSecret: 'b'.repeat(64) });
    expect(other.key).not.toBe(projectRef({ remote: null, absPath, naming: 'hashed', pathSecret: secret }).key);
    // stable on the same machine
    expect(projectRef({ remote: null, absPath, naming: 'hashed', pathSecret: secret })).toEqual(projectRef({ remote: null, absPath, naming: 'hashed', pathSecret: secret }));
  });

  it('hashed mode with a company salt: HMAC of the normalized remote, still equal across clone URLs', () => {
    const salt = 'company-salt-0123456789';
    const a = projectRef({ remote: 'git@github.com:acme/billing.git', absPath, naming: 'hashed', projectSalt: salt });
    const b = projectRef({ remote: 'https://github.com/acme/billing', absPath: '/elsewhere', naming: 'hashed', projectSalt: salt, pathSecret: secret });
    expect(a.key).toBe(`sha256:${hmac(salt, 'github.com/acme/billing')}`);
    expect(a).toEqual(b); // the path secret plays no part for remotes: every machine agrees
    expect(a.key).not.toBe(`sha256:${sha('github.com/acme/billing')}`);
    expect(projectRef({ remote: 'git@github.com:acme/billing.git', absPath, naming: 'hashed' }).key).toBe(`sha256:${sha('github.com/acme/billing')}`); // no salt from the server: unchanged
  });

  it('plain mode ignores the salt', () => {
    expect(projectRef({ remote: 'git@github.com:acme/billing.git', absPath, naming: 'plain', projectSalt: 'x'.repeat(20) })).toEqual({ key: 'github.com/acme/billing', name: 'billing' });
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
