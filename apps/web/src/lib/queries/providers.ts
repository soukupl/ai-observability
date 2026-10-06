import { sql, type SQL } from 'drizzle-orm';
import type { Filters } from '../filters';
import type { ResolvedRange } from './range';
import { effectiveUserId, type QueryCtx } from './scope';
import { num, rows, tokensOf, where, type Outcomes, type TokenTotals } from './sqlutil';

/**
 * Row providers: the few SQL shapes every view is built from. Each has two implementations with the
 * same output, picked by `ctx.agg`:
 *   direct  - SELECT from the tables; RLS limits the rows to what the viewer may see.
 *   agg     - the agg_* SECURITY DEFINER functions (leads / admins in aggregates-only mode); no user_id.
 * Filters the agg_* functions cannot express are applied in JS where the output has the column
 * (effort on usage / rollup rows) and otherwise reported in `ignored`.
 */

export interface Dims {
  fromIso: string;
  toIso: string;
  fromDay: string;
  toDay: string;
  teamId: string | null;
  projectId: string | null;
  userId: string | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
}

export function dims(ctx: QueryCtx, f: Filters, r: ResolvedRange): Dims {
  return {
    fromIso: r.fromIso,
    toIso: r.toIso,
    fromDay: r.fromDay,
    toDay: r.toDay,
    teamId: f.teamId,
    projectId: f.projectId,
    userId: effectiveUserId(ctx.viewer, f),
    harness: f.harness,
    model: f.model,
    effort: f.effort,
  };
}

const uuidOrNull = (v: string | null) => sql`${v}::uuid`;
const textOrNull = (v: string | null) => sql`${v}::text`;

/** Arguments of the agg_* functions: (from, to, team, project, harness, model). */
export function aggArgs(d: Dims, kind: 'ts' | 'date'): SQL {
  const from = kind === 'ts' ? sql`${d.fromIso}::timestamptz` : sql`${d.fromDay}::date`;
  const to = kind === 'ts' ? sql`${d.toIso}::timestamptz` : sql`${d.toDay}::date`;
  return sql`${from}, ${to}, ${uuidOrNull(d.teamId)}, ${uuidOrNull(d.projectId)}, ${textOrNull(d.harness)}, ${textOrNull(d.model)}`;
}

/** WHERE conditions on `turns` aliased `t` (direct path). `model`/`effort` are the turn's primary ones. */
export function turnConds(ctx: QueryCtx, d: Dims, opts: { model?: boolean; effort?: boolean } = {}): SQL[] {
  const c: SQL[] = [
    sql`t.company_id = ${ctx.viewer.companyId}::uuid`,
    sql`t.started_at >= ${d.fromIso}::timestamptz`,
    sql`t.started_at < ${d.toIso}::timestamptz`,
  ];
  if (d.teamId) c.push(sql`t.team_id = ${d.teamId}::uuid`);
  if (d.projectId) c.push(sql`t.project_id = ${d.projectId}::uuid`);
  if (d.userId) c.push(sql`t.user_id = ${d.userId}::uuid`);
  if (d.harness) c.push(sql`t.harness = ${d.harness}`);
  if (opts.model !== false && d.model) c.push(sql`t.model = ${d.model}`);
  if (opts.effort !== false && d.effort) c.push(sql`t.effort = ${d.effort}`);
  return c;
}

const OUTCOME_SUMS = (alias: string) =>
  sql.raw(
    `count(*) filter (where ${alias}.outcome = 'success') as success, count(*) filter (where ${alias}.outcome = 'failed') as failed, ` +
      `count(*) filter (where ${alias}.outcome = 'abandoned') as abandoned, count(*) filter (where ${alias}.outcome = 'unknown') as unknown`,
  );
const TURN_TOKEN_SUMS = (alias: string) =>
  sql.raw(
    `sum(${alias}.input_tokens)::bigint as input_tokens, sum(${alias}.output_tokens)::bigint as output_tokens, ` +
      `sum(${alias}.cache_read_tokens)::bigint as cache_read_tokens, sum(${alias}.cache_write_tokens)::bigint as cache_write_tokens, ` +
      `sum(${alias}.reasoning_tokens)::bigint as reasoning_tokens`,
  );

const outcomesOf = (r: Record<string, unknown>): Outcomes => ({
  success: num(r.success),
  failed: num(r.failed),
  abandoned: num(r.abandoned),
  unknown: num(r.unknown),
});

// ---------------------------------------------------------------------------------------------
// Turn stats per day (raw)
// ---------------------------------------------------------------------------------------------
export interface TurnDay {
  day: string;
  turns: number;
  outcomes: Outcomes;
  durationMs: number;
  tokens: TokenTotals;
}

