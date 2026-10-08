import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCache } from '../src/cc-cache.js';
import { identityOf, loadConfig, removeToken, saveConfig, tokenFingerprint, upsertToken, type TokenEntry } from '../src/config.js';
import { writeTokenDelivery } from '../src/delivery.js';
import { ensureDir } from '../src/fsutil.js';
import type { AiObsPaths } from '../src/paths.js';
import { LEGACY_TEAM_TOKEN_PREFIX } from '../src/protocol-types.js';
import {
  adoptKey,
  assignedKeys,
  assignmentFor,
  bindingTag,
  captureBinding,
  entryFor,
  explicitBinding,
  loadProjects,
  loadRouting,
  OPEN,
  resetProjects,
  resolveStream,
  saveProjects,
  streamDirName,
  unresolvedDirName,
  type Binding,
  type RoutingView,
} from '../src/projects.js';
import { cleanupHomes, tmpHome, writeProjects, writeTestTokens } from './helpers.js';

afterEach(cleanupHomes);

/** the removed prefix (never accepted) */
const OLD = LEGACY_TEAM_TOKEN_PREFIX;

const A = 'http://a.example';
const B = 'http://b.example';
const KEY = 'github.com/acme/billing';
const T0 = Date.parse('2026-10-08T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000);

const view = (paths: AiObsPaths): RoutingView => loadRouting(paths)!;
const tok = (v: RoutingView, name: string) => v.config.tokens.find((t) => t.name === name)!;
const bindOf = (v: RoutingView, name: string): Binding => {
  const t = tok(v, name);
  return { kind: 'token', id: identityOf(t, t.company), name };
};
const assign = (paths: AiObsPaths, key: string, name: string) => {
  const v = view(paths);
  const t = tok(v, name);
  const cur = loadProjects(paths);
  writeProjects(paths, { ...(cur.status === 'ok' ? cur.entries : {}), [key]: assignmentFor(t, t.company, at(5)) });
};
const twoTokens = (paths: AiObsPaths, opts: Parameters<typeof writeTestTokens>[2] = {}) =>
  writeTestTokens(paths, [{ name: 'acme', endpoint: A }, { name: 'globex', endpoint: B, token: 'aiobs_c_test-globex' }], { now: at(0), ...opts });
const oneToken = (paths: AiObsPaths) => writeTestTokens(paths, [{ name: 'acme', endpoint: A }], { now: at(0) });
const corruptProjects = (paths: AiObsPaths) => {
  ensureDir(dirname(paths.projects));
  writeFileSync(paths.projects, '{"github.com/acme/billing": {"tok');
};

describe('loadRouting', () => {
  it('null without config; reads tokens, projects, caches and blocked flags fresh', () => {
    const paths = tmpHome();
    expect(loadRouting(paths)).toBeNull();
    const config = twoTokens(paths, { now: at(0) });
    writeTokenDelivery(paths, config.tokens[1]!, { blocked: { status: 403, at: at(1).toISOString(), message: 'company is suspended' } });
    const v = view(paths);
    expect(v.config.tokens.map((t) => t.name)).toEqual(['acme', 'globex']);
    expect(v.projects).toMatchObject({ status: 'ok', entries: {} });
    expect(v.caches.acme).toMatchObject({ fetched: true, company: { slug: 'acme' }, naming: 'plain' });
    expect(v.blocked).toEqual({ globex: { status: 403, at: at(1).toISOString(), message: 'company is suspended' } });
    // a replaced token (other fingerprint) does not inherit the cache or the blocked flag
    const c = loadConfig(paths)!;
    c.tokens[1] = { ...c.tokens[1]!, token: 'aiobs_c_test-globex-2' };
    saveConfig(paths, c);
    const v2 = view(paths);
    expect(v2.blocked).toEqual({});
    expect(v2.caches.globex).toEqual({ fetched: false });
  });
});

describe('projects.json', () => {
  it('missing → ok and empty; saveProjects writes 0600 atomically; assignments carry the identity', () => {
    const paths = tmpHome();
    expect(loadProjects(paths)).toEqual({ status: 'ok', entries: {} });
    oneToken(paths);
    const t = tok(view(paths), 'acme');
    saveProjects(paths, { [KEY]: assignmentFor(t, t.company, at(1)), 'github.com/x/y': { token: null, none: true, assigned_at: at(1).toISOString() } });
    expect(statSync(paths.projects).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(paths.projects)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const p = loadProjects(paths);
    expect(p.status === 'ok' && p.entries[KEY]).toEqual({ token: 'acme', endpoint: A, company_slug: 'acme', token_fp: tokenFingerprint(t.token), assigned_at: at(1).toISOString() });
    expect(p.status === 'ok' && p.mode).toBe(0o600);
  });

  it('invalid JSON, a non-object or one malformed entry → unreadable (never a silent "no choice")', () => {
    const paths = tmpHome();
    corruptProjects(paths);
    expect(loadProjects(paths)).toMatchObject({ status: 'unreadable' });
    writeFileSync(paths.projects, '[]');
    expect(loadProjects(paths)).toMatchObject({ status: 'unreadable' });
    writeFileSync(paths.projects, JSON.stringify({ [KEY]: { token: null, none: 'yes', assigned_at: 'x' } }));
    expect(loadProjects(paths)).toMatchObject({ status: 'unreadable', error: expect.stringContaining(KEY) });
  });

  it('a hand-written entry without identity loads as a dangling choice', () => {
    const paths = tmpHome();
    oneToken(paths);
    ensureDir(dirname(paths.projects));
    writeFileSync(paths.projects, JSON.stringify({ [KEY]: { token: 'acme', assigned_at: 'x' } }));
    const v = view(paths);
    expect(captureBinding(v, KEY, T0)).toEqual({ kind: 'bind', bind: OPEN, openReason: 'dangling' });
  });

  it('resetProjects renames the unreadable file aside, never deletes it, and starts an empty one', () => {
    const paths = tmpHome();
    corruptProjects(paths);
    const before = readFileSync(paths.projects, 'utf8');
    const aside = resetProjects(paths, at(3));
    expect(basename(aside)).toMatch(/^projects\.json\.broken-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(readFileSync(aside, 'utf8')).toBe(before);
    expect(loadProjects(paths)).toMatchObject({ status: 'ok', entries: {} });
    expect(statSync(paths.projects).mode & 0o777).toBe(0o600);
  });
});

describe('stream names', () => {
  it('bindingTag uses the slug, else the fingerprint, never the name', () => {
    const id = { endpoint: A, company_slug: 'acme', token_fp: 'f1' };
    expect(bindingTag(OPEN)).toBe('open');
    expect(bindingTag({ kind: 'token', id, name: 'acme' })).toBe(`tok:${A}|s:acme`);
    expect(bindingTag({ kind: 'token', id, name: 'other' })).toBe(`tok:${A}|s:acme`);
    expect(bindingTag({ kind: 'token', id: { endpoint: A, token_fp: 'f1' }, name: 'lab' })).toBe(`tok:${A}|f:f1`);
  });

  it('streamDirName: o- / t- prefix + 32 hex, distinct per key and binding', () => {
    const tb: Binding = { kind: 'token', id: { endpoint: A, company_slug: 'acme', token_fp: 'f' }, name: 'acme' };
    expect(streamDirName(KEY, OPEN)).toMatch(/^o-[0-9a-f]{32}$/);
    expect(streamDirName(KEY, tb)).toMatch(/^t-[0-9a-f]{32}$/);
    expect(streamDirName(KEY, OPEN)).not.toBe(streamDirName('github.com/acme/other', OPEN));
    expect(streamDirName(KEY, OPEN)).toBe(streamDirName(KEY, OPEN));
    expect(unresolvedDirName('/tmp/x', OPEN)).toMatch(/^o-[0-9a-f]{32}$/);
    expect(unresolvedDirName('/tmp/x', OPEN)).not.toBe(streamDirName('/tmp/x', OPEN));
  });
});

describe('captureBinding (table A)', () => {
  it('A1: no tokens → drop', () => {
    const paths = tmpHome();
    writeTestTokens(paths, []);
    expect(captureBinding(view(paths), KEY, T0)).toEqual({ kind: 'drop' });
  });

  it('A2: --none → drop', () => {
    const paths = tmpHome();
    twoTokens(paths);
    writeProjects(paths, { [KEY]: { token: null, none: true, assigned_at: at(1).toISOString() } });
    expect(captureBinding(view(paths), KEY, T0)).toEqual({ kind: 'drop' });
  });

  it('A3: an explicit choice matching a token binds it (also when that token is blocked or unverified)', () => {
    const paths = tmpHome();
    const c = twoTokens(paths);
    assign(paths, KEY, 'globex');
    writeTokenDelivery(paths, c.tokens[1]!, { blocked: { status: 401, at: at(1).toISOString(), message: 'x' } });
    const v = view(paths);
    expect(captureBinding(v, KEY, T0)).toEqual({ kind: 'bind', bind: bindOf(v, 'globex') });
  });

  it('A4: an explicit choice without a matching token → open (dangling)', () => {
    const paths = tmpHome();
    twoTokens(paths);
    assign(paths, KEY, 'globex');
    const c = loadConfig(paths)!;
    saveConfig(paths, removeToken(c, 'globex'));
    expect(captureBinding(view(paths), KEY, T0 + 3600_000)).toEqual({ kind: 'bind', bind: OPEN, openReason: 'dangling' });
  });

  it('A5: the single token of the epoch in force at capture', () => {
    const paths = tmpHome();
    oneToken(paths);
    const v = view(paths);
    expect(captureBinding(v, KEY, T0 + 1000)).toEqual({ kind: 'bind', bind: bindOf(v, 'acme') });
    expect(captureBinding(v, null, T0 + 1000)).toEqual({ kind: 'bind', bind: bindOf(v, 'acme') }); // unresolved: epoch rows apply
    expect(captureBinding(v, KEY, T0 - 3600_000)).toEqual({ kind: 'bind', bind: bindOf(v, 'acme') }); // before the first epoch → the first
  });

  it('A5: a job captured with one token and processed after `token add` stays with the first token (1 → 2)', () => {
    const paths = tmpHome();
    oneToken(paths);
    const c = loadConfig(paths)!;
    const r = upsertToken(c, { name: 'globex', company: { name: 'Globex', slug: 'globex' }, endpoint: B, token: 'aiobs_c_x-globex', added_at: at(10).toISOString() }, { nameGiven: false, effOf: (e) => e.company });
    expect(r.kind).toBe('added');
    if (r.kind === 'added') saveConfig(paths, r.config, at(10));
    const v = view(paths);
    expect(captureBinding(v, KEY, at(5).getTime())).toEqual({ kind: 'bind', bind: bindOf(v, 'acme') });
    expect(captureBinding(v, KEY, at(11).getTime())).toEqual({ kind: 'bind', bind: OPEN, openReason: 'unassigned' });
  });

  it('A5 before A3: a job captured under one token and processed after `token add` + `use b` stays with the first token (C12)', () => {
    const paths = tmpHome();
    oneToken(paths);
    const c = loadConfig(paths)!;
    const r = upsertToken(c, { name: 'globex', company: { name: 'Globex', slug: 'globex' }, endpoint: B, token: 'aiobs_c_x-globex', added_at: at(10).toISOString() }, { nameGiven: false, effOf: (e) => e.company });
    if (r.kind === 'added') saveConfig(paths, r.config, at(10));
    const v0 = view(paths);
    writeProjects(paths, { [KEY]: assignmentFor(tok(v0, 'globex'), tok(v0, 'globex').company, at(20)) });
    const v = view(paths);
    expect(captureBinding(v, KEY, at(5).getTime())).toEqual({ kind: 'bind', bind: bindOf(v, 'acme') }); // first hook before the choice
    expect(captureBinding(v, KEY, at(15).getTime())).toEqual({ kind: 'bind', bind: bindOf(v, 'globex') }); // no single token at capture
    expect(captureBinding(v, KEY, at(25).getTime())).toEqual({ kind: 'bind', bind: bindOf(v, 'globex') }); // after the choice
  });

  it('A5: a job captured while two tokens were registered and processed after `token remove` is open (2 → 1)', () => {
    const paths = tmpHome();
    twoTokens(paths, { now: at(0) });
    saveConfig(paths, removeToken(loadConfig(paths)!, 'globex'), at(10));
    const v = view(paths);
    expect(captureBinding(v, KEY, at(5).getTime())).toEqual({ kind: 'bind', bind: OPEN, openReason: 'unassigned' });
    expect(captureBinding(v, KEY, at(11).getTime())).toEqual({ kind: 'bind', bind: bindOf(v, 'acme') });
  });

  it('A5 / A6: unreadable projects.json binds the single token, but is open with two tokens (C23)', () => {
    const one = tmpHome();
    oneToken(one);
    corruptProjects(one);
    const v1 = view(one);
    expect(captureBinding(v1, KEY, T0 + 1000)).toEqual({ kind: 'bind', bind: bindOf(v1, 'acme') });
    const two = tmpHome();
    twoTokens(two);
    corruptProjects(two);
    expect(captureBinding(view(two), KEY, T0 + 1000)).toEqual({ kind: 'bind', bind: OPEN, openReason: 'projects-unreadable' });
  });

  it('A7: a malformed entry next to a valid token → open (config-damaged), also after a rewrite (C22)', () => {
    const paths = tmpHome();
    writeTestTokens(paths, [{ name: 'acme', endpoint: A }], { invalid: [{ name: 'globex', token: `${OLD}old` }], now: at(0) });
    expect(captureBinding(view(paths), KEY, at(1).getTime())).toEqual({ kind: 'bind', bind: OPEN, openReason: 'config-damaged' });
    saveConfig(paths, loadConfig(paths)!, at(2)); // e.g. `token confirm acme`
    expect(captureBinding(view(paths), KEY, at(3).getTime())).toEqual({ kind: 'bind', bind: OPEN, openReason: 'config-damaged' });
  });

  it('A8: two tokens, no choice → open (unassigned)', () => {
    const paths = tmpHome();
    twoTokens(paths);
    expect(captureBinding(view(paths), KEY, T0 + 1000)).toEqual({ kind: 'bind', bind: OPEN, openReason: 'unassigned' });
    expect(captureBinding(view(paths), null, T0 + 1000)).toEqual({ kind: 'bind', bind: OPEN, openReason: 'unassigned' });
  });
});

describe('resolveStream (table B)', () => {
  const project = (pk: string, bind: Binding) => ({ kind: 'project' as const, pk, bind });

  it('B1: unknown and unresolved streams are held', () => {
    const paths = tmpHome();
    oneToken(paths);
    const v = view(paths);
    expect(resolveStream(v, { kind: 'unknown' })).toEqual({ kind: 'held', reason: 'unknown-stream' });
    expect(resolveStream(v, { kind: 'unresolved', cwd: '/x', bind: bindOf(v, 'acme') })).toEqual({ kind: 'held', reason: 'unresolved' });
  });

  it('B2: no tokens → held no-tokens', () => {
    const paths = tmpHome();
    writeTestTokens(paths, []);
    expect(resolveStream(view(paths), project(KEY, OPEN))).toEqual({ kind: 'held', reason: 'no-tokens' });
  });

  it('pre-upgrade data is never sent, with one token, two tokens or a projects entry', () => {
    const one = tmpHome();
    oneToken(one);
    expect(resolveStream(view(one), { kind: 'pre-upgrade' })).toEqual({ kind: 'held', reason: 'pre-upgrade' });
    const two = tmpHome();
    twoTokens(two);
    ensureDir(dirname(two.projects));
    writeFileSync(two.projects, JSON.stringify({ '(pre-upgrade)': assignmentFor(tok(view(two), 'acme'), undefined, at(1)) }));
    expect(resolveStream(view(two), { kind: 'pre-upgrade' })).toEqual({ kind: 'held', reason: 'pre-upgrade' });
  });

  it('B3: --none holds bound and open streams (opted-out)', () => {
    const paths = tmpHome();
    oneToken(paths);
    writeProjects(paths, { [KEY]: { token: null, none: true, assigned_at: at(1).toISOString() } });
    const v = view(paths);
    expect(resolveStream(v, project(KEY, bindOf(v, 'acme')))).toEqual({ kind: 'held', reason: 'opted-out' });
    expect(resolveStream(v, project(KEY, OPEN))).toEqual({ kind: 'held', reason: 'opted-out' });
  });

  it('B4: a bound stream goes to its token whatever projects.json says; dangling / unverified / mismatch held', () => {
    const paths = tmpHome();
    twoTokens(paths);
    const v = view(paths);
    const acmeBind = bindOf(v, 'acme');
    assign(paths, KEY, 'globex'); // re-assignment after capture (C12)
    expect(resolveStream(view(paths), project(KEY, acmeBind))).toMatchObject({ kind: 'token', token: { name: 'acme' }, via: 'bound' });
    corruptProjects(paths); // bound data does not depend on projects.json
    expect(resolveStream(view(paths), project(KEY, acmeBind))).toMatchObject({ kind: 'token', token: { name: 'acme' }, via: 'bound' });
    saveConfig(paths, removeToken(loadConfig(paths)!, 'acme'));
    expect(resolveStream(view(paths), project(KEY, acmeBind))).toEqual({ kind: 'held', reason: 'dangling', assignedTo: 'acme' });
  });

  it('B4: an unverified token holds (unverified); a cache with another slug holds (company-mismatch)', () => {
    const paths = tmpHome();
    writeTestTokens(paths, [
      { name: 'acme', endpoint: A },
      { name: 'lab', endpoint: B, company: null, cache: { company: { name: 'Lab X', slug: 'lab-x' } } },
    ]);
    const v = view(paths);
    const lab = tok(v, 'lab');
    const labBind: Binding = { kind: 'token', id: identityOf(lab), name: 'lab' };
    expect(resolveStream(v, project(KEY, labBind))).toMatchObject({ kind: 'held', reason: 'unverified', token: { name: 'lab' } });
    // cache slug = name → effective company known → routes
    writeCache(paths, lab, { fetched_at: at(1).toISOString(), value: { project_naming: 'plain', min_collector_version: '0', company: { name: 'Lab', slug: 'lab' } } });
    expect(resolveStream(view(paths), project(KEY, labBind))).toMatchObject({ kind: 'token', token: { name: 'lab' } });
    // stored company, server now reports another → mismatch
    const c = loadConfig(paths)!;
    c.tokens[1] = { ...c.tokens[1]!, company: { name: 'Lab', slug: 'lab' } };
    saveConfig(paths, c);
    writeCache(paths, c.tokens[1]!, { value: { project_naming: 'plain', min_collector_version: '0', company: { name: 'Other', slug: 'other' } } });
    expect(resolveStream(view(paths), project(KEY, labBind))).toMatchObject({ kind: 'held', reason: 'company-mismatch' });
  });

  it('B5: an open stream with unreadable projects.json is held (projects-unreadable)', () => {
    const paths = tmpHome();
    oneToken(paths);
    corruptProjects(paths);
    expect(resolveStream(view(paths), project(KEY, OPEN))).toEqual({ kind: 'held', reason: 'projects-unreadable' });
  });

  it('B6: an open stream follows the explicit choice', () => {
    const paths = tmpHome();
    twoTokens(paths);
    assign(paths, KEY, 'globex');
    expect(resolveStream(view(paths), project(KEY, OPEN))).toMatchObject({ kind: 'token', token: { name: 'globex' }, via: 'explicit' });
    saveConfig(paths, removeToken(loadConfig(paths)!, 'globex'));
    expect(resolveStream(view(paths), project(KEY, OPEN))).toEqual({ kind: 'held', reason: 'dangling', assignedTo: 'globex' });
  });

  it('B7: an open stream without a choice stays held, even with a single token (C18)', () => {
    const paths = tmpHome();
    oneToken(paths);
    expect(resolveStream(view(paths), project(KEY, OPEN))).toEqual({ kind: 'held', reason: 'unassigned' });
  });
});

describe('identity binding (C8)', () => {
  const capture = (paths: AiObsPaths) => {
    const d = captureBinding(view(paths), KEY, Date.now());
    if (d.kind !== 'bind') throw new Error('expected a binding');
    return { kind: 'project' as const, pk: KEY, bind: d.bind };
  };

  it('(a) a token named like the removed one but at another endpoint does not receive its data', () => {
    const paths = tmpHome();
    oneToken(paths);
    const s = capture(paths);
    writeTestTokens(paths, [{ name: 'acme', endpoint: B, token: 'aiobs_u_other-server' }]);
    expect(resolveStream(view(paths), s)).toEqual({ kind: 'held', reason: 'dangling', assignedTo: 'acme' });
  });

  it('(b) same name, same endpoint, other company slug → dangling', () => {
    const paths = tmpHome();
    oneToken(paths);
    const s = capture(paths);
    writeTestTokens(paths, [{ name: 'acme', endpoint: A, token: 'aiobs_u_imposter', company: { name: 'Evil', slug: 'evil' } }]);
    expect(resolveStream(view(paths), s)).toMatchObject({ kind: 'held', reason: 'dangling' });
  });

  it('(c) same endpoint + same slug, new token string → still routes (rotation)', () => {
    const paths = tmpHome();
    oneToken(paths);
    const s = capture(paths);
    writeTestTokens(paths, [{ name: 'acme', endpoint: A, token: 'aiobs_u_rotated' }]);
    expect(resolveStream(view(paths), s)).toMatchObject({ kind: 'token', token: { token: 'aiobs_u_rotated' } });
  });

  it('(d) bound by fingerprint while unverified, then confirmed → still routes', () => {
    const paths = tmpHome();
    writeTestTokens(paths, [{ name: 'default', endpoint: A, company: null, provisional_name: true, cache: false }]);
    const s = capture(paths);
    expect(s.bind.kind === 'token' && s.bind.id.company_slug).toBeUndefined();
    expect(resolveStream(view(paths), s)).toMatchObject({ kind: 'held', reason: 'unverified' });
    const c = loadConfig(paths)!;
    const confirmed: TokenEntry = { ...c.tokens[0]!, name: 'acme', company: { name: 'Acme', slug: 'acme' } };
    delete confirmed.provisional_name;
    c.tokens = [confirmed];
    saveConfig(paths, c);
    expect(resolveStream(view(paths), s)).toMatchObject({ kind: 'token', token: { name: 'acme' }, via: 'bound' });
    expect(entryFor(view(paths), (s.bind as Extract<Binding, { kind: 'token' }>).id)?.name).toBe('acme');
  });
});

describe('adoptKey (unresolved → project)', () => {
  it('bound data keeps its token whatever is chosen later (C12); open data takes the explicit choice, else stays open; --none keeps it', () => {
    const paths = tmpHome();
    twoTokens(paths);
    const v0 = view(paths);
    const acme = bindOf(v0, 'acme');
    expect(adoptKey(v0, KEY, acme)).toEqual({ kind: 'bind', bind: acme });
    expect(adoptKey(v0, KEY, OPEN)).toEqual({ kind: 'bind', bind: OPEN, openReason: 'unassigned' });
    assign(paths, KEY, 'globex');
    const v1 = view(paths);
    // captured while acme was the only token, adopted after `use globex`: still acme (no --move-queued)
    expect(adoptKey(v1, KEY, acme)).toEqual({ kind: 'bind', bind: acme });
    expect(adoptKey(v1, KEY, OPEN)).toEqual({ kind: 'bind', bind: bindOf(v1, 'globex') });
    writeProjects(paths, { [KEY]: { token: null, none: true, assigned_at: at(1).toISOString() } });
    // `use --none` keeps queued data (held opted-out until --discard-queued, C19)
    expect(adoptKey(view(paths), KEY, acme)).toEqual({ kind: 'bind', bind: acme });
    expect(adoptKey(view(paths), KEY, OPEN)).toEqual({ kind: 'bind', bind: OPEN });
    expect(resolveStream(view(paths), { kind: 'project', pk: KEY, bind: acme })).toMatchObject({ kind: 'held', reason: 'opted-out' });
  });
});

describe('explicitBinding', () => {
  it('the token of an explicit choice that matches a registered token; null otherwise', () => {
    const paths = tmpHome();
    twoTokens(paths);
    expect(explicitBinding(view(paths), KEY)).toBeNull();
    assign(paths, KEY, 'globex');
    expect(explicitBinding(view(paths), KEY)).toEqual(bindOf(view(paths), 'globex'));
    writeProjects(paths, { [KEY]: { token: null, none: true, assigned_at: at(1).toISOString() } });
    expect(explicitBinding(view(paths), KEY)).toBeNull();
  });
});

describe('assignedKeys', () => {
  it('lists explicit choices pointing to the entry', () => {
    const paths = tmpHome();
    twoTokens(paths);
    assign(paths, KEY, 'globex');
    assign(paths, 'github.com/acme/web', 'acme');
    const v = view(paths);
    expect(assignedKeys(v, tok(v, 'globex'))).toEqual([KEY]);
    expect(assignedKeys(v, tok(v, 'acme'))).toEqual(['github.com/acme/web']);
    expect(existsSync(paths.projects)).toBe(true);
  });
});
