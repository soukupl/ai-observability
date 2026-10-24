import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultFilters, type Filters } from '../../src/lib/filters';
import type { QueryCtx } from '../../src/lib/queries/scope';
import {
  capRows,
  getAgentTimeline,
  formatHhMm,
  mapTimelineRun,
  mapTimelineTurn,
  overlapsWindow,
  parseHhMm,
  parseTimelineWindow,
  TIMELINE_PARAMS,
} from '../../src/lib/queries/agent-timeline';
import { TIMELINE_WINDOW_PARAMS } from '../../src/components/charts/agent-graph-layout';
import { asPerson, dropShellDatabase, prepareShellDatabase, seedDeployment, type Fixture } from './harness';

const range = { fromDay: '2026-09-29', toDay: '2026-10-06' }; // 7 days, last = 2026-10-05
const DAY = Date.parse('2026-10-03T00:00:00Z');
const M = 60_000;

describe('parseTimelineWindow', () => {
  it('defaults to the last day with turns, whole day', () => {
    const w = parseTimelineWindow({}, ['2026-10-01', '2026-10-03'], range);
    expect(w).toEqual({ day: '2026-10-03', fromMin: 0, toMin: 1440, fromMs: DAY, toMs: DAY + 1440 * M });
  });

  it('without days, defaults to the last day of the range', () => {
    expect(parseTimelineWindow({}, [], range).day).toBe('2026-10-05');
  });

  it('accepts a day inside the range even when it has no turns', () => {
    expect(parseTimelineWindow({ day: '2026-09-30' }, ['2026-10-03'], range).day).toBe('2026-09-30');
    expect(parseTimelineWindow({ day: '2026-09-29' }, [], range).day).toBe('2026-09-29');
  });

  it('rejects a day outside the range or malformed', () => {
    for (const day of ['2026-10-06', '2026-09-28', '2026-13-01', '2026-02-30', 'yesterday', '']) {
      expect(parseTimelineWindow({ day }, ['2026-10-03'], range).day).toBe('2026-10-03');
    }
  });

  it('takes the first value of repeated params', () => {
    expect(parseTimelineWindow({ day: ['2026-10-01', '2026-10-02'] }, [], range).day).toBe('2026-10-01');
  });

  it('parses HH:MM from / to', () => {
    const w = parseTimelineWindow({ day: '2026-10-03', fromH: '09:30', toH: '11:05' }, [], range);
    expect(w).toMatchObject({ fromMin: 570, toMin: 665, fromMs: DAY + 570 * M, toMs: DAY + 665 * M });
    expect(parseTimelineWindow({ day: '2026-10-03', fromH: '9:05' }, [], range)).toMatchObject({ fromMin: 545, toMin: 1440 });
    expect(parseTimelineWindow({ day: '2026-10-03', toH: '00:01' }, [], range)).toMatchObject({ fromMin: 0, toMin: 1 });
  });

  it('ignores the filter bar\'s from / to (custom date range) and reads fromH / toH', () => {
    expect(parseTimelineWindow({ day: '2026-10-03', from: '2026-10-01', to: '2026-10-05' }, [], range)).toMatchObject({ fromMin: 0, toMin: 1440 });
    expect(TIMELINE_PARAMS).toEqual({ day: 'day', from: 'fromH', to: 'toH' });
    expect(TIMELINE_WINDOW_PARAMS).toEqual({ from: TIMELINE_PARAMS.from, to: TIMELINE_PARAMS.to });
  });

  it('allows "24:00" as the end', () => {
    const w = parseTimelineWindow({ day: '2026-10-03', fromH: '22:00', toH: '24:00' }, [], range);
    expect(w).toMatchObject({ fromMin: 1320, toMin: 1440, toMs: DAY + 1440 * M });
  });

  it('invalid or empty ranges fall back to the whole day', () => {
    const whole = { fromMin: 0, toMin: 1440 };
    for (const [from, to] of [
      ['10:00', '10:00'],
      ['11:00', '10:00'],
      ['24:00', undefined],
      ['25:00', '26:00'],
      ['10:60', '11:00'],
      ['24:01', undefined],
      ['ten', '11:00'],
      ['10:00', '11'],
      [undefined, '00:00'],
    ] as const) {
      expect(parseTimelineWindow({ day: '2026-10-03', fromH: from, toH: to }, [], range)).toMatchObject(whole);
    }
  });
});

