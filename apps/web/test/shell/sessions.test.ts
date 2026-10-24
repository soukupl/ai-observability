import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runs, turns, usage } from '@ai-obs/db';
import { defaultFilters, type Filters } from '../../src/lib/filters';
import {
  buildExportTable,
  getFlows,
  getSessionDetail,
  getSessionLink,
  getTurnDetail,
  harnessSessionId,
  listSessions,
  listTurns,
  parseSessionId,
  resumeCommand,
  sessionTitle,
  type QueryCtx,
  type SessionDetail,
} from '../../src/lib/queries';
import { outcomeMix, sessionGraph, sessionsListHref, toSessionTableRows } from '../../src/app/(dashboard)/sessions/_helpers';
import { timelineGraph } from '../../src/app/(dashboard)/agents/timeline-view';
import { asPerson, dropShellDatabase, NOW, prepareShellDatabase, seedDeployment, type Fixture, type Person } from './harness';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const nowMs = NOW.getTime();

describe('session helpers (pure)', () => {
  it('sessionTitle: stored title, else first summary, else the start of the harness id', () => {
    expect(sessionTitle({ title: ' Renamed ', firstSummary: 'Fix login', harnessSessionId: 'abcdef1234' })).toBe('Renamed');
    expect(sessionTitle({ title: null, firstSummary: 'Fix login', harnessSessionId: 'abcdef1234' })).toBe('Fix login');
    expect(sessionTitle({ title: '  ', firstSummary: '  ', harnessSessionId: 'abcdef1234' })).toBe('Session abcdef12');
    expect(sessionTitle({ firstSummary: null, harnessSessionId: 'abc' })).toBe('Session abc');
  });

  it('harnessSessionId strips only its own harness prefix', () => {
    expect(harnessSessionId('claude-code:04cf0fd7-74fd', 'claude-code')).toBe('04cf0fd7-74fd');
    expect(harnessSessionId('codex:xyz', 'claude-code')).toBe('codex:xyz');
  });

  it('resumeCommand per harness', () => {
    expect(resumeCommand('claude-code', 'abc')).toBe('claude --resume abc');
    expect(resumeCommand('codex', 'abc')).toBe('codex resume abc');
    expect(resumeCommand('other', 'abc')).toBeNull();
  });

  it('parseSessionId accepts uuids only (first value, lower-cased)', () => {
    expect(parseSessionId('0F8C2B4E-1111-4222-8333-444455556666')).toBe('0f8c2b4e-1111-4222-8333-444455556666');
    expect(parseSessionId(['0f8c2b4e-1111-4222-8333-444455556666', 'x'])).toBe('0f8c2b4e-1111-4222-8333-444455556666');
    for (const v of [undefined, null, '', 'abc', "1' or 1=1"]) expect(parseSessionId(v)).toBeNull();
  });

  it('outcomeMix lists the non-zero counts in a fixed order', () => {
    expect(outcomeMix({ success: 2, failed: 0, abandoned: 1, unknown: 3 })).toBe('2 success · 1 abandoned · 3 unknown');
    expect(outcomeMix({ success: 0, failed: 0, abandoned: 0, unknown: 0 })).toBe('—');
  });

  it('sessionsListHref keeps the filters and sets the page', () => {
    expect(sessionsListHref({ range: '7d', page: '3' }, { page: 2 })).toBe('/sessions?range=7d&page=2');
    expect(sessionsListHref({ range: '7d', page: '3' }, { page: 1 })).toBe('/sessions?range=7d');
    expect(sessionsListHref({}, {})).toBe('/sessions');
  });

  it('timeline session lanes link to the session page only when asked (never for aggregate pseudonyms)', () => {
    const r = {
      window: { day: '2026-10-05', fromMin: 0, toMin: 1440, fromMs: Date.parse('2026-10-05T00:00:00Z'), toMs: Date.parse('2026-10-06T00:00:00Z') },
      turns: [
        { id: 't1', sessionId: 's-1', projectId: null, projectName: null, harness: 'claude-code', model: null, startedMs: nowMs, endedMs: nowMs + MIN, durationMs: MIN, outcome: 'success' as const, summary: null, tokens: 0, isMine: true },
        { id: 't2', sessionId: null, projectId: null, projectName: null, harness: 'claude-code', model: null, startedMs: nowMs, endedMs: nowMs + MIN, durationMs: MIN, outcome: 'success' as const, summary: null, tokens: 0, isMine: true },
      ],
      runs: [],
    };
    const linked = timelineGraph(r, undefined, undefined, { sessionLinks: true });
    expect(linked.lanes.map((l) => [l.id, l.href ?? null])).toEqual([
      ['s:s-1', '/sessions/s-1'],
      ['t:t2', null],
    ]);
    expect(timelineGraph(r).lanes.every((l) => !l.href)).toBe(true);
  });
});

