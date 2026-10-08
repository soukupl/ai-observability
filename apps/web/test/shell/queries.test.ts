import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@ai-obs/db';
import { defaultFilters, type Filters } from '../../src/lib/filters';
import {
  buildExportTable,
  canSeeUsers,
  getAgents,
  getEffortAdvice,
  getEffortCells,
  getBudgetProgress,
  getKpis,
  getModelsEffort,
  getPhases,
  getProjects,
  getRunaways,
  getSkillImpact,
  getSkillsMcp,
  getTokenSeries,
  getTurnDetail,
  getWastedSpend,
  listTurns,
  loadFilterOptions,
  usesAggregateFunctions,
  type QueryCtx,
} from '../../src/lib/queries';
import { asPerson, connect, dropShellDatabase, FIXTURE_DAYS, prepareShellDatabase, seedCompany, SUB_AGENT_MODEL, type Fixture } from './harness';

const skipReason = await prepareShellDatabase();
if (skipReason) console.warn(`[web/shell] query tests skipped: ${skipReason}`);

const f = (over: Partial<Filters> = {}): Filters => ({ ...defaultFilters(), ...over });
const R30 = f({ range: '30d' });
/** Row ids differ between the two companies and float sums differ in the last bits: compare canonical forms. */
const canon = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_k, x) =>
      typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 1e6) / 1e6 : typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(x) ? '<id>' : x,
    ),
  );

