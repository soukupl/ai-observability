import { describe, expect, it, vi } from 'vitest';
import { liveSessionGet, liveSessionsGet, NO_STORE, type LiveDeps } from '../../src/app/api/live/sessions/handlers';
import type { CurrentUser } from '../../src/lib/auth/session';
import type { ActiveSessionsPayload } from '../../src/lib/live/status';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

const user = (over: Partial<CurrentUser> = {}): CurrentUser => ({
  id: '33333333-3333-4333-8333-333333333333',
  email: 'm1@example.test',
  name: 'm1',
  companyId: COMPANY,
  companyRole: 'member',
  isSuperAdmin: false,
  teams: [],
  primaryTeamId: null,
  company: { id: COMPANY, name: 'Co', slug: 'co', plan: 'team', settings: { individualVisibility: 'full', projectNaming: 'plain', retentionDays: 395 } },
  memberships: [],
  ...over,
});

const deps = (u: CurrentUser | null, result: unknown = null) => {
  const withCtx = vi.fn(async () => result);
  return { deps: { getUser: async () => u, withCtx } as unknown as LiveDeps, withCtx };
};

const listUrl = (company?: string) => `http://localhost/api/live/sessions${company === undefined ? '' : `?company=${company}`}`;
const detailUrl = (company?: string) => `http://localhost/api/live/sessions/${SESSION}${company === undefined ? '' : `?company=${company}`}`;

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
  expect(res.headers.get('cache-control')).toBe(NO_STORE['Cache-Control']);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

describe('live session routes (ADR-0027)', () => {
  it('401 without a session, and the database is never touched', async () => {
    const { deps: d, withCtx } = deps(null);
    await expectError(await liveSessionsGet(new Request(listUrl(COMPANY)), d), 401, 'unauthorized');
    await expectError(await liveSessionGet(new Request(detailUrl(COMPANY)), SESSION, d), 401, 'unauthorized');
    expect(withCtx).not.toHaveBeenCalled();
  });

  it('403 for a user without a company (super admin)', async () => {
    const { deps: d, withCtx } = deps(user({ companyId: null, company: null, isSuperAdmin: true }));
    await expectError(await liveSessionsGet(new Request(listUrl(COMPANY)), d), 403, 'forbidden');
    await expectError(await liveSessionGet(new Request(detailUrl(COMPANY)), SESSION, d), 403, 'forbidden');
    expect(withCtx).not.toHaveBeenCalled();
  });

  it('409 when ?company is missing or is not the active company', async () => {
    const { deps: d, withCtx } = deps(user());
    await expectError(await liveSessionsGet(new Request(listUrl()), d), 409, 'company_changed');
    await expectError(await liveSessionsGet(new Request(listUrl('44444444-4444-4444-8444-444444444444')), d), 409, 'company_changed');
    await expectError(await liveSessionGet(new Request(detailUrl()), SESSION, d), 409, 'company_changed');
    await expectError(await liveSessionGet(new Request(detailUrl('other')), SESSION, d), 409, 'company_changed');
    expect(withCtx).not.toHaveBeenCalled();
  });

  it('200 with the payload and no-store headers, read as the active company user', async () => {
    const payload: ActiveSessionsPayload = { nowMs: 1, ownOnly: false, truncated: false, rows: [] };
    const u = user();
    const { deps: d, withCtx } = deps(u, payload);
    const res = await liveSessionsGet(new Request(listUrl(COMPANY)), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(withCtx).toHaveBeenCalledTimes(1);
    expect(withCtx.mock.calls[0]![0]).toMatchObject({ id: u.id, companyId: COMPANY, company: u.company });

    const detail = { nowMs: 1, rev: 'x' };
    const one = deps(u, detail);
    const r2 = await liveSessionGet(new Request(detailUrl(COMPANY)), SESSION, one.deps);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual(detail);
    expect(r2.headers.get('cache-control')).toBe('no-store');
  });

  it('404 when the session is missing or not visible', async () => {
    const { deps: d, withCtx } = deps(user(), null);
    await expectError(await liveSessionGet(new Request(detailUrl(COMPANY)), 'not-a-uuid', d), 404, 'not_found');
    expect(withCtx).toHaveBeenCalledTimes(1);
  });
});