/** `ignored` lists filters the aggregate path could not apply (effort). */
export async function turnDaily(ctx: QueryCtx, d: Dims): Promise<{ rows: TurnDay[]; ignored: string[] }> {
  const q = ctx.agg
    ? sql`select day::text as day, turns, success, failed, abandoned, unknown, duration_ms, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens from agg_turns_daily(${aggArgs(d, 'ts')}) order by day`
    : sql`select (t.started_at at time zone 'UTC')::date::text as day, count(*) as turns, ${OUTCOME_SUMS('t')},
            sum(t.duration_ms)::bigint as duration_ms, ${TURN_TOKEN_SUMS('t')}
          from turns t ${where(turnConds(ctx, d))} group by 1 order by 1`;
  const out = await rows<Record<string, unknown>>(ctx.tx, q);
  return {
    rows: out.map((r) => ({
      day: String(r.day),
      turns: num(r.turns),
      outcomes: outcomesOf(r),
      durationMs: num(r.duration_ms),
      tokens: tokensOf(r),
    })),
    ignored: ctx.agg && d.effort ? ['effort'] : [],
  };
}

// ---------------------------------------------------------------------------------------------
// Token usage per day x model x effort (raw, from `usage` rows: handles mixed-model turns)
// ---------------------------------------------------------------------------------------------
export interface UsageDay {
  day: string;
  model: string;
  effort: string | null;
  tokens: TokenTotals;
  requests: number;
}

/**
 * Usage rows with no tokens are leftovers (ingest zeroes the rows of a model a re-sent turn no longer
 * reports; app_ingest cannot delete). They carry no cost and must not flag an unpriced model or show
 * up as a model row, so every usage read drops them.
 */
const NONZERO_USAGE = sql.raw('having sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) > 0');
const hasTokens = (r: Record<string, unknown>): boolean => tokensOf(r).total > 0;

export async function usageDaily(ctx: QueryCtx, d: Dims): Promise<UsageDay[]> {
  let out: Record<string, unknown>[];
  if (ctx.agg) {
    out = await rows(
      ctx.tx,
      sql`select day::text as day, model, effort, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            reasoning_tokens, requests from agg_usage_daily(${aggArgs(d, 'ts')}) order by day, model, effort`,
    );
    if (d.effort) out = out.filter((r) => r.effort === d.effort);
    out = out.filter(hasTokens);
  } else {
    const conds = turnConds(ctx, d, { model: false, effort: false });
    if (d.model) conds.push(sql`u.model = ${d.model}`);
    if (d.effort) conds.push(sql`u.effort = ${d.effort}`);
    out = await rows(
      ctx.tx,
      sql`select (u.started_at at time zone 'UTC')::date::text as day, u.model, u.effort,
            sum(u.input_tokens)::bigint as input_tokens, sum(u.output_tokens)::bigint as output_tokens,
            sum(u.cache_read_tokens)::bigint as cache_read_tokens, sum(u.cache_write_tokens)::bigint as cache_write_tokens,
            sum(u.reasoning_tokens)::bigint as reasoning_tokens, sum(u.requests)::bigint as requests
          from usage u join turns t on t.id = u.turn_id and t.company_id = u.company_id
          ${where(conds)} group by 1, 2, 3 ${NONZERO_USAGE} order by 1, 2, 3`,
    );
  }
  return out.map((r) => ({
    day: String(r.day),
    model: String(r.model),
    effort: (r.effort as string | null) ?? null,
    tokens: tokensOf(r),
    requests: num(r.requests),
  }));
}

/** Direct-path only: usage per project x day x model (project cost + sparkline). */
export async function usageDailyByProject(ctx: QueryCtx, d: Dims): Promise<(UsageDay & { projectId: string | null })[]> {
  const conds = turnConds(ctx, d, { model: false, effort: false });
  if (d.model) conds.push(sql`u.model = ${d.model}`);
  if (d.effort) conds.push(sql`u.effort = ${d.effort}`);
  const out = await rows<Record<string, unknown>>(
    ctx.tx,
    sql`select t.project_id, (u.started_at at time zone 'UTC')::date::text as day, u.model,
          sum(u.input_tokens)::bigint as input_tokens, sum(u.output_tokens)::bigint as output_tokens,
          sum(u.cache_read_tokens)::bigint as cache_read_tokens, sum(u.cache_write_tokens)::bigint as cache_write_tokens,
          sum(u.reasoning_tokens)::bigint as reasoning_tokens, sum(u.requests)::bigint as requests
        from usage u join turns t on t.id = u.turn_id and t.company_id = u.company_id
        ${where(conds)} group by 1, 2, 3 ${NONZERO_USAGE}`,
  );
  return out.map((r) => ({
    projectId: (r.project_id as string | null) ?? null,
    day: String(r.day),
    model: String(r.model),
    effort: null,
    tokens: tokensOf(r),
    requests: num(r.requests),
  }));
}

// ---------------------------------------------------------------------------------------------
// Daily rollup facts (long ranges): day x team x project x harness x model x effort, users collapsed
// ---------------------------------------------------------------------------------------------
export interface RollupFact {
  day: string;
  teamId: string | null;
  projectId: string | null;
  harness: string;
  model: string;
  effort: string | null;
  turns: number;
  runs: number;
  outcomes: Outcomes;
  durationMs: number;
  requests: number;
  tokens: TokenTotals;
}