describe('HH:MM helpers', () => {
  it('parse and format round-trip', () => {
    expect(parseHhMm('00:00')).toBe(0);
    expect(parseHhMm(' 07:45 ')).toBe(465);
    expect(parseHhMm('24:00')).toBe(1440);
    expect(parseHhMm('24:30')).toBeNull();
    expect(parseHhMm(undefined)).toBeNull();
    expect(formatHhMm(0)).toBe('00:00');
    expect(formatHhMm(465)).toBe('07:45');
    expect(formatHhMm(1440)).toBe('24:00');
    expect(formatHhMm(9999)).toBe('24:00');
  });
});

describe('capRows / overlapsWindow', () => {
  it('flags truncation only when more than the limit came back', () => {
    expect(capRows([1, 2, 3], 3)).toEqual({ rows: [1, 2, 3], truncated: false });
    expect(capRows([1, 2, 3, 4], 3)).toEqual({ rows: [1, 2, 3], truncated: true });
    expect(capRows([], 3)).toEqual({ rows: [], truncated: false });
  });

  it('overlap is start < to and end > from', () => {
    const w = { fromMs: 100, toMs: 200 };
    expect(overlapsWindow(50, 150, w)).toBe(true); // started before, still running
    expect(overlapsWindow(150, 250, w)).toBe(true); // runs past the end
    expect(overlapsWindow(50, 250, w)).toBe(true); // spans the window
    expect(overlapsWindow(50, 100, w)).toBe(false); // ended exactly at the start
    expect(overlapsWindow(200, 250, w)).toBe(false); // starts exactly at the end
  });
});

