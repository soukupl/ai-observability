import { describe, expect, it } from 'vitest';
import { DB_ROLES, urlFor } from '../src/connections.js';
import { assertRlsContext } from '../src/rls.js';
import { effectiveRetentionDays, slugifyTeamName, TEAM_SLUG_RE } from '../src/schema/settings.js';

const id = '7d0f3a52-5b8e-4c47-9d0e-0a3c2f1b9e11';

describe('assertRlsContext', () => {
  it('accepts a well-formed context (no company: ADR-0028)', () => {
    expect(() => assertRlsContext({ userId: id, role: 'admin' })).not.toThrow();
    expect(() => assertRlsContext({ userId: id, role: 'member' })).not.toThrow();
  });
  it.each([
    [{ userId: "1' or 1=1", role: 'member' }, /userId/],
    [{ userId: undefined, role: 'member' }, /userId/],
    [{ userId: id, role: 'lead' }, /role/],
    [{ userId: id, role: 'superuser' }, /role/],
  ])('rejects %j', (ctx, msg) => {
    expect(() => assertRlsContext(ctx as never)).toThrow(msg);
  });
});

describe('urlFor / DB_ROLES', () => {
  it('prefers the per-service URL and falls back to DATABASE_URL', () => {
    const env = { DATABASE_URL: 'postgres://owner', DATABASE_URL_WEB: 'postgres://web' };
    expect(urlFor('web', env)).toBe('postgres://web');
    expect(urlFor('ingest', env)).toBe('postgres://owner');
    expect(() => urlFor('worker', {})).toThrow(/DATABASE_URL_WORKER/);
  });
  it('has no platform role any more', () => {
    expect(DB_ROLES).toEqual({ web: 'app_web', ingest: 'app_ingest', worker: 'app_worker' });
  });
});

describe('effectiveRetentionDays', () => {
  it('clamps to 30–730 days and defaults to 395 (no plan caps)', () => {
    expect(effectiveRetentionDays({ retentionDays: 730 })).toBe(730);
    expect(effectiveRetentionDays({ retentionDays: 5000 })).toBe(730);
    expect(effectiveRetentionDays({ retentionDays: 1 })).toBe(30);
    expect(effectiveRetentionDays({ retentionDays: 90.7 })).toBe(90);
    expect(effectiveRetentionDays({})).toBe(395);
    expect(effectiveRetentionDays(null)).toBe(395);
    expect(effectiveRetentionDays({ retentionDays: 'x' })).toBe(395);
  });
});

describe('slugifyTeamName (same rule as team_slug_base)', () => {
  it.each([
    ['Platform', 'platform'],
    ['Žlutý Kůň & Co.', 'lut-k-co'],
    ['  --  ', 'team'],
    ['A'.repeat(70), 'a'.repeat(63)],
    [`${'a'.repeat(62)}-b`, 'a'.repeat(62)],
  ])('%s → %s', (name, slug) => {
    expect(slugifyTeamName(name)).toBe(slug);
    expect(TEAM_SLUG_RE.test(slug)).toBe(true);
  });
});
