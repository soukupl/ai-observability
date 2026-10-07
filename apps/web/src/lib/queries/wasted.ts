import { sql, type SQL } from 'drizzle-orm';
import { CostSum, type CostValue } from '../cost';
import type { Filters } from '../filters';
import { aggArgs, dims, turnConds, type Dims } from './providers';
import { eachDay, rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { num, rows, where } from './sqlutil';

/*
 * Wasted spend (docs/briefs/wasted-spend.md, ADR-0017): ≈ cost of turns whose outcome is failed or abandoned,
 * and separately of turns with an unknown outcome ("unclassified"). Priced per usage row's model × day like
 * every cost; short ranges read usage rows joined to their turns, long ranges daily_rollups' outcome-split
 * token columns. Rollup days written before the split (outcome_split = false) count in the total but not in
 * wasted / unclassified; `unsplitDays` says how many.
 */

export interface WastedPart {
  wasted: CostValue;
  /** ≈ cost of the same rows (days without the split excluded), the share's denominator */
  total: CostValue;
}

export interface WastedResult {
  range: ResolvedRange;
  /** ≈ cost of all usage in range (split or not) */
  total: CostValue;
  wasted: CostValue;
  unclassified: CostValue;
  /** wasted / ≈ cost of the days that have the split; null without priced usage */
  share: number | null;
  /** key: project id ('' = no project) */
  byProject: Map<string, WastedPart>;
  /** key: `${model}|${effort ?? ''}` (usage model × effort) */
  byModel: Map<string, WastedPart>;
  /** wasted ≈ USD per day of the range, zero-filled */
  daily: { day: string; usd: number }[];
  /** rollup days without the outcome split (before migration 0007): their waste is unknown */
  unsplitDays: number;
  ignoredFilters: string[];
}

interface Tok {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
interface Fact {
  day: string;
  projectId: string | null;
  model: string;
  effort: string | null;
  split: boolean;
  total: Tok;
  wasted: Tok;
  unknown: Tok;
}

const zero = (): Tok => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const tok = (r: Record<string, unknown>, prefix = ''): Tok => ({
  input: num(r[`${prefix}input_tokens`]),
  output: num(r[`${prefix}output_tokens`]),
  cacheRead: num(r[`${prefix}cache_read_tokens`]),
  cacheWrite: num(r[`${prefix}cache_write_tokens`]),
});
const hasTokens = (t: Tok) => t.input + t.output + t.cacheRead + t.cacheWrite > 0;
export const modelKey = (model: string | null, effort: string | null) => `${model ?? ''}|${effort ?? ''}`;

const TOKEN_SUMS = sql.raw(
  'sum(u.input_tokens)::bigint as input_tokens, sum(u.output_tokens)::bigint as output_tokens, ' +
    'sum(u.cache_read_tokens)::bigint as cache_read_tokens, sum(u.cache_write_tokens)::bigint as cache_write_tokens',
);

async function rawFacts(ctx: QueryCtx, d: Dims): Promise<Fact[]> {
  let out: Record<string, unknown>[];
  if (ctx.agg) {
    out = await rows(
      ctx.tx,
      sql`select day::text as day, project_id, model, effort, class, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
          from agg_wasted(${aggArgs(d, 'ts')})`,
    );
    if (d.effort) out = out.filter((r) => r.effort === d.effort);
  } else {
    const conds: SQL[] = turnConds(ctx, d, { model: false, effort: false });
    if (d.model) conds.push(sql`u.model = ${d.model}`);
    if (d.effort) conds.push(sql`u.effort = ${d.effort}`);
    out = await rows(
      ctx.tx,
      sql`select (u.started_at at time zone 'UTC')::date::text as day, t.project_id, u.model, u.effort,
            case when t.outcome in ('failed', 'abandoned') then 'wasted' when t.outcome = 'unknown' then 'unknown' else 'ok' end as class,
            ${TOKEN_SUMS}
          from usage u join turns t on t.id = u.turn_id and t.company_id = u.company_id
          ${where(conds)} group by 1, 2, 3, 4, 5
          having sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) > 0`,
    );
  }
  return out.map((r) => {
    const t = tok(r);
    return {
      day: String(r.day),
      projectId: (r.project_id as string | null) ?? null,
      model: String(r.model),
      effort: (r.effort as string | null) ?? null,
      split: true,
      total: t,
      wasted: r.class === 'wasted' ? t : zero(),
      unknown: r.class === 'unknown' ? t : zero(),
    };
  });
}

async function rollupFacts(ctx: QueryCtx, d: Dims): Promise<Fact[]> {
  let out: Record<string, unknown>[];
  const cols = sql.raw(
    'input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, wasted_input_tokens, wasted_output_tokens, ' +
      'wasted_cache_read_tokens, wasted_cache_write_tokens, unknown_input_tokens, unknown_output_tokens, unknown_cache_read_tokens, unknown_cache_write_tokens',
  );
  if (ctx.agg) {
    out = await rows(ctx.tx, sql`select day::text as day, project_id, model, effort, split, ${cols} from agg_wasted_rollups(${aggArgs(d, 'date')})`);
    if (d.effort) out = out.filter((r) => r.effort === d.effort);
  } else {
    const c: SQL[] = [sql`d.company_id = ${ctx.viewer.companyId}::uuid`, sql`d.day >= ${d.fromDay}::date`, sql`d.day < ${d.toDay}::date`];
    if (d.teamId) c.push(sql`d.team_id = ${d.teamId}::uuid`);
    if (d.projectId) c.push(sql`d.project_id = ${d.projectId}::uuid`);
    if (d.userId) c.push(sql`d.user_id = ${d.userId}::uuid`);
    if (d.harness) c.push(sql`d.harness = ${d.harness}`);
    if (d.model) c.push(sql`d.model = ${d.model}`);
    if (d.effort) c.push(sql`d.effort = ${d.effort}`);
    const sums = sql.raw(
      ['input', 'output', 'cache_read', 'cache_write']
        .flatMap((k) => [`sum(d.${k}_tokens)::bigint as ${k}_tokens`, `sum(d.wasted_${k}_tokens)::bigint as wasted_${k}_tokens`, `sum(d.unknown_${k}_tokens)::bigint as unknown_${k}_tokens`])
        .join(', '),
    );
    out = await rows(
      ctx.tx,
      sql`select d.day::text as day, d.project_id, d.model, d.effort,
            coalesce(bool_and(d.outcome_split) filter (where d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens > 0), true) as split,
            ${sums}
          from daily_rollups d ${where(c)} group by 1, 2, 3, 4
          having sum(d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens) > 0`,
    );
  }
  return out.map((r) => ({
    day: String(r.day),
    projectId: (r.project_id as string | null) ?? null,
    model: String(r.model),
    effort: (r.effort as string | null) ?? null,
    split: Boolean(r.split),
    total: tok(r),
    wasted: tok(r, 'wasted_'),
    unknown: tok(r, 'unknown_'),
  }));
}

export async function getWastedSpend(ctx: QueryCtx, f: Filters): Promise<WastedResult> {
  const range = rangeFor(ctx, f);
  const d = dims(ctx, f, range);
  const facts = range.source === 'rollup' ? await rollupFacts(ctx, d) : await rawFacts(ctx, d);

  const total = new CostSum(ctx.prices);
  const splitTotal = new CostSum(ctx.prices);
  const wasted = new CostSum(ctx.prices);
  const unclassified = new CostSum(ctx.prices);
  const parts = (m: Map<string, { wasted: CostSum; total: CostSum }>, key: string) => {
    let p = m.get(key);
    if (!p) m.set(key, (p = { wasted: new CostSum(ctx.prices), total: new CostSum(ctx.prices) }));
    return p;
  };
  const byProject = new Map<string, { wasted: CostSum; total: CostSum }>();
  const byModel = new Map<string, { wasted: CostSum; total: CostSum }>();
  const daily = new Map(eachDay(range.fromDay, range.toDay).map((day) => [day, 0]));
  const unsplit = new Set<string>();

  for (const x of facts) {
    total.add(x.model, x.day, x.total);
    if (!x.split) {
      unsplit.add(x.day);
      continue;
    }
    splitTotal.add(x.model, x.day, x.total);
    const p = parts(byProject, x.projectId ?? '');
    const m = parts(byModel, modelKey(x.model, x.effort));
    p.total.add(x.model, x.day, x.total);
    m.total.add(x.model, x.day, x.total);
    if (hasTokens(x.wasted)) {
      const c = wasted.add(x.model, x.day, x.wasted);
      p.wasted.add(x.model, x.day, x.wasted);
      m.wasted.add(x.model, x.day, x.wasted);
      if (c.usd !== null && daily.has(x.day)) daily.set(x.day, daily.get(x.day)! + c.usd);
    }
    if (hasTokens(x.unknown)) unclassified.add(x.model, x.day, x.unknown);
  }

  const w = wasted.value();
  const st = splitTotal.value();
  const finish = (m: Map<string, { wasted: CostSum; total: CostSum }>) =>
    new Map([...m].map(([k, v]) => [k, { wasted: v.wasted.value(), total: v.total.value() }]));
  return {
    range,
    total: total.value(),
    wasted: w,
    unclassified: unclassified.value(),
    share: st.usd ? (w.usd ?? 0) / st.usd : null,
    byProject: finish(byProject),
    byModel: finish(byModel),
    daily: [...daily].map(([day, usd]) => ({ day, usd })),
    unsplitDays: unsplit.size,
    ignoredFilters: [],
  };
}

/** wasted / total of one part; null when nothing in it is priced. */
export const wastedShare = (p: WastedPart | undefined): number | null => (p && p.total.usd ? (p.wasted.usd ?? 0) / p.total.usd : null);

const addCostValues = (a: CostValue, b: CostValue): CostValue => ({
  usd: a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0),
  partial: a.partial || b.partial || (a.usd === null) !== (b.usd === null),
  unknownModels: [...new Set([...a.unknownModels, ...b.unknownModels])].sort(),
});

/** Several parts as one (e.g. every effort of a model). */
export function sumParts(parts: readonly WastedPart[]): WastedPart | undefined {
  if (!parts.length) return undefined;
  return parts.reduce((a, b) => ({ wasted: addCostValues(a.wasted, b.wasted), total: addCostValues(a.total, b.total) }));
}
