import { describe, expect, it } from 'vitest';
import { urlFor } from '../src/connections.js';
import { assertRlsContext } from '../src/rls.js';

const id = '7d0f3a52-5b8e-4c47-9d0e-0a3c2f1b9e11';

describe('assertRlsContext', () => {
  it('accepts a well-formed context', () => {
    expect(() => assertRlsContext({ companyId: id, userId: id, role: 'admin' })).not.toThrow();
  });
  it.each([
    [{ companyId: 'x', userId: id, role: 'admin' }, /companyId/],
    [{ companyId: id, userId: "1' or 1=1", role: 'member' }, /userId/],
    [{ companyId: id, userId: id, role: 'lead' }, /role/],
    [{ companyId: id, userId: id, role: 'superuser' }, /role/],
  ])('rejects %j', (ctx, msg) => {
    expect(() => assertRlsContext(ctx as never)).toThrow(msg);
  });
});

describe('urlFor', () => {
  it('prefers the per-service URL and falls back to DATABASE_URL', () => {
    const env = { DATABASE_URL: 'postgres://owner', DATABASE_URL_WEB: 'postgres://web' };
    expect(urlFor('web', env)).toBe('postgres://web');
    expect(urlFor('ingest', env)).toBe('postgres://owner');
    expect(() => urlFor('worker', {})).toThrow(/DATABASE_URL_WORKER/);
  });
});
