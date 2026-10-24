import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { turns, usage } from '@ai-obs/db';
import { defaultFilters } from '../../src/lib/filters';
import { getLiveSession, getSessionDetail, listActiveSessions, listSessions, toLiveSessionPayload, type QueryCtx } from '../../src/lib/queries';
import { asPerson, dropShellDatabase, NOW, prepareShellDatabase, seedDeployment, type Fixture, type Person } from './harness';

const MIN = 60_000;
const HOUR = 60 * MIN;
const nowMs = NOW.getTime();

const skipReason = await prepareShellDatabase();
if (skipReason) console.warn(`[web/shell] live session tests skipped: ${skipReason}`);

/** Live sessions seeded on top of the shared fixture (whose turns have no session). Times are relative to NOW. */
interface Live {
  L1: string; // m1 working: one turn 20-15 min ago (with usage), a prompt 4 min ago
  L2: string; // m1, no turn yet, started 2 min ago
  L2Hid: string;
  L3: string; // m2 idle: turn ended 10 min ago, stored title
  L4: string; // lead: last signal 31 min ago (stale)
  L5: string; // m1: working for 2 h 1 min (stale, and its last signal is too old to be a candidate)
  L6: string; // m1: ended 5 min ago
  L8: string; // m1: no last_seen_at (written before migration 0017)
  L9: string; // admin working: a prompt 1 min ago
}

async function seedLive(fx: Fixture): Promise<Live> {
  return fx.owner.transaction(async (tx) => {
    await tx.execute(sql`set local role app_definer`);
    const p = (k: string) => fx.people[k]!;
    const teamOf = (k: string) => (k === 'm2' ? fx.teams.t2! : fx.teams.t1!);
    const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
    const session = async (who: string, o: { startedMs: number; currentMs?: number; lastSeenMs?: number | null; endedMs?: number; title?: string }) => {
      const id = randomUUID();
      const hid = randomUUID();
      await tx.execute(sql`insert into agent_sessions (id, team_id, user_id, project_id, external_id, harness, started_at, ended_at, end_reason,
          title, title_source, current_turn_started_at, last_seen_at)
        values (${id}::uuid, ${teamOf(who)}::uuid, ${p(who).id}::uuid, ${fx.projects.alpha!}::uuid, ${`claude-code:${hid}`}, 'claude-code',
          ${iso(o.startedMs)}::timestamptz, ${iso(o.endedMs)}::timestamptz, ${o.endedMs ? 'exit' : null}, ${o.title ?? null}, ${o.title ? 'custom' : null},
          ${iso(o.currentMs)}::timestamptz, ${iso(o.lastSeenMs)}::timestamptz)`);
      return { id, hid };
    };
    const turn = async (who: string, sessionId: string, startedMs: number, endedMs: number) => {
      const id = randomUUID();
      const own = { teamId: teamOf(who), userId: p(who).id };
      await tx.insert(turns).values({
        id, ...own, attribution: 'verified', sessionId, projectId: fx.projects.alpha!, externalId: `lx-${id}`, harness: 'claude-code',
        model: 'claude-opus-5-5', effort: 'high', startedAt: new Date(startedMs), endedAt: new Date(endedMs), durationMs: endedMs - startedMs,
        inputTokens: 1000, outputTokens: 100, outcome: 'success', summary: null,
      });
      await tx.insert(usage).values({
        ...own, turnId: id, runId: null, startedAt: new Date(startedMs), model: 'claude-opus-5-5', effort: 'high',
        inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 1,
      });
    };

    const L1 = await session('m1', { startedMs: nowMs - 25 * MIN, currentMs: nowMs - 4 * MIN, lastSeenMs: nowMs - 4 * MIN });
    await turn('m1', L1.id, nowMs - 20 * MIN, nowMs - 15 * MIN);
    const L2 = await session('m1', { startedMs: nowMs - 2 * MIN, lastSeenMs: nowMs - 2 * MIN });
    const L3 = await session('m2', { startedMs: nowMs - 30 * MIN, lastSeenMs: nowMs - 10 * MIN, title: 'Stored title' });
    await turn('m2', L3.id, nowMs - 15 * MIN, nowMs - 10 * MIN);
    const L4 = await session('lead', { startedMs: nowMs - 50 * MIN, lastSeenMs: nowMs - 31 * MIN });
    await turn('lead', L4.id, nowMs - 40 * MIN, nowMs - 31 * MIN);
    const L5 = await session('m1', { startedMs: nowMs - 3 * HOUR, currentMs: nowMs - 2 * HOUR - MIN, lastSeenMs: nowMs - 2 * HOUR - MIN + 30_000 });
    const L6 = await session('m1', { startedMs: nowMs - 20 * MIN, lastSeenMs: nowMs - 5 * MIN, endedMs: nowMs - 5 * MIN });
    const L8 = await session('m1', { startedMs: nowMs - 10 * MIN, lastSeenMs: null });
    const L9 = await session('admin', { startedMs: nowMs - 5 * MIN, currentMs: nowMs - MIN, lastSeenMs: nowMs - MIN });
    return { L1: L1.id, L2: L2.id, L2Hid: L2.hid, L3: L3.id, L4: L4.id, L5: L5.id, L6: L6.id, L8: L8.id, L9: L9.id };
  });
}