describe('sessionGraph (pure)', () => {
  it('one lane over the whole session, runs link to their flow or their turn', () => {
    const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
    const base = { parentRunId: null, agentType: 'workflow:review:a', agentGroup: 'workflow:review', orchestrationId: 'wf_1', stageIndex: 0, depth: 1, model: null, effort: null, durationMs: MIN, tokens: tok, outcome: 'success' as const };
    const d = {
      session: { startedMs: nowMs, lastActivityMs: nowMs + 2 * HOUR, projectId: null, projectName: 'alpha', harness: 'claude-code' },
      turns: [{ id: 't1', startedMs: nowMs, endedMs: nowMs + 10 * MIN, durationMs: 10 * MIN, outcome: 'success', summary: 'Do it' }],
      runs: [
        { ...base, id: 'r1', turnId: 't1', startedMs: nowMs + MIN, endedMs: nowMs + 2 * HOUR },
        { ...base, id: 'r2', turnId: 't1', startedMs: nowMs + 2 * MIN, endedMs: nowMs + 3 * MIN, orchestrationId: null, agentType: 'Explore' },
      ],
      flows: [{ turnId: 't1', key: 'wf_1', turn: { startedMs: nowMs }, steps: [{ runId: 'r1' }] }],
    } as unknown as SessionDetail;
    const g = sessionGraph(d);
    expect(g.lanes).toEqual([{ id: 'session', label: 'alpha', sublabel: 'claude-code', colorIndex: 0 }]);
    expect(g.fromMs).toBeLessThan(nowMs);
    expect(g.toMs).toBeGreaterThan(nowMs + 2 * HOUR); // runs that outlive the turn stay on the axis
    expect(g.runs.map((r) => [r.id, r.href])).toEqual([
      ['r1', `/turns/t1?startedMs=${nowMs}#flow-wf_1`],
      ['r2', `/turns/t1?startedMs=${nowMs}`],
    ]);
  });
});

const skipReason = await prepareShellDatabase();
if (skipReason) console.warn(`[web/shell] session tests skipped: ${skipReason}`);

/** Sessions seeded on top of the shared fixture (whose turns have no session). Times are relative to NOW. */
interface Seeded {
  s1: string; // m1, alpha, open: turns 3 h and 2 h ago, a two-agent workflow running until 10 min ago
  s2: string; // lead, ended an hour ago, one turn without a summary
  s3: string; // m2 (team t2)
  s4: string; // m1, started 400 days ago (before the retention cutoff), one turn 2 days ago
  s5: string; // m1, one turn 10 days ago (outside a 7-day range), titled from the harness (ADR-0026)
  s1Turns: [string, string];
  s1Hid: string;
  s2Hid: string;
}

