import { sql, type SQL } from 'drizzle-orm';
import { suggestEfforts, type EffortCell, type EffortSuggestion } from '../effort-advisor';
import type { Filters } from '../filters';
import { listProjects } from './lookups';
import { aggArgs, dims, turnConds } from './providers';
import { rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { num, rows, where } from './sqlutil';

export interface EffortAdvice {
  range: ResolvedRange;
  /** false when the range is not read from raw turns (medians need them): longer than 35 days or past retention */
  available: boolean;
  suggestions: (EffortSuggestion & { projectName: string | null })[];
  /** the effort filter is ignored: the advisor compares effort levels */
  ignoredFilters: string[];
}

/** The SQL body of agg_effort_cells (migration 0006) over a turn scope; used by the direct path. */
function cellsSql(scope: SQL): SQL {
  return sql`with scope as (
      select t.id, t.company_id, t.project_id, t.model, t.effort, t.outcome, t.duration_ms,
        (t.started_at at time zone 'UTC')::date as day
      from (${scope}) t where t.model is not null and t.effort is not null
    ), cost as (
      select s.id,
        case when bool_or(c.usd is null and u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens > 0)
             then null else coalesce(sum(c.usd), 0) end as usd
      from scope s
      join usage u on u.turn_id = s.id and u.company_id = s.company_id
      cross join lateral (select estimate_cost_usd(u.model, s.day, u.input_tokens, u.output_tokens,
        u.cache_read_tokens, u.cache_write_tokens) as usd) c
      group by s.id
    )
    select s.project_id, s.model, s.effort, count(*) as turns, count(*) filter (where s.outcome <> 'unknown') as decided,
      count(*) filter (where s.outcome = 'success') as success, count(c.usd) as priced_turns,
      percentile_cont(0.5) within group (order by c.usd::double precision) as median_cost_usd,
      percentile_cont(0.5) within group (order by s.duration_ms) as median_duration_ms
    from scope s left join cost c on c.id = s.id
    group by 1, 2, 3`;
}

/** Per project × primary model × effort counts and medians from raw turns (both read paths; no per-user data). */
export async function getEffortCells(ctx: QueryCtx, f: Filters): Promise<EffortCell[]> {
  const range = rangeFor(ctx, f);
  const d = { ...dims(ctx, f, range), effort: null };
  const q = ctx.agg
    ? sql`select project_id, model, effort, turns, decided, success, priced_turns, median_cost_usd, median_duration_ms
          from agg_effort_cells(${aggArgs(d, 'ts')})`
    : cellsSql(sql`select t.* from turns t ${where(turnConds(ctx, d))}`);
  const out = await rows<Record<string, unknown>>(ctx.tx, q);
  const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return out
    .map((r) => ({
      projectId: (r.project_id as string | null) ?? null,
      model: String(r.model),
      effort: String(r.effort),
      turns: num(r.turns),
      decided: num(r.decided),
      success: num(r.success),
      pricedTurns: num(r.priced_turns),
      medianCostUsd: numOrNull(r.median_cost_usd),
      medianDurationMs: numOrNull(r.median_duration_ms),
    }))
    .sort((a, b) => `${a.projectId}|${a.model}|${a.effort}`.localeCompare(`${b.projectId}|${b.model}|${b.effort}`));
}

/**
 * Effort suggestions for the filtered turns (BRIEF §8, docs/briefs/effort-advisor.md). Raw turns only: the
 * comparison is on medians. The effort filter is dropped on purpose; every other filter applies.
 */
export async function getEffortAdvice(ctx: QueryCtx, f: Filters, limit = 5): Promise<EffortAdvice> {
  const range = rangeFor(ctx, f);
  const ignoredFilters = f.effort ? ['effort'] : [];
  if (range.source !== 'raw') return { range, available: false, suggestions: [], ignoredFilters };
  const cells = await getEffortCells(ctx, f);
  const names = new Map((await listProjects(ctx)).map((p) => [p.id, p.name]));
  return {
    range,
    available: true,
    suggestions: suggestEfforts(cells, limit).map((s) => ({ ...s, projectName: s.projectId ? (names.get(s.projectId) ?? null) : null })),
    ignoredFilters,
  };
}