describe.skipIf(skipReason !== null)(skipReason ? `live sessions - SKIPPED: ${skipReason}` : 'live sessions (real Postgres, ADR-0027)', () => {
  let A: Fixture; // aggregates-only
  let B: Fixture; // full detail
  let LA: Live;
  let LB: Live;

  beforeAll(async () => {
    A = await seedDeployment('live-agg-co', 'aggregates-only');
    B = await seedDeployment('live-full-co', 'full');
    LA = await seedLive(A);
    LB = await seedLive(B);
  }, 120_000);
  afterAll(dropShellDatabase);

  const withRetention = (p: Person): Person => ({ ...p, deployment: { settings: { ...p.deployment.settings, retentionDays: 395 } } });
  const run = <T>(fx: Fixture, who: string, fn: (ctx: QueryCtx) => Promise<T>, now: Date = NOW) => asPerson(withRetention(fx.people[who]!), (ctx) => fn(ctx), now);

  describe('listActiveSessions', () => {
    it('full-mode admin: working (newest first) then idle; stale, ended, too old and pre-0017 sessions are absent', async () => {
      const out = await run(B, 'admin', (ctx) => listActiveSessions(ctx));
      expect(out.nowMs).toBe(nowMs);
      expect(out).toMatchObject({ ownOnly: false, truncated: false });
      expect(out.rows.map((r) => [r.id, r.state, r.sinceMs, r.elapsedMs])).toEqual([
        [LB.L9, 'working', nowMs - MIN, MIN],
        [LB.L1, 'working', nowMs - 4 * MIN, 4 * MIN],
        [LB.L2, 'idle', nowMs - 2 * MIN, 2 * MIN],
        [LB.L3, 'idle', nowMs - 10 * MIN, 10 * MIN],
      ]);
      for (const absent of [LB.L4, LB.L5, LB.L6, LB.L8]) expect(out.rows.map((r) => r.id)).not.toContain(absent);

      const l1 = out.rows.find((r) => r.id === LB.L1)!;
      expect(l1).toMatchObject({ turns: 1, runs: 0, tokens: 1100, lastOutcome: 'success', harness: 'claude-code', projectName: 'alpha', isMine: false });
      expect(l1.cost.usd).toBeGreaterThan(0);
      expect(l1.userId).toBe(B.people.m1!.id);
      expect(l1.userName).toBe('m1');

      const l2 = out.rows.find((r) => r.id === LB.L2)!;
      expect(l2).toMatchObject({ turns: 0, runs: 0, tokens: 0, lastOutcome: null, title: `Session ${LB.L2Hid.slice(0, 8)}` });
      expect(l2.cost.usd).toBe(0);
      expect(out.rows.find((r) => r.id === LB.L3)!.title).toBe('Stored title');
      expect(out.rows.find((r) => r.id === LB.L9)!.isMine).toBe(true);
    });

    it('member: own sessions only, with no user keys', async () => {
      const out = await run(B, 'm1', (ctx) => listActiveSessions(ctx));
      expect(out.rows.map((r) => r.id)).toEqual([LB.L1, LB.L2]);
      for (const r of out.rows) {
        expect(r).not.toHaveProperty('userId');
        expect(r).not.toHaveProperty('userName');
        expect(r.isMine).toBe(true);
      }
    });

    it('lead: never another team member session', async () => {
      const ids = (await run(B, 'lead', (ctx) => listActiveSessions(ctx))).rows.map((r) => r.id);
      expect(ids).not.toContain(LB.L3);
      expect(ids).toContain(LB.L1);
    });

    it('aggregates-only admin: only their own session, and no other user id anywhere in the payload', async () => {
      const out = await run(A, 'admin', (ctx) => listActiveSessions(ctx));
      expect(out.ownOnly).toBe(true);
      expect(out.rows.map((r) => r.id)).toEqual([LA.L9]);
      expect(out.rows[0]).not.toHaveProperty('userId');
      const json = JSON.stringify(out);
      for (const uid of A.userIds) expect(json).not.toContain(uid);
    });

    it('stale sessions do not crowd a long-running working session out of the row limit', async () => {
      const C = await seedDeployment('live-crowd-co', 'full');
      const m1 = C.people.m1!;
      const iso = (ms: number) => new Date(ms).toISOString();
      const workingId = '00000000-0000-4000-8000-0000000000aa';
      await C.owner.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        // 101 stale sessions seen 31+ min ago (newer than the working one's last signal) ...
        await tx.execute(sql`insert into agent_sessions (team_id, user_id, external_id, harness, started_at, last_seen_at)
          select ${C.teams.t1!}::uuid, ${m1.id}::uuid, 'claude-code:crowd-' || g, 'claude-code',
            ${iso(nowMs - 3 * HOUR)}::timestamptz, ${iso(nowMs - 31 * MIN)}::timestamptz - (g * interval '5 seconds')
          from generate_series(1, 101) g`);
        // ... and one session working since 60 min ago.
        await tx.execute(sql`insert into agent_sessions (id, team_id, user_id, external_id, harness, started_at, current_turn_started_at, last_seen_at)
          values (${workingId}::uuid, ${C.teams.t1!}::uuid, ${m1.id}::uuid, 'claude-code:crowd-work', 'claude-code',
            ${iso(nowMs - 2 * HOUR)}::timestamptz, ${iso(nowMs - HOUR)}::timestamptz, ${iso(nowMs - HOUR)}::timestamptz)`);
      });
      const out = await run(C, 'admin', (ctx) => listActiveSessions(ctx));
      expect(out.rows.map((r) => [r.id, r.state])).toEqual([[workingId, 'working']]);
      expect(out.truncated).toBe(false);
    }, 120_000);

    it('later, idle sessions go stale and leave the strip; working ones stay', async () => {
      const later = new Date(nowMs + 40 * MIN);
      const out = await run(B, 'admin', (ctx) => listActiveSessions(ctx, later));
      expect(out.nowMs).toBe(later.getTime());
      expect(out.rows.map((r) => [r.id, r.state])).toEqual([
        [LB.L9, 'working'],
        [LB.L1, 'working'],
      ]);
    });
  });

  describe('getLiveSession', () => {
    it('working session: the same payload (rev included) as the page builds from the session detail', async () => {
      const live = await run(B, 'm1', (ctx) => getLiveSession(ctx, LB.L1));
      expect(live).not.toBeNull();
      expect(live!.status).toEqual({ state: 'working', sinceMs: nowMs - 4 * MIN, elapsedMs: 4 * MIN });
      expect(live).toMatchObject({ nowMs, currentTurnStartedMs: nowMs - 4 * MIN, turns: 1, tokens: 1100, endedMs: null });
      expect(live!.cost.usd).toBeGreaterThan(0);
      const detail = await run(B, 'm1', (ctx) => getSessionDetail(ctx, LB.L1));
      expect(live!.rev).toBe(toLiveSessionPayload(detail!.session, nowMs).rev);
    });

    it('not visible, not a uuid → null; an ended session is ended', async () => {
      expect(await run(B, 'm2', (ctx) => getLiveSession(ctx, LB.L1))).toBeNull();
      expect(await run(B, 'm1', (ctx) => getLiveSession(ctx, 'x'))).toBeNull();
      expect((await run(B, 'm1', (ctx) => getLiveSession(ctx, LB.L6)))!.status.state).toBe('ended');
    });
  });

  it('a session without a turn has a detail page with no turns, but the sessions list still finds sessions through turns', async () => {
    const detail = await run(B, 'm1', (ctx) => getSessionDetail(ctx, LB.L2));
    expect(detail).not.toBeNull();
    expect(detail!.turns).toEqual([]);
    expect(detail!.session).toMatchObject({ turns: 0, lastTurnEndedMs: null, lastOutcome: null, currentTurnStartedMs: null, lastSeenMs: nowMs - 2 * MIN });
    const list = await run(B, 'm1', (ctx) => listSessions(ctx, defaultFilters()));
    const ids = list.rows.map((r) => r.id);
    expect(ids).not.toContain(LB.L2);
    expect(ids).toContain(LB.L1);
  });
});
