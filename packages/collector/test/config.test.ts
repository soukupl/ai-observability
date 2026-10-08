import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildConfig,
  epochAt,
  findToken,
  identityMatches,
  identityOf,
  isIngestToken,
  isTokenName,
  loadConfig,
  maskToken,
  newMachineConfig,
  removeToken,
  saveConfig,
  sameIdentity,
  singleIdentity,
  tokenFingerprint,
  tokenKind,
  upsertToken,
  type CollectorConfig,
  type CompanyLabel,
  type TokenEntry,
} from '../src/config.js';
import { ensureDir } from '../src/fsutil.js';
import { LEGACY_TEAM_TOKEN_PREFIX } from '../src/protocol-types.js';
import { cleanupHomes, tmpHome } from './helpers.js';

afterEach(cleanupHomes);

/** the removed prefix (never accepted) */
const OLD = LEGACY_TEAM_TOKEN_PREFIX;

const E1 = 'https://obs.acme.example';
const E2 = 'https://obs.other.example';
const AT = '2026-10-08T10:00:00.000Z';

const entry = (name: string, o: Partial<TokenEntry> = {}): TokenEntry => ({
  name,
  endpoint: E1,
  token: `aiobs_u_${name}-token-0001`,
  added_at: AT,
  ...o,
});
const co = (slug: string): CompanyLabel => ({ name: slug.toUpperCase(), slug });
const withTokens = (tokens: TokenEntry[], invalid: unknown[] = []): CollectorConfig => ({
  ...newMachineConfig(null, new Date(AT)),
  tokens,
  invalidTokens: invalid,
});
/** effOf: stored company, else what `caches` say when the slug equals the name */
const effOf = (caches: Record<string, string> = {}) => (e: TokenEntry) => e.company ?? (caches[e.name] === e.name ? co(e.name) : undefined);

describe('token prefixes and names', () => {
  it('accepts user and company tokens only', () => {
    expect(tokenKind('aiobs_u_abc')).toBe('user');
    expect(tokenKind('aiobs_c_abc')).toBe('company');
    expect(tokenKind(`${OLD}abc`)).toBeNull();
    expect(isIngestToken('aiobs_u_abc')).toBe(true);
    expect(isIngestToken('aiobs_c_abc')).toBe(true);
    expect(isIngestToken('aiobs_c_')).toBe(false);
    expect(isIngestToken(`${OLD}abc`)).toBe(false);
    expect(isIngestToken('sk-123')).toBe(false);
  });

  it.each(['a', 'acme', 'acme-2', '0', 'a'.repeat(63)])('name %s is valid', (n) => expect(isTokenName(n)).toBe(true));
  it.each(['', '-a', 'a-', 'A', 'a_b', 'a b', 'a'.repeat(64), '../x'])('name %j is invalid', (n) => expect(isTokenName(n)).toBe(false));

  it('maskToken keeps the 8-char prefix of known kinds (also the removed one) and the last 4 chars', () => {
    expect(maskToken('aiobs_u_0123456789abcdef')).toBe('aiobs_u_…cdef');
    expect(maskToken('aiobs_c_0123456789abcdef')).toBe('aiobs_c_…cdef');
    expect(maskToken(`${OLD}0123456789abcdef`)).toBe(`${OLD}…cdef`);
    expect(maskToken('sk-0123456789abcdef')).toBe('…cdef');
    expect(maskToken('aiobs_u_x')).toBe('aiobs_u_…');
  });

  it('tokenFingerprint is 16 hex chars and differs per token', () => {
    expect(tokenFingerprint('aiobs_u_a')).toMatch(/^[0-9a-f]{16}$/);
    expect(tokenFingerprint('aiobs_u_a')).not.toBe(tokenFingerprint('aiobs_u_b'));
  });
});