export async function rollupFacts(ctx: QueryCtx, d: Dims): Promise<RollupFact[]> {
  let out: Record<string, unknown>[];
  if (ctx.agg) {
    out = await rows(
      ctx.tx,
      sql`select day::text as day, team_id, project_id, harness, model, effort, turns, runs, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens, requests, duration_ms, success, failed, abandoned, unknown
          from agg_rollups(${aggArgs(d, 'date')})`,
    );
    if (d.effort) out = out.filter((r) => r.effort === d.effort);
  } else {
    const c: SQL[] = [
      sql`d.company_id = ${ctx.viewer.companyId}::uuid`,
      sql`d.day >= ${d.fromDay}::date`,
      sql`d.day < ${d.toDay}::date`,
    ];
    if (d.teamId) c.push(sql`d.team_id = ${d.teamId}::uuid`);
    if (d.projectId) c.push(sql`d.project_id = ${d.projectId}::uuid`);
    if (d.userId) c.push(sql`d.user_id = ${d.userId}::uuid`);
    if (d.harness) c.push(sql`d.harness = ${d.harness}`);
    if (d.model) c.push(sql`d.model = ${d.model}`);
    if (d.effort) c.push(sql`d.effort = ${d.effort}`);
    out = await rows(
      ctx.tx,
      sql`select d.day::text as day, d.team_id, d.project_id, d.harness, d.model, d.effort, sum(d.turns)::bigint as turns,
            sum(d.runs)::bigint as runs, sum(d.input_tokens)::bigint as input_tokens, sum(d.output_tokens)::bigint as output_tokens,
            sum(d.cache_read_tokens)::bigint as cache_read_tokens, sum(d.cache_write_tokens)::bigint as cache_write_tokens,
            sum(d.reasoning_tokens)::bigint as reasoning_tokens, sum(d.requests)::bigint as requests,
            sum(d.duration_ms)::bigint as duration_ms, sum(d.success)::bigint as success, sum(d.failed)::bigint as failed,
            sum(d.abandoned)::bigint as abandoned, sum(d.unknown)::bigint as unknown
          from daily_rollups d ${where(c)} group by 1, 2, 3, 4, 5, 6 order by 1`,
    );
  }
  return out.map((r) => ({
    day: String(r.day),
    teamId: (r.team_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    harness: String(r.harness),
    model: String(r.model),
    effort: (r.effort as string | null) ?? null,
    turns: num(r.turns),
    runs: num(r.runs),
    outcomes: outcomesOf(r),
    durationMs: num(r.duration_ms),
    requests: num(r.requests),
    tokens: tokensOf(r),
  }));
}

// ---------------------------------------------------------------------------------------------
// Turn stats by project and by model x effort (raw)
// ---------------------------------------------------------------------------------------------
export interface TurnGroup {
  projectId?: string | null;
  model?: string | null;
  effort?: string | null;
  turns: number;
  outcomes: Outcomes;
  durationMs: number;
  medianDurationMs: number | null;
  tokens: TokenTotals;
}

export async function turnsByProject(ctx: QueryCtx, d: Dims): Promise<{ rows: TurnGroup[]; ignored: string[] }> {
  const q = ctx.agg
    ? sql`select project_id, turns, success, failed, abandoned, unknown, duration_ms, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens from agg_turns_by_project(${aggArgs(d, 'ts')})`
    : sql`select t.project_id, count(*) as turns, ${OUTCOME_SUMS('t')}, sum(t.duration_ms)::bigint as duration_ms,
            ${TURN_TOKEN_SUMS('t')} from turns t ${where(turnConds(ctx, d))} group by 1`;
  const out = await rows<Record<string, unknown>>(ctx.tx, q);
  return {
    rows: out.map((r) => ({
      projectId: (r.project_id as string | null) ?? null,
      turns: num(r.turns),
      outcomes: outcomesOf(r),
      durationMs: num(r.duration_ms),
      medianDurationMs: null,
      tokens: tokensOf(r),
    })),
    ignored: ctx.agg && d.effort ? ['effort'] : [],
  };
}

export async function turnsByModel(ctx: QueryCtx, d: Dims): Promise<TurnGroup[]> {
  const q = ctx.agg
    ? sql`select model, effort, turns, success, failed, abandoned, unknown, duration_ms, median_duration_ms, input_tokens,
            output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens from agg_turns_by_model(${aggArgs(d, 'ts')})`
    : sql`select t.model, t.effort, count(*) as turns, ${OUTCOME_SUMS('t')}, sum(t.duration_ms)::bigint as duration_ms,
            percentile_cont(0.5) within group (order by t.duration_ms) as median_duration_ms, ${TURN_TOKEN_SUMS('t')}
          from turns t ${where(turnConds(ctx, d))} group by 1, 2`;
  let out = await rows<Record<string, unknown>>(ctx.tx, q);
  if (ctx.agg && d.effort) out = out.filter((r) => r.effort === d.effort);
  return out.map((r) => ({
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    turns: num(r.turns),
    outcomes: outcomesOf(r),
    durationMs: num(r.duration_ms),
    medianDurationMs: r.median_duration_ms === null || r.median_duration_ms === undefined ? null : Number(r.median_duration_ms),
    tokens: tokensOf(r),
  }));
}