describe.skipIf(skipReason !== null)(skipReason ? `dashboard queries - SKIPPED: ${skipReason}` : 'dashboard queries (real Postgres)', () => {
  let web: Database;
  let A: Fixture; // aggregates-only
  let B: Fixture; // full detail (identical data)
  let C: Fixture; // full detail, mixed-model turns (sub-agents on SUB_AGENT_MODEL)
  let D: Fixture; // aggregates-only, mixed-model turns

  beforeAll(async () => {
    const owner = connect();
    A = await seedCompany(owner, 'agg-co', 'aggregates-only');
    B = await seedCompany(owner, 'full-co', 'full');
    C = await seedCompany(owner, 'mixed-full-co', 'full', { mixed: true });
    D = await seedCompany(owner, 'mixed-agg-co', 'aggregates-only', { mixed: true });
    web = connect('app_web');
  }, 120_000);
  afterAll(dropShellDatabase);

  const run = <T>(fx: Fixture, who: string, fn: (ctx: QueryCtx) => Promise<T>) => asPerson(web, fx.people[who]!, (ctx) => fn(ctx));
  const kpis = (fx: Fixture, who: string, filters: Filters, force?: 'raw' | 'rollup') =>
    run(fx, who, (ctx) => getKpis({ ...ctx, forceSource: force }, filters));

  describe('visibility helpers', () => {
    it('canSeeUsers only for leads and admins in full mode', () => {
      expect(canSeeUsers(B.people.admin!)).toBe(true);
      expect(canSeeUsers(B.people.lead!)).toBe(true);
      expect(canSeeUsers(B.people.m1!)).toBe(false);
      for (const p of Object.values(A.people)) expect(canSeeUsers(p)).toBe(false);
    });
    it('aggregate functions for leads and admins in aggregates-only mode only', () => {
      expect(usesAggregateFunctions(A.people.admin!)).toBe(true);
      expect(usesAggregateFunctions(A.people.lead!)).toBe(true);
      expect(usesAggregateFunctions(A.people.m1!)).toBe(false);
      expect(usesAggregateFunctions(B.people.admin!)).toBe(false);
    });
  });

  describe('KPIs: raw and rollup sources agree', () => {
    for (const [name, fx, who] of [
      ['direct path (full mode admin)', () => B, 'admin'],
      ['aggregate path (aggregates-only admin)', () => A, 'admin'],
      ['member (own rows only)', () => A, 'm1'],
    ] as const) {
      it(`same range, same numbers: ${name}`, async () => {
        const raw = await kpis(fx(), who, R30, 'raw');
        const roll = await kpis(fx(), who, R30, 'rollup');
        expect(raw.range.source).toBe('raw');
        expect(roll.range.source).toBe('rollup');
        expect(raw.turns).toBeGreaterThan(0);
        expect(roll.turns).toBe(raw.turns);
        expect(roll.tokens).toEqual(raw.tokens);
        expect(roll.outcomes).toEqual(raw.outcomes);
        expect(roll.successRate).toBeCloseTo(raw.successRate!, 10);
        expect(roll.cost.usd).toBeCloseTo(raw.cost.usd!, 6);
        expect(roll.cost.partial).toBe(raw.cost.partial);
        expect(roll.cost.unknownModels).toEqual(raw.cost.unknownModels);
        // median is raw-only
        expect(raw.medianAvailable).toBe(true);
        expect(raw.medianDurationMs).toBeGreaterThan(0);
        expect(roll.medianAvailable).toBe(false);
        expect(roll.medianDurationMs).toBeNull();
      });
    }

    it('counts company-wide for admin and own rows for a member', async () => {
      const admin = await kpis(B, 'admin', R30);
      const member = await kpis(B, 'm1', R30);
      expect(admin.turns).toBe(member.turns * 4);
      expect(member.turns).toBe(30);
    });

    it('90d (> 35 days) picks the rollup source automatically and covers the whole fixture', async () => {
      const k = await kpis(B, 'admin', f({ range: '90d' }));
      expect(k.range.source).toBe('rollup');
      expect(k.turns).toBe(FIXTURE_DAYS * 4);
    });

    it('an unknown model gives a partial cost and the flag, not $0', async () => {
      const k = await kpis(B, 'admin', f({ range: '90d' }));
      expect(k.cost.partial).toBe(true);
      expect(k.cost.unknownModels).toEqual(['mystery-1']);
      expect(k.cost.usd).toBeGreaterThan(0);
      const onlyMystery = await kpis(B, 'admin', f({ range: '90d', model: 'mystery-1' }));
      expect(onlyMystery.cost.usd).toBeNull();
      expect(onlyMystery.turns).toBe(1);
    });

    it('reports success rate over decided turns and the unknown share', async () => {
      const k = await kpis(B, 'admin', R30);
      const o = k.outcomes;
      expect(k.successRate).toBeCloseTo(o.success / (o.success + o.failed + o.abandoned), 10);
      expect(k.unknownShare).toBeCloseTo(o.unknown / k.turns, 10);
    });

    it('direct and aggregate paths give identical numbers for identical data', async () => {
      const d = await kpis(B, 'admin', R30, 'raw');
      const a = await kpis(A, 'admin', R30, 'raw');
      expect(a.turns).toBe(d.turns);
      expect(a.tokens).toEqual(d.tokens);
      expect(a.outcomes).toEqual(d.outcomes);
      expect(a.cost.usd).toBeCloseTo(d.cost.usd!, 6);
      expect(a.medianDurationMs).toBe(d.medianDurationMs);
    });

    it('filters: team, project, harness, model and effort narrow the result', async () => {
      const all = await kpis(B, 'admin', R30, 'raw');
      const t1 = await kpis(B, 'admin', f({ teamId: B.teams.t1! }), 'raw');
      expect(t1.turns).toBeLessThan(all.turns);
      expect(t1.turns).toBe(30 * 3);
      const proj = await kpis(B, 'admin', f({ projectId: B.projects.beta! }), 'raw');
      expect(proj.turns).toBe(30 * 2);
      const codex = await kpis(B, 'admin', f({ harness: 'codex' }), 'raw');
      expect(codex.turns).toBeGreaterThan(0);
      expect(codex.turns).toBeLessThan(all.turns);
      const low = await kpis(B, 'admin', f({ effort: 'low' }), 'raw');
      const lowAgg = await kpis(A, 'admin', f({ effort: 'low' }), 'raw');
      expect(low.turns).toBeGreaterThan(0);
      expect(lowAgg.turns).toBe(low.turns);
      expect(lowAgg.tokens).toEqual(low.tokens);
    });

    it('userId filter works for a viewer who may see users, and is ignored otherwise', async () => {
      const uid = B.people.m1!.id;
      const only = await kpis(B, 'admin', f({ userId: uid }), 'raw');
      expect(only.turns).toBe(30);
      const aggregated = await kpis(A, 'admin', f({ userId: A.people.m1!.id }), 'raw');
      expect(aggregated.turns).toBe(30 * 4); // not honoured in aggregates-only mode
    });
  });

  describe('time series', () => {
    it('zero-fills every day and sums to the KPI tokens (raw and rollup)', async () => {
      for (const force of ['raw', 'rollup'] as const) {
        const s = await run(B, 'admin', (ctx) => getTokenSeries({ ...ctx, forceSource: force }, R30));
        const k = await kpis(B, 'admin', R30, force);
        expect(s.points).toHaveLength(30);
        expect(s.points.reduce((a, p) => a + p.total, 0)).toBe(k.tokens.total);
        expect(s.models).toContain('claude-opus-5-5');
        expect(s.models).toContain('claude-sonnet-5-5');
      }
    });

    it('raw and rollup agree per day and model', async () => {
      const raw = await run(B, 'admin', (ctx) => getTokenSeries({ ...ctx, forceSource: 'raw' }, R30));
      const roll = await run(B, 'admin', (ctx) => getTokenSeries({ ...ctx, forceSource: 'rollup' }, R30));
      expect(roll.points).toEqual(raw.points);
    });

    it('direct and aggregate paths agree', async () => {
      const d = await run(B, 'admin', (ctx) => getTokenSeries(ctx, R30));
      const a = await run(A, 'admin', (ctx) => getTokenSeries(ctx, R30));
      expect(a.points).toEqual(d.points);
    });
  });

  describe('projects', () => {
    it('totals match the KPIs; sparkline covers 14 days; cost per project', async () => {
      const p = await run(B, 'admin', (ctx) => getProjects(ctx, R30));
      const k = await kpis(B, 'admin', R30);
      expect(p.rows.map((r) => r.name).sort()).toEqual(['alpha', 'beta']);
      expect(p.rows.reduce((a, r) => a + r.turns, 0)).toBe(k.turns);
      expect(p.rows.reduce((a, r) => a + r.tokens.total, 0)).toBe(k.tokens.total);
      expect(p.sparkDays).toHaveLength(14);
      for (const r of p.rows) {
        expect(r.spark).toHaveLength(14);
        expect(r.spark.every((v) => v > 0)).toBe(true);
        expect(r.costSkipped).toBe(false);
      }
      expect(p.rows.reduce((a, r) => a + (r.cost.usd ?? 0), 0)).toBeCloseTo(k.cost.usd!, 6);
    });

    it('aggregate path matches the direct path', async () => {
      const d = await run(B, 'admin', (ctx) => getProjects(ctx, R30));
      const a = await run(A, 'admin', (ctx) => getProjects(ctx, R30));
      expect(canon(a.rows)).toEqual(canon(d.rows));
    });

    it('rollup source agrees with raw', async () => {
      const raw = await run(B, 'admin', (ctx) => getProjects({ ...ctx, forceSource: 'raw' }, R30));
      const roll = await run(B, 'admin', (ctx) => getProjects({ ...ctx, forceSource: 'rollup' }, R30));
      expect(canon(roll.rows)).toEqual(canon(raw.rows));
    });
  });

  describe('models x effort', () => {
    it('raw and rollup agree (except the median) and direct equals aggregate', async () => {
      const raw = await run(B, 'admin', (ctx) => getModelsEffort({ ...ctx, forceSource: 'raw' }, R30));
      const roll = await run(B, 'admin', (ctx) => getModelsEffort({ ...ctx, forceSource: 'rollup' }, R30));
      const agg = await run(A, 'admin', (ctx) => getModelsEffort({ ...ctx, forceSource: 'raw' }, R30));
      const strip = (rows: typeof raw.rows) => rows.map(({ medianDurationMs: _m, ...r }) => r);
      expect(canon(strip(roll.rows))).toEqual(canon(strip(raw.rows)));
      expect(canon(strip(agg.rows))).toEqual(canon(strip(raw.rows)));
      expect(raw.rows.every((r) => r.medianDurationMs !== null)).toBe(true);
      expect(roll.rows.every((r) => r.medianDurationMs === null)).toBe(true);
      expect(raw.rows.length).toBe(5); // 2 priced models x 2 efforts + the unpriced mystery-1 turn
      expect(raw.rows.filter((r) => r.cost.usd === null).map((r) => r.model)).toEqual(['mystery-1']);
    });
  });

  describe('mixed-model turns: raw and rollup sources agree exactly', () => {
    for (const [name, fx, who] of [
      ['direct path (full mode admin)', () => C, 'admin'],
      ['aggregate path (aggregates-only admin)', () => D, 'admin'],
      ['member (own rows only)', () => D, 'm1'],
    ] as const) {
      it(`KPIs: ${name}`, async () => {
        const raw = await kpis(fx(), who, R30, 'raw');
        const roll = await kpis(fx(), who, R30, 'rollup');
        expect(raw.turns).toBeGreaterThan(0);
        expect(roll.turns).toBe(raw.turns);
        expect(roll.tokens).toEqual(raw.tokens);
        expect(roll.outcomes).toEqual(raw.outcomes);
        expect(roll.cost.usd).toBeCloseTo(raw.cost.usd!, 9);
        expect(roll.cost.partial).toBe(raw.cost.partial);
        expect(roll.cost.unknownModels).toEqual(raw.cost.unknownModels);
      });
    }

    it('sub-agent tokens are priced at the sub-agent model, not the turn model', async () => {
      const same = await kpis(B, 'admin', R30, 'raw');
      const mixed = await kpis(C, 'admin', R30, 'raw');
      expect(mixed.tokens).toEqual(same.tokens);
      expect(mixed.turns).toBe(same.turns);
      expect(mixed.cost.usd!).toBeLessThan(same.cost.usd!); // haiku is cheaper than opus / sonnet
    });

    it('models x effort: raw = rollup = aggregate; the sub-agent-only model has tokens and cost but no turns', async () => {
      const raw = await run(C, 'admin', (ctx) => getModelsEffort({ ...ctx, forceSource: 'raw' }, R30));
      const roll = await run(C, 'admin', (ctx) => getModelsEffort({ ...ctx, forceSource: 'rollup' }, R30));
      const agg = await run(D, 'admin', (ctx) => getModelsEffort({ ...ctx, forceSource: 'raw' }, R30));
      const aggRoll = await run(D, 'admin', (ctx) => getModelsEffort({ ...ctx, forceSource: 'rollup' }, R30));
      const strip = (rows: typeof raw.rows) => rows.map(({ medianDurationMs: _m, ...r }) => r);
      expect(canon(strip(roll.rows))).toEqual(canon(strip(raw.rows)));
      expect(canon(strip(agg.rows))).toEqual(canon(strip(raw.rows)));
      expect(canon(strip(aggRoll.rows))).toEqual(canon(strip(raw.rows)));
      const sub = raw.rows.find((r) => r.model === SUB_AGENT_MODEL);
      expect(sub).toMatchObject({ effort: null, turns: 0, successRate: null, avgDurationMs: null });
      expect(sub!.tokens.total).toBeGreaterThan(0);
      expect(sub!.cost.usd).toBeGreaterThan(0);
      const k = await kpis(C, 'admin', R30, 'raw');
      expect(raw.rows.reduce((a, r) => a + r.turns, 0)).toBe(k.turns);
      expect(raw.rows.reduce((a, r) => a + r.tokens.total, 0)).toBe(k.tokens.total);
      expect(raw.rows.reduce((a, r) => a + (r.cost.usd ?? 0), 0)).toBeCloseTo(k.cost.usd!, 9);
    });

    it('time series, projects and the model filter agree between raw and rollup', async () => {
      const series = await Promise.all((['raw', 'rollup'] as const).map((s) => run(C, 'admin', (ctx) => getTokenSeries({ ...ctx, forceSource: s }, R30))));
      expect(series[1]!.points).toEqual(series[0]!.points);
      expect(series[0]!.models).toContain(SUB_AGENT_MODEL);
      const projects = await Promise.all((['raw', 'rollup'] as const).map((s) => run(C, 'admin', (ctx) => getProjects({ ...ctx, forceSource: s }, R30))));
      expect(canon(projects[1]!.rows)).toEqual(canon(projects[0]!.rows));
      for (const model of [SUB_AGENT_MODEL, 'claude-opus-5-5']) {
        const raw = await kpis(C, 'admin', f({ model }), 'raw');
        const roll = await kpis(C, 'admin', f({ model }), 'rollup');
        expect({ turns: roll.turns, tokens: roll.tokens, outcomes: roll.outcomes }).toEqual({ turns: raw.turns, tokens: raw.tokens, outcomes: raw.outcomes });
        expect(roll.cost.usd).toBeCloseTo(raw.cost.usd!, 9);
      }
    });
  });

  describe('phases and agents (raw rows)', () => {
    it('phase split sums per group and matches between direct and aggregate paths', async () => {
      for (const group of ['team', 'project', 'model'] as const) {
        const d = await run(B, 'admin', (ctx) => getPhases(ctx, R30, group));
        const a = await run(A, 'admin', (ctx) => getPhases(ctx, R30, group));
        expect(canon(a.rows)).toEqual(canon(d.rows));
        for (const r of d.rows) expect(Object.values(r.share).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 10);
      }
      const byTeam = await run(B, 'admin', (ctx) => getPhases(ctx, R30, 'team'));
      expect(byTeam.rows.map((r) => r.label).sort()).toEqual(['Team t1', 'Team t2']);
      expect(byTeam.rows[0]!.ms.thinking).toBeGreaterThan(0);
    });

    it('agents: spawn counts, token share, depth', async () => {
      const d = await run(B, 'admin', (ctx) => getAgents(ctx, R30));
      const a = await run(A, 'admin', (ctx) => getAgents(ctx, R30));
      expect(d.rows.map((r) => r.agentType)).toEqual(['Explore', 'general-purpose']);
      expect(d.rows[0]!.spawns).toBe(120);
      expect(d.rows[1]!.spawns).toBe(40);
      expect(d.rows.reduce((s, r) => s + r.tokenShare, 0)).toBeCloseTo(1, 10);
      expect(d.depthHistogram).toEqual([{ depth: 1, runs: 120 }, { depth: 2, runs: 40 }]);
      expect(d.rows[1]!.maxDepth).toBe(2);
      expect(canon(a.rows)).toEqual(canon(d.rows));
      expect(a.depthHistogram).toBeNull(); // agg_agents has no histogram
    });
  });

  describe('turns explorer', () => {
    it('pages newest-first, with totals on the direct path', async () => {
      const p1 = await run(B, 'admin', (ctx) => listTurns(ctx, R30, { page: 1, pageSize: 25 }));
      const p2 = await run(B, 'admin', (ctx) => listTurns(ctx, R30, { page: 2, pageSize: 25 }));
      expect(p1.total).toBe(120);
      expect(p1.rows).toHaveLength(25);
      expect(p1.hasNext).toBe(true);
      expect(p1.rows[0]!.startedMs).toBeGreaterThanOrEqual(p1.rows[24]!.startedMs);
      expect(p2.rows[0]!.id).not.toBe(p1.rows[0]!.id);
      const last = await run(B, 'admin', (ctx) => listTurns(ctx, R30, { page: 5, pageSize: 25 }));
      expect(last.rows).toHaveLength(20);
      expect(last.hasNext).toBe(false);
    });

    it('filters by outcome, and by effort on both paths', async () => {
      const failed = await run(B, 'admin', (ctx) => listTurns(ctx, R30, { outcome: 'failed', pageSize: 500 }));
      expect(failed.rows.length).toBeGreaterThan(0);
      expect(failed.rows.every((r) => r.outcome === 'failed')).toBe(true);
      const dLow = await run(B, 'admin', (ctx) => listTurns(ctx, f({ effort: 'low' }), { pageSize: 500 }));
      const aLow = await run(A, 'admin', (ctx) => listTurns(ctx, f({ effort: 'low' }), { pageSize: 500 }));
      expect(dLow.rows.every((r) => r.effort === 'low')).toBe(true);
      expect(aLow.rows.map((r) => [r.startedMs, r.tokens.total])).toEqual(dLow.rows.map((r) => [r.startedMs, r.tokens.total]));
    });

    it('full mode shows who (admin), members never see a user column', async () => {
      const admin = await run(B, 'admin', (ctx) => listTurns(ctx, R30, { pageSize: 10 }));
      expect(admin.rows.every((r) => typeof r.userName === 'string')).toBe(true);
      const member = await run(B, 'm1', (ctx) => listTurns(ctx, R30, { pageSize: 10 }));
      expect(member.rows.every((r) => r.userName === undefined && r.userId === undefined && r.isMine)).toBe(true);
    });

    it('turn detail: run tree, agent groups and per-model usage', async () => {
      const list = await run(B, 'admin', (ctx) => listTurns(ctx, R30, { pageSize: 50 }));
      const row = list.rows.find((r) => r.tokens.total > 0 && r.id)!;
      // a turn with a nested run: every third turn
      const nestedTurnId = (await run(B, 'admin', async (ctx) => {
        for (const t of list.rows) {
          const d = await getTurnDetail(ctx, t.id);
          if (d && d.runs.length === 2) return t.id;
        }
        return row.id;
      }));
      const d = await run(B, 'admin', (ctx) => getTurnDetail(ctx, nestedTurnId));
      expect(d).not.toBeNull();
      expect(d!.limited).toBe(false);
      expect(d!.runs).toHaveLength(2);
      expect(d!.tree).toHaveLength(1);
      expect(d!.tree[0]!.agentType).toBe('Explore');
      expect(d!.tree[0]!.children[0]!.agentType).toBe('general-purpose');
      expect(d!.runs.map((r) => [r.agentType, r.agentGroup, r.depth]).sort()).toEqual([['Explore', 'Explore', 1], ['general-purpose', 'general-purpose', 2]]);
      expect(d!.turn.phasesMs?.thinking).toBeGreaterThan(0);
      expect(d!.usage!.length).toBe(1);
      expect(d!.usage!.reduce((s, u) => s + u.tokens.total, 0)).toBe(d!.turn.tokens.total);
      // nested turns are every third one, which also call github search_code twice (runs add get_file / docs)
      expect(d!.turn.mcp!.github!.search_code).toBe(2);
    });

    it('aggregate path: someone else\'s turn is found by time hint, without attribution', async () => {
      const m2Turn = A.turnIds.find((t) => t.userKey === 'm2')!;
      const withHint = await run(A, 'admin', (ctx) => getTurnDetail(ctx, m2Turn.id, m2Turn.startedMs));
      expect(withHint).not.toBeNull();
      expect(withHint!.limited).toBe(true);
      expect(withHint!.turn.phasesMs).toBeNull();
      expect(withHint!.turn.isMine).toBe(false);
      expect(withHint!.runs.length).toBeGreaterThan(0);
      const noHint = await run(A, 'admin', (ctx) => getTurnDetail(ctx, m2Turn.id));
      expect(noHint?.turn.id).toBe(m2Turn.id);
      // own turn: full detail even in aggregates-only mode
      const own = A.turnIds.find((t) => t.userKey === 'admin')!;
      const ownDetail = await run(A, 'admin', (ctx) => getTurnDetail(ctx, own.id));
      expect(ownDetail!.limited).toBe(false);
      expect(ownDetail!.turn.isMine).toBe(true);
    });

    it('turn detail: stage / flow / orchestration fields and links (stored + derived) on both paths', async () => {
      // Two workflow agents with a stored `item` link and an Agent-tool sibling after the Explore run (derived
      // `sequence` link), on B's admin turn (direct path) and A's m2 turn seen by A's admin (aggregate path).
      const owner = connect();
      const seed = async (fx: Fixture, turnId: string) => {
        const add = (ext: string, type: string, group: string | null, orch: string | null, stage: number | null, flow: string | null, from: number, to: number) =>
          owner.execute(sql`insert into runs (company_id, team_id, user_id, turn_id, turn_external_id, external_id, agent_type, agent_group,
              orchestration_id, stage_index, flow_key, depth, model, started_at, ended_at, duration_ms, outcome)
            select r.company_id, r.team_id, r.user_id, r.turn_id, r.turn_external_id, ${ext}, ${type}, ${group}, ${orch}, ${stage}, ${flow}, 1,
              r.model, t.started_at + make_interval(secs => ${from}), t.started_at + make_interval(secs => ${to}), ${(to - from) * 1000}, 'success'
            from runs r join turns t on t.id = r.turn_id
            where t.id = ${turnId}::uuid and r.external_id = 'r1'`);
        await add('w1', 'workflow:review:bugs', 'workflow:review', 'wf_t', 0, 'bugs', 3, 5);
        await add('w2', 'workflow:verify:bugs', 'workflow:verify', 'wf_t', 1, 'bugs', 6, 8);
        await add('p1', 'Plan', null, null, null, null, 200, 210);
        await owner.execute(sql`insert into run_links (company_id, turn_id, turn_external_id, from_run_id, to_run_id, from_external_id, to_external_id, kind)
          select f.company_id, f.turn_id, f.turn_external_id, f.id, t.id, 'w1', 'w2', 'item'
          from runs f join runs t on t.turn_id = f.turn_id and t.external_id = 'w2'
          where f.turn_id = ${turnId}::uuid and f.external_id = 'w1'`);
      };
      const cleanup = (fx: Fixture) => owner.execute(sql`delete from runs where company_id = ${fx.id}::uuid and external_id in ('w1', 'w2', 'p1')`);
      const own = B.turnIds.find((t) => t.userKey === 'admin')!;
      const other = A.turnIds.find((t) => t.userKey === 'm2')!;
      await seed(B, own.id);
      await seed(A, other.id);
      try {
        const expectLinks = (d: Awaited<ReturnType<typeof getTurnDetail>>) => {
          const id = (t: string) => d!.runs.find((r) => r.agentType === t)!.id;
          expect(d!.links).toEqual([
            { fromRunId: id('workflow:review:bugs'), toRunId: id('workflow:verify:bugs'), kind: 'item' },
            { fromRunId: id('Explore'), toRunId: id('Plan'), kind: 'sequence' },
          ]);
        };
        const direct = await run(B, 'admin', (ctx) => getTurnDetail(ctx, own.id));
        expect(direct!.limited).toBe(false);
        expect(direct!.runs.find((r) => r.agentType === 'workflow:verify:bugs')).toMatchObject({ stageIndex: 1, flowKey: 'bugs', orchestrationId: 'wf_t' });
        expect(direct!.runs.find((r) => r.agentType === 'Explore')).toMatchObject({ stageIndex: null, flowKey: null, orchestrationId: null });
        expectLinks(direct);
        const agg = await run(A, 'admin', (ctx) => getTurnDetail(ctx, other.id, other.startedMs));
        expect(agg!.limited).toBe(true);
        // agg_turn_runs returns the orchestration, stage and flow like the raw path.
        expect(agg!.runs.find((r) => r.agentType === 'workflow:verify:bugs')).toMatchObject({ stageIndex: 1, flowKey: 'bugs', orchestrationId: 'wf_t' });
        expectLinks(agg);
        // A member never sees links of a turn they cannot open.
        expect(await run(B, 'm1', (ctx) => getTurnDetail(ctx, own.id))).toBeNull();
      } finally {
        await cleanup(A);
        await cleanup(B);
      }
    });

    it('a member cannot open another user\'s turn; a malformed id is null', async () => {
      const other = B.turnIds.find((t) => t.userKey === 'm2')!;
      expect(await run(B, 'm1', (ctx) => getTurnDetail(ctx, other.id))).toBeNull();
      expect(await run(B, 'm1', (ctx) => getTurnDetail(ctx, 'nope'))).toBeNull();
    });
  });

  describe('wasted spend', () => {
    const usd = (v: { usd: number | null }) => Math.round((v.usd ?? 0) * 1e6) / 1e6;

    it('equals the ≈ cost of failed and abandoned turns; parts add up to the total', async () => {
      const w = await run(B, 'admin', (ctx) => getWastedSpend({ ...ctx, forceSource: 'raw' }, R30));
      const listed = await run(B, 'admin', async (ctx) => {
        const failed = await listTurns(ctx, R30, { outcome: 'failed', pageSize: 500 });
        const abandoned = await listTurns(ctx, R30, { outcome: 'abandoned', pageSize: 500 });
        return [...failed.rows, ...abandoned.rows].reduce((a, r) => a + (r.cost.usd ?? 0), 0);
      });
      expect(usd(w.wasted)).toBeCloseTo(listed, 4);
      expect(w.wasted.usd).toBeGreaterThan(0);
      expect(w.share).toBeGreaterThan(0);
      expect(w.share).toBeLessThan(1);
      const sum = (m: typeof w.byProject) => [...m.values()].reduce((a, p) => a + (p.wasted.usd ?? 0), 0);
      expect(sum(w.byProject)).toBeCloseTo(w.wasted.usd!, 6);
      expect(sum(w.byModel)).toBeCloseTo(w.wasted.usd!, 6);
      expect(w.daily.reduce((a, d) => a + d.usd, 0)).toBeCloseTo(w.wasted.usd!, 6);
      expect(w.unclassified.usd).toBeGreaterThan(0);
    });

    it('raw = rollup = aggregate path, mixed-model turns included', async () => {
      for (const [full, agg] of [[B, A], [C, D]] as const) {
        const raw = await run(full, 'admin', (ctx) => getWastedSpend({ ...ctx, forceSource: 'raw' }, R30));
        const roll = await run(full, 'admin', (ctx) => getWastedSpend({ ...ctx, forceSource: 'rollup' }, R30));
        const aggRaw = await run(agg, 'admin', (ctx) => getWastedSpend({ ...ctx, forceSource: 'raw' }, R30));
        const aggRoll = await run(agg, 'admin', (ctx) => getWastedSpend({ ...ctx, forceSource: 'rollup' }, R30));
        const key = (r: typeof raw) => canon({ total: r.total, wasted: r.wasted, unclassified: r.unclassified, share: r.share, daily: r.daily, models: [...r.byModel].sort() });
        expect(key(roll)).toEqual(key(raw));
        expect(key(aggRaw)).toEqual(key(raw));
        expect(key(aggRoll)).toEqual(key(raw));
        expect(roll.unsplitDays).toBe(0);
      }
    });
  });

  describe('effort advisor', () => {
    it('cells: direct = aggregate path, counts match the turns, medians are priced per usage model', async () => {
      const direct = await run(B, 'admin', (ctx) => getEffortCells(ctx, R30));
      const agg = await run(A, 'admin', (ctx) => getEffortCells(ctx, R30));
      // project ids differ between the two companies: compare the cells without them, in a stable order
      const strip = (cells: typeof direct) => cells.map(({ projectId: _p, ...c }) => JSON.stringify(canon(c))).sort();
      expect(strip(agg)).toEqual(strip(direct));
      const k = await kpis(B, 'admin', R30);
      expect(direct.reduce((a, c) => a + c.turns, 0)).toBe(k.turns);
      expect(direct.find((c) => c.model === 'mystery-1')?.medianCostUsd ?? null).toBeNull(); // unpriced model
      expect(direct.filter((c) => c.model !== 'mystery-1').every((c) => (c.medianCostUsd ?? 0) > 0)).toBe(true);
    });

    it('is unavailable on rollup ranges and ignores the effort filter', async () => {
      const long = await run(B, 'admin', (ctx) => getEffortAdvice(ctx, f({ range: '90d' })));
      expect(long.available).toBe(false);
      const withEffort = await run(B, 'admin', (ctx) => getEffortAdvice(ctx, f({ range: '30d', effort: 'high' })));
      expect(withEffort.available).toBe(true);
      expect(withEffort.ignoredFilters).toEqual(['effort']);
    });
  });

  describe('runaways', () => {
    it('admins see every runaway (direct = aggregate path), members only their own', async () => {
      const full = await run(B, 'admin', (ctx) => getRunaways(ctx, R30, 500));
      const agg = await run(A, 'admin', (ctx) => getRunaways(ctx, R30, 500));
      const strip = (r: typeof full) => r.rows.map(({ turnId: _t, startedMs, tokens, durationMs, reasons, costUsd }) => ({ startedMs, tokens, durationMs, reasons, costUsd }));
      expect(full.rows.length).toBeGreaterThan(5);
      expect(strip(agg)).toEqual(strip(full));
      const mine = await run(A, 'm1', (ctx) => getRunaways(ctx, R30, 500));
      expect(mine.rows.length).toBeGreaterThan(0);
      expect(mine.rows.length).toBeLessThan(full.rows.length);
      expect(mine.rows.every((r) => r.isMine)).toBe(true);
      expect((await run(A, 'admin', (ctx) => getRunaways(ctx, R30))).rows).toHaveLength(10); // default limit
    });
  });

  describe('skills & MCP', () => {
    it('raw = rollup = aggregate path; a server counts each turn once; sub-agent calls included', async () => {
      const raw = await run(B, 'admin', (ctx) => getSkillsMcp({ ...ctx, forceSource: 'raw' }, R30));
      const roll = await run(B, 'admin', (ctx) => getSkillsMcp({ ...ctx, forceSource: 'rollup' }, R30));
      const agg = await run(A, 'admin', (ctx) => getSkillsMcp({ ...ctx, forceSource: 'raw' }, R30));
      const aggRoll = await run(A, 'admin', (ctx) => getSkillsMcp({ ...ctx, forceSource: 'rollup' }, R30));
      const body = (r: typeof raw) => canon({ skills: r.skills, servers: r.servers, days: r.days });
      expect(body(roll)).toEqual(body(raw));
      expect(body(agg)).toEqual(body(raw));
      expect(body(aggRoll)).toEqual(body(raw));

      // MCP reliability: errors only on search_code, denials only on get_file, docs slow (30–120 s bucket)
      const gh = raw.servers.find((s) => s.name === 'github')!;
      const search = gh.tools.find((t) => t.tool === 'search_code')!;
      const getFile = gh.tools.find((t) => t.tool === 'get_file')!;
      expect(search.errors).toBeGreaterThan(0);
      expect(search.buckets[0]).toBe(search.buckets[1]);
      expect(getFile).toMatchObject({ errors: 0, latencyMs: 0 });
      expect(getFile.denied).toBe(getFile.calls);
      expect(gh).toMatchObject({ errors: search.errors, denied: getFile.denied, latencyMs: search.latencyMs });
      expect(raw.servers.find((s) => s.name === 'docs')!.buckets).toEqual([0, 0, 0, raw.servers.find((s) => s.name === 'docs')!.calls, 0]);

      const [skill] = raw.skills;
      expect(skill).toMatchObject({ name: 'code-review' });
      expect(skill!.calls).toBe(skill!.modelCalls + skill!.userCalls);
      expect(skill!.userCalls).toBeGreaterThan(0);
      expect(skill!.users).toBe(1); // every 4th turn is m2's (4 users take turns)
      const github = raw.servers.find((s) => s.name === 'github')!;
      expect(github.tools.map((t) => t.tool)).toEqual(['search_code', 'get_file']);
      expect(github.calls).toBe(github.tools.reduce((a, t) => a + t.calls, 0));
      // turns with both search_code (turn) and get_file (run) count once for the server
      expect(github.turns).toBeLessThan(github.tools.reduce((a, t) => a + t.turns, 0));
      expect(raw.days.filter((d) => d.kind === 'skill').reduce((a, d) => a + d.calls, 0)).toBe(skill!.calls);
    });

    it('skill impact: direct = aggregate path on raw and rollup ranges; rollup compares success only', async () => {
      const raw = await run(B, 'admin', (ctx) => getSkillImpact({ ...ctx, forceSource: 'raw' }, R30));
      const aggRaw = await run(A, 'admin', (ctx) => getSkillImpact({ ...ctx, forceSource: 'raw' }, R30));
      const roll = await run(B, 'admin', (ctx) => getSkillImpact({ ...ctx, forceSource: 'rollup' }, R30));
      const aggRoll = await run(A, 'admin', (ctx) => getSkillImpact({ ...ctx, forceSource: 'rollup' }, R30));
      expect(canon(aggRaw.impacts)).toEqual(canon(raw.impacts));
      expect(canon(aggRoll.impacts)).toEqual(canon(roll.impacts));
      const pick = (r: typeof raw) => r.impacts.map((i) => [i.skill, i.turns, i.comparableTurns, i.successRate, i.comparableSuccessRate]);
      expect(canon(pick(roll))).toEqual(canon(pick(raw)));
      expect(roll.mediansAvailable).toBe(false);
      expect(roll.impacts.every((i) => i.cost === null)).toBe(true);

      const [cr] = raw.impacts;
      expect(cr!.skill).toBe('code-review');
      // every code-review turn has comparable turns except the one on the unpriced mystery-1 model (its own cell)
      const skills = await run(B, 'admin', (ctx) => getSkillsMcp({ ...ctx, forceSource: 'raw' }, R30));
      expect(cr!.turns).toBe(skills.skills[0]!.turns - 1);
      expect(cr!.enough).toBe(true);
      expect(cr!.cost).not.toBeNull();
    });

    it('a member sees only their own use; a lead in aggregates-only mode only their team', async () => {
      const admin = await run(A, 'admin', (ctx) => getSkillsMcp(ctx, R30));
      const member = await run(A, 'm2', (ctx) => getSkillsMcp(ctx, R30));
      const lead = await run(A, 'lead', (ctx) => getSkillsMcp(ctx, R30));
      const calls = (r: typeof admin) => r.servers.reduce((a, s) => a + s.calls, 0);
      expect(member.servers.every((s) => s.users <= 1)).toBe(true);
      expect(calls(member)).toBeLessThan(calls(admin));
      expect(calls(lead)).toBeLessThan(calls(admin));
      expect(calls(lead)).toBeGreaterThan(calls(member));
    });
  });

  describe('visibility: leads / admins in aggregates-only mode get no per-user data', () => {
    const userKeys = /"(userId|user_id|userName|user_name|email)"/;

    it('no user id, name or e-mail anywhere in any view result', async () => {
      const results = await run(A, 'admin', async (ctx) => {
        const turns = await listTurns(ctx, R30, { pageSize: 500 });
        const someone = A.turnIds.find((t) => t.userKey === 'm2')!;
        return {
          kpis: await getKpis(ctx, R30),
          series: await getTokenSeries(ctx, R30),
          projects: await getProjects(ctx, R30),
          models: await getModelsEffort(ctx, R30),
          phases: await getPhases(ctx, R30, 'team'),
          agents: await getAgents(ctx, R30),
          skillsMcp: await getSkillsMcp(ctx, R30),
          runaways: await getRunaways(ctx, R30, 500),
          turns,
          detail: await getTurnDetail(ctx, someone.id, someone.startedMs),
          budgets: await getBudgetProgress(ctx),
          options: await loadFilterOptions(ctx),
          csv: await buildExportTable(ctx, 'turns', R30),
        };
      });
      const json = JSON.stringify(results);
      expect(userKeys.test(json)).toBe(false);
      for (const id of A.userIds.filter((id) => id !== A.people.admin!.id)) expect(json).not.toContain(id);
      for (const key of ['lead', 'm1', 'm2']) expect(json).not.toContain(`${key}@agg-co.test`);
      expect(results.turns.rows.length).toBe(120);
      expect(results.turns.rows.filter((r) => r.isMine)).toHaveLength(30);
      expect(results.options.users).toBeNull();
      expect(results.csv.headers).not.toContain('user');
    });

    it('a lead sees only led-team aggregates', async () => {
      const lead = await kpis(A, 'lead', R30);
      expect(lead.turns).toBe(30 * 3); // team t1 has admin, lead, m1
      const m2 = await kpis(A, 'm2', R30);
      expect(m2.turns).toBe(30);
    });

    it('full mode: leads and admins do get the user column', async () => {
      const csv = await run(B, 'admin', (ctx) => buildExportTable(ctx, 'turns', R30));
      expect(csv.headers).toContain('user');
      const users = await run(B, 'admin', (ctx) => loadFilterOptions(ctx));
      expect(users.users?.map((u) => u.name).sort()).toEqual(['admin', 'lead', 'm1', 'm2']);
    });
  });

  describe('budgets', () => {
    it('month-to-date progress for team budgets; others\' user budgets hidden in aggregates-only mode', async () => {
      const a = await run(A, 'admin', (ctx) => getBudgetProgress(ctx));
      expect(a.month).toBe('2026-10-01');
      expect(a.rows.map((r) => [r.scope, r.kind])).toEqual([['team', 'tokens'], ['team', 'cost']]);
      expect(a.hiddenUserBudgets).toBe(1);
      const tokens = a.rows.find((r) => r.kind === 'tokens')!;
      // 5 days of October (1st..5th) x 3 users of t1 x one turn each = 15 turns of t1
      const t1Oct = await run(B, 'admin', (ctx) => getKpis(ctx, f({ range: 'custom', from: '2026-10-01', to: '2026-10-05', teamId: B.teams.t1! })));
      expect(tokens.used).toBe(t1Oct.tokens.total);
      expect(tokens.level).toBe(tokens.used! >= 500000 ? 'over' : tokens.used! >= 400000 ? 'warn' : 'ok');
      const cost = a.rows.find((r) => r.kind === 'cost')!;
      expect(cost.used).toBeCloseTo(t1Oct.cost.usd!, 6);

      const b = await run(B, 'admin', (ctx) => getBudgetProgress(ctx));
      expect(b.rows).toHaveLength(3);
      expect(b.rows.find((r) => r.scope === 'user')!.userName).toBe('m1');
      expect(b.rows.find((r) => r.kind === 'tokens' && r.scope === 'team')!.used).toBe(tokens.used);
    });

    it('a member sees only their own user budget', async () => {
      const m1 = await run(A, 'm1', (ctx) => getBudgetProgress(ctx));
      expect(m1.rows).toHaveLength(1);
      expect(m1.rows[0]!.scope).toBe('user');
      expect(m1.rows[0]!.isMine).toBe(true);
      const m2 = await run(A, 'm2', (ctx) => getBudgetProgress(ctx));
      expect(m2.rows).toHaveLength(0);
    });
  });

  describe('filter options', () => {
    it('teams are limited for non-admins; models and harnesses come from the data', async () => {
      const admin = await run(B, 'admin', (ctx) => loadFilterOptions(ctx));
      expect(admin.teams.map((t) => t.name)).toEqual(['Team t1', 'Team t2']);
      expect(admin.projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
      expect(admin.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'mystery-1']);
      expect(admin.harnesses).toEqual(['claude-code', 'codex']);
      expect(admin.efforts).toEqual(['high', 'low']);
      const m2 = await run(B, 'm2', (ctx) => loadFilterOptions(ctx));
      expect(m2.teams.map((t) => t.name)).toEqual(['Team t2']);
      const aggAdmin = await run(A, 'admin', (ctx) => loadFilterOptions(ctx));
      expect(aggAdmin.models).toEqual(admin.models);
    });
  });

  describe('exports', () => {
    it('every view builds a rectangular table', async () => {
      for (const fx of [A, B]) {
        for (const view of ['overview', 'projects', 'models', 'phases', 'agents', 'skills-mcp', 'turns', 'budgets'] as const) {
          const t = await run(fx, 'admin', (ctx) => buildExportTable(ctx, view, R30, { group: 'project' }));
          expect(t.headers.length).toBeGreaterThan(1);
          expect(t.rows.length, `${fx.mode} ${view}`).toBeGreaterThan(0);
          for (const row of t.rows) expect(row).toHaveLength(t.headers.length);
        }
      }
    });
  });
});