describe('identities (C8)', () => {
  const acme = entry('acme', { company: co('acme'), prior_fps: ['00000000000000aa'] });

  it('a slug identity matches by endpoint + effective slug, whatever the token', () => {
    const id = identityOf(acme);
    expect(id).toEqual({ endpoint: E1, company_slug: 'acme', token_fp: tokenFingerprint(acme.token) });
    expect(identityMatches(id, { ...acme, token: 'aiobs_u_rotated-0001' })).toBe(true);
    expect(identityMatches(id, { ...acme, endpoint: E2 })).toBe(false);
    expect(identityMatches(id, { ...acme, company: co('globex') })).toBe(false);
    // unverified entry: the effective company passed in decides
    const bare = entry('acme');
    expect(identityMatches(id, bare)).toBe(false);
    expect(identityMatches(id, bare, co('acme'))).toBe(true);
  });

  it('a fingerprint identity matches the token or a prior fingerprint', () => {
    const bare = entry('lab');
    const id = identityOf(bare);
    expect(id.company_slug).toBeUndefined();
    expect(identityMatches(id, bare)).toBe(true);
    expect(identityMatches(id, { ...bare, company: co('lab') })).toBe(true); // confirmed later
    expect(identityMatches(id, { ...bare, token: 'aiobs_u_other-0001' })).toBe(false);
    expect(identityMatches({ endpoint: E1, token_fp: '00000000000000aa' }, acme)).toBe(true); // prior fp
    expect(identityMatches({ endpoint: E2, token_fp: tokenFingerprint(bare.token) }, bare)).toBe(false);
  });

  it('sameIdentity: slugs when both known, else fingerprints', () => {
    const a = { endpoint: E1, company_slug: 'acme', token_fp: 'f1' };
    expect(sameIdentity(a, { ...a, token_fp: 'f2' })).toBe(true);
    expect(sameIdentity(a, { endpoint: E1, token_fp: 'f1' })).toBe(true);
    expect(sameIdentity(a, { endpoint: E1, token_fp: 'f2' })).toBe(false);
    expect(sameIdentity(a, { ...a, endpoint: E2 })).toBe(false);
    expect(sameIdentity(null, null)).toBe(true);
    expect(sameIdentity(a, null)).toBe(false);
  });

  it('singleIdentity: exactly one valid token and no malformed entry', () => {
    expect(singleIdentity(withTokens([acme]))).toEqual(identityOf(acme));
    expect(singleIdentity(withTokens([]))).toBeNull();
    expect(singleIdentity(withTokens([acme, entry('globex')]))).toBeNull();
    expect(singleIdentity(withTokens([acme], [{ name: 'BAD' }]))).toBeNull();
  });
});