async function seedSessions(fx: Fixture): Promise<Seeded> {
  return fx.owner.transaction(async (tx) => {
    await tx.execute(sql`set local role app_definer`);
    const p = (k: string) => fx.people[k]!;
    const teamOf = (k: string) => (k === 'm2' ? fx.teams.t2! : fx.teams.t1!);
    const session = async (who: string, startedMs: number, opts: { endedMs?: number; reason?: string; project?: string | null; title?: string } = {}) => {
      const id = randomUUID();
      const hid = randomUUID();
      const projectId = opts.project === null ? null : fx.projects[opts.project ?? 'alpha']!;
      await tx.execute(sql`insert into agent_sessions (id, team_id, user_id, project_id, external_id, harness, started_at, ended_at, end_reason, title, title_source)
        values (${id}::uuid, ${teamOf(who)}::uuid, ${p(who).id}::uuid, ${projectId}::uuid, ${`claude-code:${hid}`},
          'claude-code', ${new Date(startedMs).toISOString()}::timestamptz, ${opts.endedMs ? new Date(opts.endedMs).toISOString() : null}::timestamptz, ${opts.reason ?? null}, ${opts.title ?? null}, ${opts.title ? 'custom' : null})`);
      return { id, hid };
    };
    const turn = async (who: string, sessionId: string, startedMs: number, durationMs: number, outcome: 'success' | 'failed' | 'unknown', summary: string | null) => {
      const id = randomUUID();
      const owner = { teamId: teamOf(who), userId: p(who).id };
      await tx.insert(turns).values({
        id, ...owner, attribution: 'verified', sessionId, projectId: fx.projects.alpha!, externalId: `sx-${id}`, harness: 'claude-code',
        model: 'claude-opus-5-5', effort: 'high', startedAt: new Date(startedMs), endedAt: new Date(startedMs + durationMs), durationMs,
        inputTokens: 1000, outputTokens: 100, outcome, summary, skills: { tdd: { model: 1, user: 0 } }, mcp: {},
      });
      await tx.insert(usage).values({
        ...owner, turnId: id, runId: null, startedAt: new Date(startedMs), model: 'claude-opus-5-5', effort: 'high',
        inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 1,
      });
      return id;
    };
    const run = async (who: string, turnId: string, startedMs: number, endedMs: number, over: Partial<typeof runs.$inferInsert> = {}) => {
      await tx.insert(runs).values({
        id: randomUUID(), teamId: teamOf(who), userId: p(who).id, turnId, turnExternalId: `sx-${turnId}`, externalId: randomUUID(),
        agentType: 'Explore', depth: 1, model: 'claude-opus-5-5', startedAt: new Date(startedMs), endedAt: new Date(endedMs),
        durationMs: endedMs - startedMs, inputTokens: 10, outputTokens: 1, outcome: 'success', mcp: { github: { search: 1 } }, ...over,
      });
    };

    const s1 = await session('m1', nowMs - 3 * HOUR - MIN);
    const t1 = await turn('m1', s1.id, nowMs - 3 * HOUR, 10 * MIN, 'success', null);
    const t2 = await turn('m1', s1.id, nowMs - 2 * HOUR, 5 * MIN, 'failed', 'Fix login');
    await run('m1', t1, nowMs - 3 * HOUR + MIN, nowMs - 20 * MIN, { agentType: 'workflow:review:login', agentGroup: 'workflow:review', orchestrationId: 'wf_s1', stageIndex: 0 });
    await run('m1', t1, nowMs - 3 * HOUR + 2 * MIN, nowMs - 10 * MIN, { agentType: 'workflow:verify:login', agentGroup: 'workflow:verify', orchestrationId: 'wf_s1', stageIndex: 1 });
    await run('m1', t2, nowMs - 2 * HOUR + MIN, nowMs - 2 * HOUR + 2 * MIN);

    const s2 = await session('lead', nowMs - 2 * HOUR, { endedMs: nowMs - HOUR, reason: 'exit' });
    await turn('lead', s2.id, nowMs - 90 * MIN, 5 * MIN, 'unknown', null);

    const s3 = await session('m2', nowMs - 5 * HOUR, { project: 'beta' });
    await turn('m2', s3.id, nowMs - 5 * HOUR, 5 * MIN, 'success', 'Beta work');

    const s4 = await session('m1', nowMs - 400 * DAY, { project: null });
    await turn('m1', s4.id, nowMs - 2 * DAY, 5 * MIN, 'success', 'Long-lived');

    const s5 = await session('m1', nowMs - 10 * DAY, { title: 'Renamed in Claude Code' });
    await turn('m1', s5.id, nowMs - 10 * DAY, 5 * MIN, 'success', 'Older work');

    return { s1: s1.id, s2: s2.id, s3: s3.id, s4: s4.id, s5: s5.id, s1Turns: [t1, t2], s1Hid: s1.hid, s2Hid: s2.hid };
  });
}

