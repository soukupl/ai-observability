import { sql, type SQL } from 'drizzle-orm';
import type { Filters } from '../filters';
import { skillImpacts, type ImpactCellSide, type SkillImpact } from '../skill-impact';
import { aggArgs, dims, turnConds, type Dims } from './providers';
import { rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { num, rows, where } from './sqlutil';

export interface SkillImpactResult {
  range: ResolvedRange;
  impacts: SkillImpact[];
  /** cost / tokens / duration comparisons need raw turns; on rollup ranges only success is compared */
  mediansAvailable: boolean;
  ignoredFilters: string[];
}

/** The body of agg_skill_impact (migration 0008) over a turn scope: the direct raw path. */
function rawSql(scope: SQL): SQL {
  return sql`with scope as (
      select t.id, t.company_id, t.project_id, coalesce(t.model, 'unknown') as model, t.outcome, t.duration_ms, t.skills,
        t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens as tokens,
        (t.started_at at time zone 'UTC')::date as day
      from (${scope}) t
    ), used as (
      select distinct x.id as turn_id, s.key as skill
      from scope x
      cross join lateral (select x.skills union all select r.skills from runs r where r.turn_id = x.id and r.company_id = x.company_id) u
      cross join lateral jsonb_each(u.skills) s
    ), cells as (
      select distinct u.skill, x.project_id, x.model from used u join scope x on x.id = u.turn_id
    ), pairs as (
      select c.skill, x.*, exists (select 1 from used u where u.turn_id = x.id and u.skill = c.skill) as with_skill
      from cells c join scope x on x.project_id is not distinct from c.project_id and x.model = c.model
    ), cost as (
      select x.id,
        case when bool_or(c.usd is null and u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens > 0)
             then null else coalesce(sum(c.usd), 0) end as usd
      from (select distinct id, company_id, day from pairs) x
      join usage u on u.turn_id = x.id and u.company_id = x.company_id
      cross join lateral (select estimate_cost_usd(u.model, x.day, u.input_tokens, u.output_tokens,
        u.cache_read_tokens, u.cache_write_tokens) as usd) c
      group by x.id
    )
    select p.skill, p.project_id, p.model, p.with_skill, count(*) as turns, count(*) filter (where p.outcome <> 'unknown') as decided,
      count(*) filter (where p.outcome = 'success') as success, count(c.usd) as priced_turns,
      percentile_cont(0.5) within group (order by c.usd::double precision) as median_cost_usd,
      percentile_cont(0.5) within group (order by p.tokens) as median_tokens,
      percentile_cont(0.5) within group (order by p.duration_ms) as median_duration_ms
    from pairs p left join cost c on c.id = p.id
    group by 1, 2, 3, 4`;
}

/** The body of agg_skill_impact_rollups with the direct path's conditions (user filter included). */
function rollupSql(ctx: QueryCtx, d: Dims): SQL {
  const conds = (alias: string): SQL[] => {
    const a = sql.raw(alias);
    const c: SQL[] = [sql`${a}.company_id = ${ctx.viewer.companyId}::uuid`, sql`${a}.outcome_split`, sql`${a}.day >= ${d.fromDay}::date`, sql`${a}.day < ${d.toDay}::date`];
    if (d.teamId) c.push(sql`${a}.team_id = ${d.teamId}::uuid`);
    if (d.projectId) c.push(sql`${a}.project_id = ${d.projectId}::uuid`);
    if (d.userId) c.push(sql`${a}.user_id = ${d.userId}::uuid`);
    if (d.harness) c.push(sql`${a}.harness = ${d.harness}`);
    if (d.model) c.push(sql`${a}.model = ${d.model}`);
    return c;
  };
  return sql`with s as (
      select d.name as skill, d.project_id, d.model, sum(d.turns)::bigint as turns, sum(d.turns - d.unknown)::bigint as decided,
        sum(d.success)::bigint as success
      from daily_skill_mcp_rollups d ${where([...conds('d'), sql`d.kind = 'skill'`, sql`d.tool = ''`])}
      group by 1, 2, 3
    ), cell as (
      select r.project_id, r.model, sum(r.turns)::bigint as turns, sum(r.turns - r.unknown)::bigint as decided, sum(r.success)::bigint as success
      from daily_rollups r ${where(conds('r'))}
      group by 1, 2
    )
    select s.skill, s.project_id, s.model, true as with_skill, s.turns, s.decided, s.success, 0 as priced_turns,
      null as median_cost_usd, null as median_tokens, null as median_duration_ms
    from s
    union all
    select s.skill, s.project_id, s.model, false, greatest(c.turns - s.turns, 0), greatest(c.decided - s.decided, 0),
      greatest(c.success - s.success, 0), 0, null, null, null
    from s join cell c on c.project_id is not distinct from s.project_id and c.model = s.model`;
}

const COLS = sql.raw('skill, project_id, model, with_skill, turns, decided, success, priced_turns, median_cost_usd, median_tokens, median_duration_ms');

export async function getSkillImpact(ctx: QueryCtx, f: Filters): Promise<SkillImpactResult> {
  const range = rangeFor(ctx, f);
  const rollup = range.source === 'rollup';
  // Effort is not a dimension of the comparison cells; the direct raw path could filter turns by it, but then
  // the two paths would disagree, so it is ignored everywhere.
  const d = { ...dims(ctx, f, range), effort: null };
  const q = ctx.agg
    ? rollup
      ? sql`select ${COLS} from agg_skill_impact_rollups(${aggArgs(d, 'date')})`
      : sql`select ${COLS} from agg_skill_impact(${aggArgs(d, 'ts')})`
    : rollup
      ? rollupSql(ctx, d)
      : rawSql(sql`select t.* from turns t ${where(turnConds(ctx, d))}`);
  const out = await rows<Record<string, unknown>>(ctx.tx, q);
  const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const sides: ImpactCellSide[] = out.map((r) => ({
    skill: String(r.skill),
    projectId: (r.project_id as string | null) ?? null,
    model: String(r.model),
    withSkill: r.with_skill === true || r.with_skill === 't',
    turns: num(r.turns),
    decided: num(r.decided),
    success: num(r.success),
    pricedTurns: num(r.priced_turns),
    medianCostUsd: numOrNull(r.median_cost_usd),
    medianTokens: numOrNull(r.median_tokens),
    medianDurationMs: numOrNull(r.median_duration_ms),
  }));
  return { range, impacts: skillImpacts(sides), mediansAvailable: !rollup, ignoredFilters: f.effort ? ['effort'] : [] };
}