describe('loadConfig / saveConfig', () => {
  it('round-trips the v2 shape (0600, v: 2, in-memory fields dropped, legacy kept)', () => {
    const paths = tmpHome();
    const config: CollectorConfig = {
      ...withTokens([
        entry('acme', { company: co('acme'), email: 'alice@acme.example', prior_fps: ['9d1e000000000000'] }),
        entry('globex', { endpoint: E2, token: 'aiobs_c_globex-token-01', company: co('globex') }),
        entry('default', { provisional_name: true }),
      ]),
      endpoint: E2,
      git_email: 'alice@acme.example',
      legacy: { endpoint: E1, token_mask: `${OLD}…ab12`, found_at: AT },
      legacyToken: `${OLD}…ab12`,
    };
    saveConfig(paths, config, new Date(AT));
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(paths.config, 'utf8')) as Record<string, unknown>;
    expect(raw.v).toBe(2);
    expect(raw).not.toHaveProperty('legacyToken');
    expect(raw).not.toHaveProperty('invalidTokens');
    expect(raw.invalid_tokens).toEqual([]);
    expect(raw.routing_epochs).toEqual([{ since: AT, single: null }]);
    const back = loadConfig(paths)!;
    expect(back.tokens).toEqual(config.tokens);
    expect(back.legacy).toEqual(config.legacy);
    expect(back.legacyToken).toBeUndefined();
    expect(back.endpoint).toBe(E2);
    expect(back.git_email).toBe('alice@acme.example');
    expect(back.machine_id).toBe(config.machine_id);
    expect(back.routingEpochs).toEqual([{ since: AT, single: null }]);
  });

  it('a pre-upgrade flat file loads with no tokens, the masked old token and the machine identity (C5)', () => {
    const paths = tmpHome();
    ensureDir(paths.root);
    writeFileSync(
      paths.config,
      JSON.stringify({ endpoint: E1, token: `${OLD}0123456789abcdef`, machine_id: 'm-1', created_at: AT, git_email: 'dev@acme.com' }),
    );
    const c = loadConfig(paths)!;
    expect(c.tokens).toEqual([]);
    expect(c.legacyToken).toBe(`${OLD}…cdef`);
    expect(c).toMatchObject({ machine_id: 'm-1', created_at: AT, git_email: 'dev@acme.com', endpoint: E1 });
    expect(JSON.stringify(c)).not.toContain('0123456789abcdef');
  });

  it('missing, unparsable or machine-less files are "not configured"', () => {
    const paths = tmpHome();
    expect(loadConfig(paths)).toBeNull();
    ensureDir(paths.root);
    writeFileSync(paths.config, '{nope');
    expect(loadConfig(paths)).toBeNull();
    writeFileSync(paths.config, JSON.stringify({ tokens: [] }));
    expect(loadConfig(paths)).toBeNull();
  });

  it('malformed entries survive a routine rewrite and keep the single identity null (C22)', () => {
    const paths = tmpHome();
    ensureDir(paths.root);
    const acme = entry('acme');
    const bad = [
      { name: 'globex', endpoint: E1, token: `${OLD}old`, added_at: AT }, // removed prefix
      { name: 'Bad Name', endpoint: E1, token: 'aiobs_u_x1', added_at: AT },
      { name: 'acme', endpoint: E1, token: 'aiobs_u_dup', added_at: AT }, // duplicate name
      { name: 'lab', endpoint: 'ftp://x', token: 'aiobs_u_x2', added_at: AT },
      'garbage',
    ];
    writeFileSync(paths.config, JSON.stringify({ v: 2, machine_id: 'm', created_at: AT, tokens: [acme, ...bad], invalid_tokens: [{ keep: 1 }] }));
    const c = loadConfig(paths)!;
    expect(c.tokens.map((t) => t.name)).toEqual(['acme']);
    expect(c.invalidTokens).toEqual([...bad, { keep: 1 }]);
    expect(singleIdentity(c)).toBeNull();
    // a `token confirm`-style change, then save
    c.tokens = [{ ...acme, company: co('acme') }];
    saveConfig(paths, c);
    const again = loadConfig(paths)!;
    expect(again.invalidTokens).toEqual([...bad, { keep: 1 }]);
    expect(again.tokens[0]?.company).toEqual(co('acme'));
    expect(singleIdentity(again)).toBeNull();
    expect(again.routingEpochs.map((e) => e.single)).toEqual([null]);
  });

  it('appends a routing epoch only when the single identity changes: 1 → 2 → 1 tokens = 3 epochs (C18)', () => {
    const paths = tmpHome();
    const acme = entry('acme', { company: co('acme') });
    const c = withTokens([acme]);
    const t = (m: number) => new Date(Date.parse(AT) + m * 60_000);
    saveConfig(paths, c, t(0));
    saveConfig(paths, c, t(1)); // unchanged
    c.tokens = [{ ...acme, token: 'aiobs_u_rotated-0001' }]; // rotation: same company, same identity
    saveConfig(paths, c, t(2));
    c.tokens = [...c.tokens, entry('globex', { company: co('globex') })];
    saveConfig(paths, c, t(3));
    c.tokens = c.tokens.slice(0, 1);
    saveConfig(paths, c, t(4));
    const epochs = loadConfig(paths)!.routingEpochs;
    expect(epochs.map((e) => [e.since, e.single?.company_slug ?? null])).toEqual([
      [t(0).toISOString(), 'acme'],
      [t(3).toISOString(), null],
      [t(4).toISOString(), 'acme'],
    ]);
    expect(c.routingEpochs).toEqual(epochs); // updated in place
  });

  it('zero tokens get single: null; at most 50 epochs are kept', () => {
    const paths = tmpHome();
    const c = withTokens([]);
    saveConfig(paths, c, new Date(AT));
    expect(loadConfig(paths)!.routingEpochs).toEqual([{ since: AT, single: null }]);
    const many = Array.from({ length: 60 }, (_, i) => ({ since: new Date(i * 1000).toISOString(), single: i % 2 ? null : identityOf(entry('a')) }));
    c.routingEpochs = many;
    c.tokens = [entry('b')];
    saveConfig(paths, c, new Date(AT));
    const kept = loadConfig(paths)!.routingEpochs;
    expect(kept).toHaveLength(50);
    expect(kept.at(-1)?.single?.token_fp).toBe(tokenFingerprint(entry('b').token));
  });

  it('epochAt: the last epoch whose since ≤ at, else the first', () => {
    const e = (iso: string, slug: string | null) => ({ since: iso, single: slug ? { endpoint: E1, company_slug: slug, token_fp: 'f' } : null });
    const c = { routingEpochs: [e('2026-10-01T00:00:00Z', 'acme'), e('2026-10-05T00:00:00Z', null), e('2026-10-07T00:00:00Z', 'globex')] };
    expect(epochAt(c, Date.parse('2026-09-01T00:00:00Z'))?.single?.company_slug).toBe('acme');
    expect(epochAt(c, Date.parse('2026-10-01T00:00:00Z'))?.single?.company_slug).toBe('acme');
    expect(epochAt(c, Date.parse('2026-10-06T00:00:00Z'))?.single).toBeNull();
    expect(epochAt(c, Date.parse('2026-10-08T00:00:00Z'))?.single?.company_slug).toBe('globex');
    expect(epochAt({ routingEpochs: [] }, Date.now())).toBeNull();
  });
});

