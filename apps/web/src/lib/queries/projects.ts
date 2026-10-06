import { CostSum, ZERO_COST, type CostValue } from '../cost';
import type { Filters } from '../filters';
import { listProjects, listTeams } from './lookups';
import { dims, rollupFacts, turnsByProject, usageDaily, usageDailyByProject, type Dims } from './providers';
import { eachDay, rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { addTokens, costTokens, emptyOutcomes, emptyTokens, outcomeRates, type Outcomes, type TokenTotals } from './sqlutil';

export interface ProjectRow {
  /** null = turns without a project. */
  projectId: string | null;
  name: string;
  teamId: string | null;
  teamName: string | null;
  turns: number;
  tokens: TokenTotals;
  cost: CostValue;
  /** Cost was not computed (aggregate path, project beyond the per-project cap): show "n/a". */
  costSkipped: boolean;
  successRate: number | null;
  unknownShare: number | null;
  /** Total tokens per day over `sparkDays`. */
  spark: number[];
}

export interface ProjectsResult {
  range: ResolvedRange;
  /** The last up-to-14 days of the range, oldest first. */
  sparkDays: string[];
  rows: ProjectRow[];
  ignoredFilters: string[];
}

export const SPARK_DAYS = 14;
/** Aggregate path prices projects one agg_usage_daily call each; beyond this only turns/tokens are given. */
export const AGG_PROJECT_COST_CAP = 40;

interface Acc {
  turns: number;
  tokens: TokenTotals;
  outcomes: Outcomes;
  cost: CostSum;
  hasCost: boolean;
  spark: Map<string, number>;
}

export async function getProjects(ctx: QueryCtx, f: Filters): Promise<ProjectsResult> {
  const range = rangeFor(ctx, f);
  const d = dims(ctx, f, range);
  const sparkDays = eachDay(range.fromDay, range.toDay).slice(-SPARK_DAYS);
  const sparkSet = new Set(sparkDays);
  const accs = new Map<string | null, Acc>();
  const acc = (id: string | null): Acc => {
    let a = accs.get(id);
    if (!a) accs.set(id, (a = { turns: 0, tokens: emptyTokens(), outcomes: emptyOutcomes(), cost: new CostSum(ctx.prices), hasCost: false, spark: new Map() }));
    return a;
  };
  const skipped = new Set<string | null>();
  let ignored: string[] = [];

  if (range.source === 'rollup') {
    for (const x of await rollupFacts(ctx, d)) {
      const a = acc(x.projectId);
      a.turns += x.turns;
      addTokens(a.tokens, x.tokens);
      for (const k of Object.keys(a.outcomes) as (keyof Outcomes)[]) a.outcomes[k] += x.outcomes[k];
      if (x.tokens.total > 0) a.cost.add(x.model, x.day, costTokens(x.tokens));
      a.hasCost = true;
      if (sparkSet.has(x.day)) a.spark.set(x.day, (a.spark.get(x.day) ?? 0) + x.tokens.total);
    }
  } else {
    const t = await turnsByProject(ctx, d);
    ignored = t.ignored;
    for (const g of t.rows) {
      const a = acc(g.projectId ?? null);
      a.turns += g.turns;
      addTokens(a.tokens, g.tokens);
      for (const k of Object.keys(a.outcomes) as (keyof Outcomes)[]) a.outcomes[k] += g.outcomes[k];
    }
    if (!ctx.agg) {
      for (const u of await usageDailyByProject(ctx, d)) addUsage(acc(u.projectId), u.model, u.day, u.tokens, sparkSet);
    } else {
      const top = [...accs.entries()].sort((a, b) => b[1].tokens.total - a[1].tokens.total);
      let n = 0;
      for (const [id, a] of top) {
        if (id === null || n >= AGG_PROJECT_COST_CAP) {
          skipped.add(id);
          continue;
        }
        n += 1;
        await perProjectUsage(ctx, d, id, a, sparkSet);
      }
    }
  }

  const [projects, teams] = await Promise.all([listProjects(ctx), listTeams(ctx)]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const result: ProjectRow[] = [...accs.entries()].map(([id, a]) => {
    const p = id ? projectById.get(id) : undefined;
    const costSkipped = skipped.has(id);
    return {
      projectId: id,
      name: id === null ? '(no project)' : (p?.name ?? 'unknown project'),
      teamId: p?.teamId ?? null,
      teamName: p?.teamId ? (teamName.get(p.teamId) ?? null) : null,
      turns: a.turns,
      tokens: a.tokens,
      cost: costSkipped ? { usd: null, partial: false, unknownModels: [] } : a.hasCost ? a.cost.value() : ZERO_COST,
      costSkipped,
      ...outcomeRates(a.outcomes),
      spark: sparkDays.map((day) => a.spark.get(day) ?? 0),
    };
  });
  result.sort((x, y) => y.tokens.total - x.tokens.total || x.name.localeCompare(y.name));
  return { range, sparkDays, rows: result, ignoredFilters: ignored };
}

function addUsage(a: Acc, model: string, day: string, tokens: TokenTotals, sparkSet: Set<string>) {
  a.cost.add(model, day, costTokens(tokens));
  a.hasCost = true;
  if (sparkSet.has(day)) a.spark.set(day, (a.spark.get(day) ?? 0) + tokens.total);
}

async function perProjectUsage(ctx: QueryCtx, d: Dims, projectId: string, a: Acc, sparkSet: Set<string>) {
  for (const u of await usageDaily(ctx, { ...d, projectId })) addUsage(a, u.model, u.day, u.tokens, sparkSet);
}
