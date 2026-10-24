import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dotFileProblems, lookupDotFile, parseDotFile } from '../src/dotfile.js';
import { cleanupHomes, gitRepo, tmpHome, writeDotFile } from './helpers.js';

afterEach(cleanupHomes);

describe('parseDotFile', () => {
  it('normalizes the server, checks the team slug and ignores unknown keys', () => {
    expect(parseDotFile('{"server":"https://Obs.Example.com/","team":"platform","x":1}')).toEqual({ ok: true, value: { server: 'https://obs.example.com', team: 'platform' } });
    expect(parseDotFile('{}')).toEqual({ ok: true, value: {} });
    expect(parseDotFile('nope')).toMatchObject({ ok: false, error: 'not valid JSON' });
    expect(parseDotFile('[]')).toMatchObject({ ok: false });
    expect(parseDotFile('{"server":"ftp://x"}')).toMatchObject({ ok: false });
    expect(parseDotFile('{"server":"https://u:p@x.io"}')).toMatchObject({ ok: false });
    expect(parseDotFile('{"team":"Bad Team"}')).toMatchObject({ ok: false });
    expect(parseDotFile('{"team":7}')).toMatchObject({ ok: false });
    expect(parseDotFile(JSON.stringify({ server: `https://x.io/${'a'.repeat(600)}` }))).toMatchObject({ ok: false, error: '"server" is longer than 512 characters' });
  });
});

describe('lookupDotFile', () => {
  it('walks up to the directory holding .git; the first directory with a file wins; local overrides per key', () => {
    const repo = gitRepo();
    const sub = join(repo, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    expect(lookupDotFile(sub)).toMatchObject({ root: repo, dir: null });
    writeDotFile(repo, { server: 'https://obs.example.com', team: 'platform' });
    expect(lookupDotFile(sub)).toMatchObject({ root: repo, dir: repo, server: 'https://obs.example.com', team: 'platform' });
    writeDotFile(repo, { team: 'mobile' }, true);
    expect(lookupDotFile(sub)).toMatchObject({ server: 'https://obs.example.com', team: 'mobile' });
    // a monorepo package with its own file: first hit wins (its committed file only)
    writeDotFile(sub, { team: 'web' });
    expect(lookupDotFile(sub)).toMatchObject({ dir: sub, team: 'web' });
    expect(lookupDotFile(sub).server).toBeUndefined();
  });

  it('never reads above the repository, and nothing outside one', () => {
    const outer = gitRepo();
    writeDotFile(outer, { server: 'https://outer.io', team: 'outer' });
    const inner = join(outer, 'vendor', 'lib');
    mkdirSync(join(inner, '.git'), { recursive: true });
    expect(lookupDotFile(inner)).toMatchObject({ root: inner, dir: null });
    expect(lookupDotFile(inner).server).toBeUndefined();
    const plain = tmpHome().root;
    mkdirSync(plain, { recursive: true });
    expect(lookupDotFile(plain).root).toBeNull();
  });

  it('a file holding a token is still read, but reported', () => {
    const repo = gitRepo();
    writeDotFile(repo, { server: 'https://ok.io', team: 'mobile', token: 'aiobs_u_secretsecret' });
    writeDotFile(repo, { team: 'web', note: 'aiobs_c_oldcompany1' }, true);
    const l = lookupDotFile(repo);
    expect(l).toMatchObject({ server: 'https://ok.io', team: 'web' });
    expect(dotFileProblems(l)).toEqual([
      expect.stringContaining('.ai-obs.json contains an ai-obs token: remove it'),
      expect.stringContaining('.ai-obs.local.json contains an ai-obs token: remove it'),
    ]);
    expect(dotFileProblems(l).join('\n')).not.toContain('secretsecret');
  });

  it('a malformed file counts as absent and is reported', () => {
    const repo = gitRepo();
    writeDotFile(repo, '{"server": "https://ok.io", "team": "Not A Slug"}');
    writeDotFile(repo, { team: 'mobile' }, true);
    const l = lookupDotFile(repo);
    expect(l).toMatchObject({ team: 'mobile' });
    expect(l.server).toBeUndefined();
    expect(l.committed).toMatchObject({ status: 'malformed' });
    expect(dotFileProblems(l)).toEqual([expect.stringContaining('.ai-obs.json: "team" must be')]);
  });

  it('cache: reused while nothing changed; a created, edited or deleted file is seen at once', () => {
    const paths = tmpHome();
    const repo = gitRepo();
    const sub = join(repo, 'src');
    mkdirSync(sub);
    expect(lookupDotFile(sub, { cache: paths, write: true }).dir).toBeNull();
    // a cached entry is used as long as its stamps hold (the hook only reads)
    const cache = JSON.parse(readFileSync(paths.dotFileCache, 'utf8'));
    expect(Object.keys(cache)).toEqual([sub]);
    const file = writeDotFile(repo, { server: 'https://obs.example.com', team: 'a' });
    expect(lookupDotFile(sub, { cache: paths })).toMatchObject({ team: 'a' });
    lookupDotFile(sub, { cache: paths, write: true });
    writeFileSync(file, JSON.stringify({ server: 'https://obs.example.com', team: 'b' }));
    const t = new Date(Date.now() + 5000);
    utimesSync(file, t, t);
    expect(lookupDotFile(sub, { cache: paths })).toMatchObject({ team: 'b' });
    // a tampered cache entry whose stamps still match is trusted: prove the cache is actually read
    lookupDotFile(sub, { cache: paths, write: true });
    const c2 = JSON.parse(readFileSync(paths.dotFileCache, 'utf8'));
    c2[sub].lookup.team = 'from-cache';
    writeFileSync(paths.dotFileCache, JSON.stringify(c2));
    expect(lookupDotFile(sub, { cache: paths }).team).toBe('from-cache');
    expect(lookupDotFile(sub).team).toBe('b');
  });
});