describe('upsertToken (§1.1 rules)', () => {
  const verified = (name: string, slug: string, o: Partial<TokenEntry> = {}) => entry(name, { company: co(slug), token: `aiobs_u_${name}-new-0001`, ...o });

  it('rule 1: the same token string replaces its entry, keeping the name unless --name', () => {
    const old = entry('acme', { company: co('acme') });
    const c = withTokens([old, entry('globex')]);
    const r = upsertToken(c, { ...old, name: 'acme', added_at: '2026-10-09T00:00:00.000Z' }, { nameGiven: false, effOf: effOf() });
    expect(r).toMatchObject({ kind: 'replaced', sameCompany: true, entry: { name: 'acme', added_at: '2026-10-09T00:00:00.000Z' } });
    const renamed = upsertToken(c, { ...old, name: 'acme-eu' }, { nameGiven: true, effOf: effOf() });
    expect(renamed).toMatchObject({ kind: 'replaced', entry: { name: 'acme-eu' } });
    expect(upsertToken(c, { ...old, name: 'globex' }, { nameGiven: true, effOf: effOf() }).kind).toBe('conflict');
    // offline re-registration keeps the known company
    const offline = upsertToken(c, { name: 'default', endpoint: E1, token: old.token, added_at: AT, provisional_name: true }, { nameGiven: false, effOf: effOf() });
    expect(offline).toMatchObject({ kind: 'replaced', entry: { name: 'acme', company: co('acme') } });
    expect(offline.kind === 'replaced' && offline.entry.provisional_name).toBeFalsy();
  });

  it('rule 2: verified, same endpoint + slug → rotation keeps the name and records the old fingerprint', () => {
    const old = entry('work', { company: co('acme'), prior_fps: ['00000000000000aa'] });
    const c = withTokens([old]);
    const r = upsertToken(c, verified('acme', 'acme'), { nameGiven: false, effOf: effOf() });
    expect(r.kind).toBe('replaced');
    if (r.kind !== 'replaced') return;
    expect(r.sameCompany).toBe(true);
    expect(r.entry.name).toBe('work');
    expect(r.entry.token).toBe('aiobs_u_acme-new-0001');
    expect(r.entry.prior_fps).toEqual(['00000000000000aa', tokenFingerprint(old.token)]);
    expect(r.config.tokens).toHaveLength(1);
    // the old identity still matches the rotated entry (prior fingerprint)
    expect(identityMatches({ endpoint: E1, token_fp: tokenFingerprint(old.token) }, r.entry)).toBe(true);
    const named = upsertToken(c, verified('acme', 'acme'), { nameGiven: true, effOf: effOf() });
    expect(named).toMatchObject({ kind: 'conflict' });
    expect(named.kind === 'conflict' && named.message).toContain('already registered as work');
  });

  it('rule 2: an unverified entry whose cache reports slug = name counts as that company', () => {
    const c = withTokens([entry('acme')]);
    const r = upsertToken(c, verified('acme', 'acme'), { nameGiven: false, effOf: effOf({ acme: 'acme' }) });
    expect(r).toMatchObject({ kind: 'replaced', sameCompany: true });
  });

  it('prior fingerprints are capped at 10', () => {
    const prior = Array.from({ length: 10 }, (_, i) => `${i}`.padStart(16, '0'));
    const c = withTokens([entry('acme', { company: co('acme'), prior_fps: prior })]);
    const r = upsertToken(c, verified('acme', 'acme'), { nameGiven: false, effOf: effOf() });
    expect(r.kind === 'replaced' && r.entry.prior_fps).toHaveLength(10);
    expect(r.kind === 'replaced' && r.entry.prior_fps?.at(-1)).toBe(tokenFingerprint(entry('acme').token));
  });

  it('rule 3: same slug at another endpoint without --name → conflict; with --name → added', () => {
    const c = withTokens([entry('acme-eu', { company: co('acme') })]);
    const r = upsertToken(c, verified('acme', 'acme', { endpoint: E2 }), { nameGiven: false, effOf: effOf() });
    expect(r.kind).toBe('conflict');
    expect(r.kind === 'conflict' && r.message).toMatch(/company slug acme is already registered as acme-eu for https:\/\/obs\.acme\.example; pass --name/);
    const named = upsertToken(c, verified('acme-us', 'acme', { endpoint: E2 }), { nameGiven: true, effOf: effOf() });
    expect(named).toMatchObject({ kind: 'added', entry: { name: 'acme-us' } });
    expect(named.kind === 'added' && named.config.tokens.map((t) => t.name)).toEqual(['acme-eu', 'acme-us']);
  });

  it('rule 4: same name at another endpoint → conflict', () => {
    const c = withTokens([entry('lab', { endpoint: E2 })]);
    const r = upsertToken(c, entry('lab', { token: 'aiobs_u_lab-new-0001' }), { nameGiven: true, effOf: effOf() });
    expect(r.kind === 'conflict' && r.message).toContain(`a token named lab is already registered for ${E2}`);
  });

  it('rule 4: a verified entry is never replaced by an unchecked token', () => {
    const c = withTokens([entry('acme', { company: co('acme') })]);
    const r = upsertToken(c, entry('acme', { token: 'aiobs_u_unchecked-01' }), { nameGiven: true, effOf: effOf() });
    expect(r.kind === 'conflict' && r.message).toContain('belongs to company acme');
  });

  it('rule 4: same name, both verified, other slug → conflict naming the new slug', () => {
    const c = withTokens([entry('acme', { company: co('acme') })]);
    const r = upsertToken(c, verified('acme', 'globex'), { nameGiven: true, effOf: effOf() });
    expect(r.kind === 'conflict' && r.message).toContain('pass --name globex');
  });

  it('rule 4: an unverified old entry is replaced; same company only when its cache reported the new slug', () => {
    const old = entry('lab');
    const c = withTokens([old]);
    const other = upsertToken(c, verified('lab', 'lab-x'), { nameGiven: true, effOf: effOf(), cachedSlugOf: () => 'globex' });
    expect(other).toMatchObject({ kind: 'replaced', sameCompany: false });
    expect(other.kind === 'replaced' && other.entry.prior_fps).toBeUndefined();
    const same = upsertToken(c, verified('lab', 'lab-x'), { nameGiven: true, effOf: effOf(), cachedSlugOf: () => 'lab-x' });
    expect(same).toMatchObject({ kind: 'replaced', sameCompany: true, entry: { prior_fps: [tokenFingerprint(old.token)] } });
    const unverified = upsertToken(c, entry('lab', { token: 'aiobs_u_lab-new-0001' }), { nameGiven: true, effOf: effOf() });
    expect(unverified).toMatchObject({ kind: 'replaced', sameCompany: false });
  });

  it('rule 5: otherwise added in registration order', () => {
    const c = withTokens([entry('acme', { company: co('acme') })]);
    const r = upsertToken(c, verified('globex', 'globex'), { nameGiven: false, effOf: effOf() });
    expect(r.kind === 'added' && r.config.tokens.map((t) => t.name)).toEqual(['acme', 'globex']);
    expect(c.tokens).toHaveLength(1); // pure
  });

  it('removeToken / findToken', () => {
    const c = withTokens([entry('acme'), entry('globex')]);
    expect(findToken(c, 'globex')?.name).toBe('globex');
    expect(removeToken(c, 'acme').tokens.map((t) => t.name)).toEqual(['globex']);
    expect(c.tokens).toHaveLength(2);
  });
});