describe('row mapping', () => {
  const tokens = { input_tokens: '10', output_tokens: '5', cache_read_tokens: '100', cache_write_tokens: '1', reasoning_tokens: '2' };

  it('maps a turn with its project name and no user fields', () => {
    const t = mapTimelineTurn(
      { id: 't1', session_id: 's1', project_id: 'p1', harness: 'claude-code', model: null, started_ms: '1000', ended_ms: '5000', duration_ms: '4000', outcome: 'success', summary: null, is_mine: true, ...tokens },
      new Map([['p1', 'Alpha']]),
    );
    expect(t).toEqual({
      id: 't1', sessionId: 's1', projectId: 'p1', projectName: 'Alpha', harness: 'claude-code', model: null,
      startedMs: 1000, endedMs: 5000, durationMs: 4000, outcome: 'success', summary: null, tokens: 116, isMine: true,
    });
    expect(Object.keys(t)).not.toContain('userId');
    const orphan = mapTimelineTurn({ id: 't2', session_id: null, project_id: null, harness: 'codex', started_ms: 0, ended_ms: 0, outcome: 'unknown', is_mine: false }, new Map());
    expect(orphan).toMatchObject({ sessionId: null, projectId: null, projectName: null, tokens: 0, isMine: false });
  });

  it('maps a run and groups it (stored group wins, else derived)', () => {
    const base = { id: 'r1', turn_id: 't1', parent_run_id: null, depth: 1, model: 'm', started_ms: '1', ended_ms: '2', duration_ms: '1', outcome: 'failed', ...tokens };
    expect(mapTimelineRun({ ...base, agent_type: 'workflow:impl-m08-t02b', agent_group: null, orchestration_id: null })).toMatchObject({
      agentType: 'workflow:impl-m08-t02b', agentGroup: 'workflow:impl', orchestrationId: null, parentRunId: null, depth: 1, tokens: 116, outcome: 'failed',
    });
    expect(mapTimelineRun({ ...base, parent_run_id: 'r0', agent_type: 'workflow:x', agent_group: 'workflow:verify', orchestration_id: 'wf_01' })).toMatchObject({
      agentGroup: 'workflow:verify', orchestrationId: 'wf_01', parentRunId: 'r0', stageIndex: null, flowKey: null,
    });
    expect(mapTimelineRun({ ...base, agent_type: 'workflow:verify:bugs', agent_group: null, orchestration_id: 'wf_01', stage_index: 2, flow_key: 'bugs' })).toMatchObject({
      stageIndex: 2, flowKey: 'bugs',
    });
    expect(mapTimelineRun({ ...base, agent_type: 'x', stage_index: '0' }).stageIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Real Postgres: both read paths (skips without Postgres, like queries.test.ts)
// ---------------------------------------------------------------------------------------------
const skipReason = await prepareShellDatabase();
if (skipReason) console.warn(`[web/shell] agent timeline tests skipped: ${skipReason}`);

const R30: Filters = { ...defaultFilters(), range: '30d' };
/** Row ids differ between the two fixtures: compare canonical forms. */
const canon = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(x) ? '<id>' : x)));

describe.skipIf(skipReason !== null)(skipReason ? `agent timeline - SKIPPED: ${skipReason}` : 'agent timeline (real Postgres)', () => {
  let A: Fixture; // aggregates-only
  let B: Fixture; // full detail (identical data)

  beforeAll(async () => {
    A = await seedDeployment('tl-agg-co', 'aggregates-only');
    B = await seedDeployment('tl-full-co', 'full');
  }, 120_000);
  afterAll(dropShellDatabase);

  const run = <T>(fx: Fixture, who: string, fn: (ctx: QueryCtx) => Promise<T>) => asPerson(fx.people[who]!, (ctx) => fn(ctx));

  it('defaults to the last day with turns; turns, runs and groups of the whole day', async () => {
    const d = await run(B, 'admin', (ctx) => getAgentTimeline(ctx, R30, {}));
    expect(d.window).toMatchObject({ day: '2026-10-05', fromMin: 0, toMin: 1440 });
    expect(d.days).toHaveLength(30);
    expect(d.days.at(-1)).toBe('2026-10-05');
    expect(d.turns).toHaveLength(4); // one per user, 09:00..12:00
    expect(d.turns.map((t) => t.projectName)).toEqual(['alpha', 'beta', 'alpha', 'beta']);
    expect(d.turns.every((t) => t.sessionId === null)).toBe(true);
    const perTurn = d.runs.filter((r) => r.depth === 1);
    expect(perTurn).toHaveLength(4);
    expect(perTurn.every((r) => r.agentType === 'Explore' && r.agentGroup === 'Explore' && r.parentRunId === null)).toBe(true);
    for (const r of d.runs.filter((x) => x.depth === 2)) {
      expect(r.agentGroup).toBe('general-purpose');
      expect(d.runs.find((p) => p.id === r.parentRunId)?.turnId).toBe(r.turnId);
    }
    expect(d.truncated).toEqual({ turns: false, runs: false, links: false });
    // The seed has no siblings (one depth-1 run per turn, at most one child): no links stored or derived.
    expect(d.links).toEqual([]);
    expect(d.runs.every((r) => r.stageIndex === null && r.flowKey === null)).toBe(true);
    expect(d.turns.filter((t) => t.isMine)).toHaveLength(1);
  });

  it('aggregate path returns the same window with no user ids', async () => {
    const d = await run(B, 'admin', (ctx) => getAgentTimeline(ctx, R30, { day: '2026-10-03' }));
    const a = await run(A, 'admin', (ctx) => getAgentTimeline(ctx, R30, { day: '2026-10-03' }));
    expect(a.window.day).toBe('2026-10-03');
    expect(canon(a)).toEqual(canon(d));
    const json = JSON.stringify(a);
    for (const id of A.userIds) expect(json).not.toContain(id);
  });

  it('a minute window keeps only what overlaps it', async () => {
    const d = await run(B, 'admin', (ctx) => getAgentTimeline(ctx, R30, { day: '2026-10-05', fromH: '10:00', toH: '10:01' }));
    const a = await run(A, 'admin', (ctx) => getAgentTimeline(ctx, R30, { day: '2026-10-05', fromH: '10:00', toH: '10:01' }));
    expect(d.turns).toHaveLength(1);
    expect(new Date(d.turns[0]!.startedMs).toISOString()).toBe('2026-10-05T10:00:00.000Z');
    expect(d.runs.every((r) => r.turnId === d.turns[0]!.id)).toBe(true);
    expect(canon(a)).toEqual(canon(d));
    const empty = await run(B, 'admin', (ctx) => getAgentTimeline(ctx, R30, { day: '2026-10-05', fromH: '13:00', toH: '14:00' }));
    expect(empty.turns).toEqual([]);
    expect(empty.runs).toEqual([]);
  });

  it('members see their own turns; aggregates-only leads their led team; filters apply', async () => {
    const m1 = await run(B, 'm1', (ctx) => getAgentTimeline(ctx, R30, {}));
    expect(m1.turns).toHaveLength(1);
    expect(m1.turns[0]!.isMine).toBe(true);
    const lead = await run(A, 'lead', (ctx) => getAgentTimeline(ctx, R30, {}));
    expect(lead.turns).toHaveLength(3); // team t1: admin, lead, m1
    const beta = await run(B, 'admin', (ctx) => getAgentTimeline(ctx, { ...R30, projectId: B.projects.beta! }, {}));
    expect(beta.turns.map((t) => t.projectName)).toEqual(['beta', 'beta']);
    const betaAgg = await run(A, 'admin', (ctx) => getAgentTimeline(ctx, { ...R30, projectId: A.projects.beta!, effort: 'high' }, {}));
    expect(betaAgg.ignoredFilters).toEqual(['effort']);
  });

  it('returns stored links and derived sequence links on both paths; stage / flow fields come through', async () => {
    // The 10:00 turn of 2026-10-05: add two workflow agents (review:bugs -> verify:bugs, stored `item` link) and an
    // Agent-tool sibling of the Explore run that starts after it ended (derived `sequence` link Explore -> Plan).
    const turnStart = '2026-10-05T10:00:00Z';
    const at = (s: number) => new Date(Date.parse(turnStart) + s * 1000).toISOString();
    const seed = async (fx: Fixture) => {
      const add = (ext: string, type: string, group: string | null, orch: string | null, stage: number | null, flow: string | null, from: number, to: number) =>
        fx.owner.execute(sql`insert into runs (team_id, user_id, turn_id, turn_external_id, external_id, agent_type, agent_group,
            orchestration_id, stage_index, flow_key, depth, model, started_at, ended_at, duration_ms, outcome)
          select r.team_id, r.user_id, r.turn_id, r.turn_external_id, ${ext}, ${type}, ${group}, ${orch}, ${stage}, ${flow}, 1,
            r.model, ${at(from)}::timestamptz, ${at(to)}::timestamptz, ${(to - from) * 1000}, 'success'
          from runs r join turns t on t.id = r.turn_id
          where t.started_at = ${turnStart}::timestamptz and r.depth = 1 and r.external_id = 'r1'`);
      await add('w1', 'workflow:review:bugs', 'workflow:review', 'wf_t', 0, 'bugs', 3, 5);
      await add('w2', 'workflow:verify:bugs', 'workflow:verify', 'wf_t', 1, 'bugs', 6, 8);
      await add('p1', 'Plan', null, null, null, null, 100, 110);
      await fx.owner.execute(sql`insert into run_links (turn_id, turn_external_id, from_run_id, to_run_id, from_external_id, to_external_id, kind)
        select f.turn_id, f.turn_external_id, f.id, t.id, 'w1', 'w2', 'item'
        from runs f join runs t on t.turn_id = f.turn_id and t.external_id = 'w2'
        where f.external_id = 'w1'`);
    };
    const cleanup = (fx: Fixture) => fx.owner.execute(sql`delete from runs where external_id in ('w1', 'w2', 'p1')`);
    await seed(A);
    await seed(B);
    try {
      const sp = { day: '2026-10-05' };
      const d = await run(B, 'admin', (ctx) => getAgentTimeline(ctx, R30, sp));
      const a = await run(A, 'admin', (ctx) => getAgentTimeline(ctx, R30, sp));
      const byType = (x: typeof d, t: string) => x.runs.find((r) => r.agentType === t)!;
      expect(byType(d, 'workflow:verify:bugs')).toMatchObject({ stageIndex: 1, flowKey: 'bugs', orchestrationId: 'wf_t', agentGroup: 'workflow:verify' });
      const turnId = byType(d, 'Plan').turnId;
      const explore = d.runs.find((r) => r.turnId === turnId && r.agentType === 'Explore')!;
      expect(d.links).toEqual([
        { fromRunId: byType(d, 'workflow:review:bugs').id, toRunId: byType(d, 'workflow:verify:bugs').id, kind: 'item' },
        { fromRunId: explore.id, toRunId: byType(d, 'Plan').id, kind: 'sequence' },
      ]);
      expect(d.truncated.links).toBe(false);
      expect(canon(a)).toEqual(canon(d));
      expect(a.links).toHaveLength(2);
      // A member who cannot see the turn sees none of its links.
      const m1 = await run(B, 'm1', (ctx) => getAgentTimeline(ctx, R30, sp));
      const visible = new Set(m1.runs.map((r) => r.id));
      expect(m1.links.every((l) => visible.has(l.fromRunId) && visible.has(l.toRunId))).toBe(true);
      expect(m1.links.some((l) => l.kind === 'item')).toBe(false);
    } finally {
      await cleanup(A);
      await cleanup(B);
    }
  });

  it('a run that outlives its turn keeps its parent turn in a later window (background agents)', async () => {
    // The 10:00 turn on 2026-10-05 ends within minutes; let its depth-1 run go on until 13:30.
    const turnStart = '2026-10-05T10:00:00Z';
    const outlive = (fx: Fixture, endedAt: string) =>
      fx.owner.execute(sql`update runs r set ended_at = ${endedAt}::timestamptz from turns t
        where r.turn_id = t.id and t.started_at = ${turnStart}::timestamptz and r.depth = 1`);
    const original = await B.owner.execute(sql`select r.ended_at from runs r join turns t on t.id = r.turn_id
      where t.started_at = ${turnStart}::timestamptz and r.depth = 1`);
    const was = new Date(String((original as unknown as { ended_at: string }[])[0]!.ended_at)).toISOString();
    await outlive(A, '2026-10-05T13:30:00Z');
    await outlive(B, '2026-10-05T13:30:00Z');
    try {
      const sp = { day: '2026-10-05', fromH: '13:00', toH: '14:00' };
      const d = await run(B, 'admin', (ctx) => getAgentTimeline(ctx, R30, sp));
      const a = await run(A, 'admin', (ctx) => getAgentTimeline(ctx, R30, sp));
      expect(d.turns).toHaveLength(1);
      expect(new Date(d.turns[0]!.startedMs).toISOString()).toBe('2026-10-05T10:00:00.000Z');
      expect(d.turns[0]!.endedMs).toBeLessThan(Date.parse('2026-10-05T13:00:00Z'));
      expect(d.turns[0]!.projectName).toBe('beta');
      expect(d.runs).toHaveLength(1);
      expect(d.runs[0]).toMatchObject({ turnId: d.turns[0]!.id, depth: 1 });
      expect(canon(a)).toEqual(canon(d));
    } finally {
      await outlive(A, was);
      await outlive(B, was);
    }
  });
});
