import { sql } from 'drizzle-orm';
import type { Filters } from '../filters';
import { aggArgs, dims, turnConds } from './providers';
import { rawRange, rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { num, outcomeRates, rows, tokensOf, where, type TokenTotals } from './sqlutil';

export interface AgentRow {
  agentType: string;
  /** Number of runs (sub-agent spawns). */
  spawns: number;
  tokens: TokenTotals;
  /** This type's share of all sub-agent tokens (0..1). */
  tokenShare: number;
  successRate: number | null;
  unknownShare: number | null;
  avgDepth: number | null;
  maxDepth: number | null;
}

export interface AgentsResult {
  range: ResolvedRange;
  rows: AgentRow[];
  totalSpawns: number;
  /** Runs per nesting depth. Null on the aggregate path: agg_agents only has avg / max depth. */
  depthHistogram: { depth: number; runs: number }[] | null;
  ignoredFilters: string[];
}

/** Sub-agent usage. Runs only exist as raw rows, so every range reads raw (no rollup form). */
export async function getAgents(ctx: QueryCtx, f: Filters): Promise<AgentsResult> {
  const range = rawRange(rangeFor(ctx, f));
  const d = dims(ctx, f, range);
  let out: Record<string, unknown>[];
  let histogram: AgentsResult['depthHistogram'] = null;
  if (ctx.agg) {
    out = await rows(
      ctx.tx,
      sql`select agent_type, runs, success, failed, abandoned, unknown, duration_ms, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens, avg_depth, max_depth from agg_agents(${aggArgs(d, 'ts')})`,
    );
  } else {
    const conds = turnConds(ctx, d);
    out = await rows(
      ctx.tx,
      sql`select r.agent_type, count(*) as runs,
            count(*) filter (where r.outcome = 'success') as success, count(*) filter (where r.outcome = 'failed') as failed,
            count(*) filter (where r.outcome = 'abandoned') as abandoned, count(*) filter (where r.outcome = 'unknown') as unknown,
            sum(r.duration_ms)::bigint as duration_ms, sum(r.input_tokens)::bigint as input_tokens,
            sum(r.output_tokens)::bigint as output_tokens, sum(r.cache_read_tokens)::bigint as cache_read_tokens,
            sum(r.cache_write_tokens)::bigint as cache_write_tokens, sum(r.reasoning_tokens)::bigint as reasoning_tokens,
            avg(r.depth) as avg_depth, max(r.depth) as max_depth
          from turns t join runs r on r.turn_id = t.id and r.company_id = t.company_id ${where(conds)} group by 1`,
    );
    const h = await rows<{ depth: number; runs: unknown }>(
      ctx.tx,
      sql`select r.depth, count(*) as runs from turns t join runs r on r.turn_id = t.id and r.company_id = t.company_id
          ${where(conds)} group by 1 order by 1`,
    );
    histogram = h.map((x) => ({ depth: Number(x.depth), runs: num(x.runs) }));
  }
  const mapped = out.map((r) => {
    const tokens = tokensOf(r);
    return {
      agentType: String(r.agent_type),
      spawns: num(r.runs),
      tokens,
      outcomes: { success: num(r.success), failed: num(r.failed), abandoned: num(r.abandoned), unknown: num(r.unknown) },
      avgDepth: r.avg_depth === null || r.avg_depth === undefined ? null : Number(r.avg_depth),
      maxDepth: r.max_depth === null || r.max_depth === undefined ? null : Number(r.max_depth),
    };
  });
  const totalTokens = mapped.reduce((s, r) => s + r.tokens.total, 0);
  const result: AgentRow[] = mapped.map((r) => ({
    agentType: r.agentType,
    spawns: r.spawns,
    tokens: r.tokens,
    tokenShare: totalTokens > 0 ? r.tokens.total / totalTokens : 0,
    ...outcomeRates(r.outcomes),
    avgDepth: r.avgDepth,
    maxDepth: r.maxDepth,
  }));
  result.sort((a, b) => b.spawns - a.spawns || a.agentType.localeCompare(b.agentType));
  return {
    range,
    rows: result,
    totalSpawns: result.reduce((s, r) => s + r.spawns, 0),
    depthHistogram: histogram,
    ignoredFilters: ctx.agg && d.effort ? ['effort'] : [],
  };
}