describe('buildConfig / newMachineConfig', () => {
  it('buildConfig: one token named after the company (else default), one epoch, machine kept', () => {
    const first = buildConfig({ endpoint: `${E1}/`, token: 'aiobs_u_abc', now: new Date(AT) });
    expect(first.tokens).toEqual([{ name: 'default', endpoint: E1, token: 'aiobs_u_abc', added_at: AT }]);
    expect(first.routingEpochs).toEqual([{ since: AT, single: identityOf(first.tokens[0]!) }]);
    const next = buildConfig({ endpoint: E1, token: 'aiobs_c_abc', existing: first, company: co('acme'), gitEmail: 'a@b.c' });
    expect(next.tokens[0]?.name).toBe('acme');
    expect(next.machine_id).toBe(first.machine_id);
    expect(next.git_email).toBe('a@b.c');
    expect(() => buildConfig({ endpoint: E1, token: `${OLD}abc` })).toThrow(/aiobs_u_ or aiobs_c_/);
  });

  it('newMachineConfig keeps the machine identity and legacy record, not the tokens', () => {
    const existing: CollectorConfig = { ...withTokens([entry('acme')]), git_email: 'x@y.z', legacy: { token_mask: `${OLD}…`, found_at: AT } };
    const c = newMachineConfig(existing);
    expect(c).toMatchObject({ machine_id: existing.machine_id, created_at: existing.created_at, git_email: 'x@y.z', legacy: existing.legacy, tokens: [] });
    expect(newMachineConfig(null).machine_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