describe.skipIf(skipReason !== null)(skipReason ? `sessions view - SKIPPED: ${skipReason}` : 'sessions view (real Postgres)', () => {
  let A: Fixture; // aggregates-only
  let B: Fixture; // full detail
  let SA: Seeded;
  let SB: Seeded;

  beforeAll(async () => {
    A = await seedDeployment('sess-agg-co', 'aggregates-only');
    B = await seedDeployment('sess-full-co', 'full');
    SA = await seedSessions(A);
    SB = await seedSessions(B);
  }, 120_000);
  afterAll(dropShellDatabase);

  /** The fixture people carry no retention setting; give them the seeded deployment's 395 days. */
  const withRetention = (p: Person): Person => ({ ...p, deployment: { settings: { ...p.deployment.settings, retentionDays: 395 } } });
  const run = <T>(fx: Fixture, who: string, fn: (ctx: QueryCtx) => Promise<T>) => asPerson(withRetention(fx.people[who]!), (ctx) => fn(ctx));
  const f = (over: Partial<Filters> = {}): Filters => ({ ...defaultFilters(), ...over });
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  describe('listSessions', () => {
    it('whole-session totals: span to the last run, workflows, flows, outcome mix, cost, open', async () => {
      const list = await run(B, 'm1', (ctx) => listSessions(ctx, f()));
      const s1 = list.rows.find((r) => r.id === SB.s1)!;
      expect(s1).toMatchObject({
        harness: 'claude-code',
        harnessSessionId: SB.s1Hid,
        title: 'Fix login', // the first turn has no summary yet: the first summarized one names the session
        projectName: 'alpha',
        turns: 2,
        runs: 3,
        workflows: 1,
        flows: 1,
        outcomes: { success: 1, failed: 1, abandoned: 0, unknown: 0 },
        endedMs: null,
        open: true, // last activity (a workflow agent) 10 minutes ago
        isMine: true,
      });
      expect(s1.startedMs).toBe(nowMs - 3 * HOUR - MIN);
      expect(s1.lastActivityMs).toBe(nowMs - 10 * MIN);
      expect(s1.spanMs).toBe(3 * HOUR - 9 * MIN);
      expect(s1.tokens.total).toBe(2200);
      expect(s1.cost.usd).toBeGreaterThan(0);
      expect(s1).not.toHaveProperty('userId'); // members never get user fields
    });

    it('newest first; the range keeps sessions active in it', async () => {
      const all = await run(B, 'm1', (ctx) => listSessions(ctx, f()));
      expect(ids(all.rows)).toEqual([SB.s1, SB.s5, SB.s4]); // by first activity: 3 h, 10 days, 400 days ago
      const week = await run(B, 'm1', (ctx) => listSessions(ctx, f({ range: '7d' })));
      expect(ids(week.rows)).not.toContain(SB.s5);
      expect(ids(week.rows)).toContain(SB.s4); // started 400 days ago, active 2 days ago
      expect(week.total).toBe(week.rows.length);
    });

    it('paging', async () => {
      const p1 = await run(B, 'admin', (ctx) => listSessions(ctx, f(), { page: 1, pageSize: 2 }));
      const p2 = await run(B, 'admin', (ctx) => listSessions(ctx, f(), { page: 2, pageSize: 2 }));
      expect(p1.total).toBe(5);
      expect(p1.rows).toHaveLength(2);
      expect(new Set([...ids(p1.rows), ...ids(p2.rows)]).size).toBe(4);
      const past = await run(B, 'admin', (ctx) => listSessions(ctx, f(), { page: 9, pageSize: 2 }));
      expect(past.rows).toHaveLength(0);
      expect(past.total).toBe(5); // a page past the end still knows the count
    });

    it('filters pick sessions by their turns (project)', async () => {
      const beta = await run(B, 'admin', (ctx) => listSessions(ctx, f({ projectId: B.projects.beta! })));
      // every seeded session's turns are on alpha (s3's session row says beta): a beta filter finds none, alpha all five
      expect(ids(beta.rows)).toEqual([]);
      const alpha = await run(B, 'admin', (ctx) => listSessions(ctx, f({ projectId: B.projects.alpha! })));
      expect(alpha.total).toBe(5);
    });

    it('a stored harness title wins over the first turn summary', async () => {
      const list = await run(B, 'm1', (ctx) => listSessions(ctx, f()));
      expect(list.rows.find((r) => r.id === SB.s5)?.title).toBe('Renamed in Claude Code');
      expect(await run(B, 'm1', (ctx) => getSessionLink(ctx, SB.s5))).toEqual({ id: SB.s5, title: 'Renamed in Claude Code' });
    });

    it('an ended session without a summary', async () => {
      const list = await run(B, 'lead', (ctx) => listSessions(ctx, f()));
      const s2 = list.rows.find((r) => r.id === SB.s2)!;
      expect(s2).toMatchObject({ title: `Session ${SB.s2Hid.slice(0, 8)}`, endReason: 'exit', open: false, flows: 0, workflows: 0, runs: 0 });
      expect(s2.endedMs).toBe(nowMs - HOUR);
      expect(s2.lastActivityMs).toBe(nowMs - HOUR); // the session end is the last activity
    });
  });

  describe('visibility', () => {
    it('full mode: members see their own, a lead their team, an admin everyone (with user names)', async () => {
      expect(new Set(ids((await run(B, 'm1', (ctx) => listSessions(ctx, f()))).rows))).toEqual(new Set([SB.s1, SB.s4, SB.s5]));
      expect(new Set(ids((await run(B, 'm2', (ctx) => listSessions(ctx, f()))).rows))).toEqual(new Set([SB.s3]));
      const lead = await run(B, 'lead', (ctx) => listSessions(ctx, f()));
      expect(new Set(ids(lead.rows))).toEqual(new Set([SB.s1, SB.s2, SB.s4, SB.s5]));
      expect(lead.ownOnly).toBe(false);
      expect(lead.rows.find((r) => r.id === SB.s1)).toMatchObject({ userName: 'm1', isMine: false });
      const admin = await run(B, 'admin', (ctx) => listSessions(ctx, f()));
      expect(new Set(ids(admin.rows))).toEqual(new Set([SB.s1, SB.s2, SB.s3, SB.s4, SB.s5]));
    });

    it('aggregates-only mode: leads and admins see only their own sessions, never user fields', async () => {
      const lead = await run(A, 'lead', (ctx) => listSessions(ctx, f()));
      expect(ids(lead.rows)).toEqual([SA.s2]);
      expect(lead.ownOnly).toBe(true);
      expect(lead.rows[0]).not.toHaveProperty('userId');
      const admin = await run(A, 'admin', (ctx) => listSessions(ctx, f()));
      expect(admin.rows).toEqual([]);
      expect(admin.total).toBe(0);
      const m1 = await run(A, 'm1', (ctx) => listSessions(ctx, f()));
      expect(new Set(ids(m1.rows))).toEqual(new Set([SA.s1, SA.s4, SA.s5]));
      expect(m1.ownOnly).toBe(false);
    });

    it('detail and link: visible sessions only', async () => {
      expect(await run(A, 'lead', (ctx) => getSessionDetail(ctx, SA.s1))).toBeNull();
      expect(await run(A, 'lead', (ctx) => getSessionLink(ctx, SA.s1))).toBeNull();
      expect(await run(A, 'lead', (ctx) => getSessionLink(ctx, SA.s2))).toEqual({ id: SA.s2, title: `Session ${SA.s2Hid.slice(0, 8)}` });
      expect(await run(B, 'm2', (ctx) => getSessionDetail(ctx, SB.s1))).toBeNull();
      expect(await run(B, 'm1', (ctx) => getSessionDetail(ctx, 'not-a-uuid'))).toBeNull();
      expect(await run(B, 'm1', (ctx) => getSessionDetail(ctx, randomUUID()))).toBeNull();
      const lead = await run(B, 'lead', (ctx) => getSessionDetail(ctx, SB.s1));
      expect(lead?.session).toMatchObject({ userName: 'm1' });
    });

    it('the session filter on turns and flows follows RLS (aggregates-only lead: nothing of someone else)', async () => {
      const own = await run(B, 'm1', (ctx) => listTurns(ctx, f({ range: '7d' }), { sessionId: SB.s1 }));
      expect(new Set(ids(own.rows))).toEqual(new Set(SB.s1Turns));
      expect(own.total).toBe(2);
      // the date range does not apply to a session filter
      const older = await run(B, 'm1', (ctx) => listTurns(ctx, f({ range: 'custom', from: '2026-01-01', to: '2026-01-02' }), { sessionId: SB.s5 }));
      expect(older.total).toBe(1);
      const agg = await run(A, 'lead', (ctx) => listTurns(ctx, f(), { sessionId: SA.s1 }));
      expect(agg.rows).toEqual([]);
      const aggOwn = await run(A, 'lead', (ctx) => listTurns(ctx, f(), { sessionId: SA.s2 }));
      expect(aggOwn.total).toBe(1);
      expect(aggOwn.rows[0]).not.toHaveProperty('userId');

      const flows = await run(B, 'm1', (ctx) => getFlows(ctx, f(), { page: 1, outcome: null, sessionId: SB.s1 }));
      expect(flows.flows.map((x) => [x.kind, x.steps.length])).toEqual([['workflow', 2]]);
      const aggFlows = await run(A, 'lead', (ctx) => getFlows(ctx, f(), { page: 1, outcome: null, sessionId: SA.s1 }));
      expect(aggFlows.total).toBe(0);
    });
  });

  describe('getSessionDetail', () => {
    it('turns in order with costs, runs, flows, workflows, merged skills & MCP', async () => {
      const d = (await run(B, 'm1', (ctx) => getSessionDetail(ctx, SB.s1)))!;
      expect(d.turns.map((t) => t.id)).toEqual(SB.s1Turns);
      expect(d.turns.map((t) => t.runs)).toEqual([2, 1]);
      expect(d.turns.every((t) => (t.cost.usd ?? 0) > 0)).toBe(true);
      expect(d.session.cost.usd).toBeCloseTo(d.turns.reduce((s, t) => s + (t.cost.usd ?? 0), 0), 9);
      expect(d.runs).toHaveLength(3);
      expect(d.flows).toHaveLength(1);
      expect(d.workflows).toEqual([
        expect.objectContaining({ orchestrationId: 'wf_s1', turnId: SB.s1Turns[0], steps: 2, endedMs: nowMs - 10 * MIN }),
      ]);
      expect(d.workflows[0]!.flow?.key).toBe(d.flows[0]!.key);
      expect(d.skills).toEqual({ tdd: { model: 2, user: 0 } });
      expect(d.mcp).toEqual({ github: { search: 3 } });
      expect(d.retentionCut).toBe(false);
      expect(d.truncated).toBe(false);
    });

    it('flags a session that started before the retention cutoff', async () => {
      const d = (await run(B, 'm1', (ctx) => getSessionDetail(ctx, SB.s4)))!;
      expect(d.retentionCut).toBe(true);
      expect(d.turns).toHaveLength(1);
      expect(d.session.projectName).toBe('alpha'); // the session row has no project: its turns' project is used
    });

    it('a turn knows its session; the link carries the title', async () => {
      const t = await run(B, 'm1', (ctx) => getTurnDetail(ctx, SB.s1Turns[0]));
      expect(t?.turn.sessionId).toBe(SB.s1);
      expect(await run(B, 'm1', (ctx) => getSessionLink(ctx, t!.turn.sessionId))).toEqual({ id: SB.s1, title: 'Fix login' });
      // someone else's turn seen through the aggregate functions carries no session
      const agg = await run(A, 'lead', (ctx) => getTurnDetail(ctx, SA.s1Turns[0], nowMs - 3 * HOUR));
      expect(agg?.limited).toBe(true);
      expect(agg?.turn.sessionId).toBeNull();
    });
  });

  describe('exports', () => {
    it('sessions CSV: one row per session, user column only when allowed', async () => {
      const full = await run(B, 'admin', (ctx) => buildExportTable(ctx, 'sessions', f()));
      expect(full.headers).toContain('user');
      expect(full.headers).toContain('session_id');
      expect(full.rows).toHaveLength(5);
      const agg = await run(A, 'lead', (ctx) => buildExportTable(ctx, 'sessions', f()));
      expect(agg.headers).not.toContain('user');
      expect(agg.rows).toHaveLength(1);
      expect(JSON.stringify(agg.rows)).not.toContain(A.people.m1!.id);
    });

    it('turns and flows CSV honour the session', async () => {
      const t = await run(B, 'm1', (ctx) => buildExportTable(ctx, 'turns', f(), { sessionId: SB.s1 }));
      expect(t.rows).toHaveLength(2);
      const fl = await run(B, 'm1', (ctx) => buildExportTable(ctx, 'flows', f(), { sessionId: SB.s1 }));
      expect(fl.rows).toHaveLength(1);
    });
  });

  it('table rows mark open sessions', async () => {
    const list = await run(B, 'm1', (ctx) => listSessions(ctx, f()));
    const rows = toSessionTableRows(list.rows);
    expect(rows.find((r) => r.id === SB.s1)).toMatchObject({ title: 'Fix login (open)', href: `/sessions/${SB.s1}`, outcomes: '1 success · 1 failed' });
  });
});
