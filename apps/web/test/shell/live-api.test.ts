import { describe, expect, it, vi } from 'vitest';
import { liveSessionGet, liveSessionsGet, NO_STORE, type LiveDeps } from '../../src/app/api/live/sessions/handlers';
import type { CurrentUser } from '../../src/lib/auth/session';
import type { ActiveSessionsPayload } from '../../src/lib/live/status';

const SESSION = '22222222-2222-4222-8222-222222222222';

const user = (over: Partial<CurrentUser> = {}): CurrentUser => ({
  id: '33333333-3333-4333-8333-333333333333',
  email: 'm1@example.test',
  name: 'm1',
  role: 'member',
  teams: [],
  primaryTeamId: null,
  deployment: { id: '11111111-1111-4111-8111-111111111111', name: 'Co', slug: 'co', settings: { individualVisibility: 'full', projectNaming: 'plain', retentionDays: 395 } },
  ...over,
});

const deps = (u: CurrentUser | null, result: unknown = null) => {
  const withCtx = vi.fn(async (_user: CurrentUser, _fn: unknown) => result);
  return { deps: { getUser: async () => u, withCtx } as unknown as LiveDeps, withCtx };
};

const listUrl = 'http://localhost/api/live/sessions';
const detailUrl = `http://localhost/api/live/sessions/${SESSION}`;

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
  expect(res.headers.get('cache-control')).toBe(NO_STORE['Cache-Control']);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

describe('live session routes (ADR-0027)', () => {
  it('401 without a session, and the database is never touched', async () => {
    const { deps: d, withCtx } = deps(null);
    await expectError(await liveSessionsGet(new Request(listUrl), d), 401, 'unauthorized');
    await expectError(await liveSessionGet(new Request(detailUrl), SESSION, d), 401, 'unauthorized');
    expect(withCtx).not.toHaveBeenCalled();
  });

  it('200 with the payload and no-store headers, read as the signed-in user', async () => {
    const payload: ActiveSessionsPayload = { nowMs: 1, ownOnly: false, truncated: false, rows: [] };
    const u = user();
    const { deps: d, withCtx } = deps(u, payload);
    const res = await liveSessionsGet(new Request(listUrl), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(withCtx).toHaveBeenCalledTimes(1);
    expect(withCtx.mock.calls[0]![0]).toBe(u);

    const detail = { nowMs: 1, rev: 'x' };
    const one = deps(u, detail);
    const r2 = await liveSessionGet(new Request(detailUrl), SESSION, one.deps);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual(detail);
    expect(r2.headers.get('cache-control')).toBe('no-store');
  });

  it('a stale ?company= from a tab opened before the upgrade is ignored', async () => {
    const payload: ActiveSessionsPayload = { nowMs: 1, ownOnly: true, truncated: false, rows: [] };
    const { deps: d } = deps(user(), payload);
    const res = await liveSessionsGet(new Request(`${listUrl}?company=44444444-4444-4444-8444-444444444444`), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it('404 when the session is missing or not visible', async () => {
    const { deps: d, withCtx } = deps(user(), null);
    await expectError(await liveSessionGet(new Request(detailUrl), 'not-a-uuid', d), 404, 'not_found');
    expect(withCtx).toHaveBeenCalledTimes(1);
  });
});
