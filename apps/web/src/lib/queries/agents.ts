import { sql } from 'drizzle-orm';
import type { Filters } from '../filters';
import { agentGroupOf } from './agent-groups';
import { aggArgs, dims, turnConds } from './providers';
import { rawRange, rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { addTokens, emptyTokens, num, outcomeRates, rows, tokensOf, where, type Outcomes, type TokenTotals } from './sqlutil';

/** One raw agent type within one group (a type whose runs carry different stored groups has a row per group). */
export interface AgentRow {
  agentType: string;
  /** Logical group (agentGroupOf: the stored agent_group, else derived from agent_type). */
  agentGroup: string;
  /** Number of runs (sub-agent spawns). */
  spawns: number;
  tokens: TokenTotals;
  /** This type's share of all sub-agent tokens (0..1). */
  tokenShare: number;
  successRate: number | null;
  unknownShare: number | null;
  avgDepth: number | null;
  maxDepth: number | null;
  outcomes: Outcomes;
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
      sql`select agent_type, agent_group, runs, success, failed, abandoned, unknown, duration_ms, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, reasoning_tokens, avg_depth, max_depth from agg_agents(${aggArgs(d, 'ts')})`,
    );
  } else {
    const conds = turnConds(ctx, d);
    out = await rows(
      ctx.tx,
      sql`select r.agent_type, r.agent_group, count(*) as runs,
            count(*) filter (where r.outcome = 'success') as success, count(*) filter (where r.outcome = 'failed') as failed,
            count(*) filter (where r.outcome = 'abandoned') as abandoned, count(*) filter (where r.outcome = 'unknown') as unknown,
            sum(r.duration_ms)::bigint as duration_ms, sum(r.input_tokens)::bigint as input_tokens,
            sum(r.output_tokens)::bigint as output_tokens, sum(r.cache_read_tokens)::bigint as cache_read_tokens,
            sum(r.cache_write_tokens)::bigint as cache_write_tokens, sum(r.reasoning_tokens)::bigint as reasoning_tokens,
            avg(r.depth) as avg_depth, max(r.depth) as max_depth
          from turns t join runs r on r.turn_id = t.id ${where(conds)} group by 1, 2`,
    );
    const h = await rows<{ depth: number; runs: unknown }>(
      ctx.tx,
      sql`select r.depth, count(*) as runs from turns t join runs r on r.turn_id = t.id
          ${where(conds)} group by 1 order by 1`,
    );
    histogram = h.map((x) => ({ depth: Number(x.depth), runs: num(x.runs) }));
  }
  const result = mergeAgentRows(out);
  return {
    range,
    rows: result,
    totalSpawns: result.reduce((s, r) => s + r.spawns, 0),
    depthHistogram: histogram,
    ignoredFilters: ctx.agg && d.effort ? ['effort'] : [],
  };
}

/**
 * DB rows (one per agent_type x stored agent_group) -> AgentRow, one per agent_type x resolved group:
 * rows of a type with no stored group and rows whose stored group equals the derived one are merged.
 * Token share, rates and the spawn-weighted average depth are computed after the merge. Sorted by
 * spawns desc, then type.
 */
export function mergeAgentRows(out: Record<string, unknown>[]): AgentRow[] {
  type Acc = { agentType: string; agentGroup: string; spawns: number; tokens: TokenTotals; outcomes: Outcomes; depthSum: number; depthRuns: number; maxDepth: number | null };
  const acc = new Map<string, Acc>();
  for (const r of out) {
    const agentType = String(r.agent_type);
    const agentGroup = agentGroupOf(agentType, (r.agent_group as string | null | undefined) ?? null);
    const key = `${agentType}\u0000${agentGroup}`;
    let a = acc.get(key);
    if (!a) {
      a = { agentType, agentGroup, spawns: 0, tokens: emptyTokens(), outcomes: { success: 0, failed: 0, abandoned: 0, unknown: 0 }, depthSum: 0, depthRuns: 0, maxDepth: null };
      acc.set(key, a);
    }
    const spawns = num(r.runs);
    a.spawns += spawns;
    addTokens(a.tokens, tokensOf(r));
    a.outcomes.success += num(r.success);
    a.outcomes.failed += num(r.failed);
    a.outcomes.abandoned += num(r.abandoned);
    a.outcomes.unknown += num(r.unknown);
    if (r.avg_depth !== null && r.avg_depth !== undefined) {
      a.depthSum += Number(r.avg_depth) * spawns;
      a.depthRuns += spawns;
    }
    if (r.max_depth !== null && r.max_depth !== undefined) a.maxDepth = Math.max(a.maxDepth ?? -Infinity, Number(r.max_depth));
  }
  const merged = [...acc.values()];
  const totalTokens = merged.reduce((s, r) => s + r.tokens.total, 0);
  const result: AgentRow[] = merged.map((r) => ({
    agentType: r.agentType,
    agentGroup: r.agentGroup,
    spawns: r.spawns,
    tokens: r.tokens,
    tokenShare: totalTokens > 0 ? r.tokens.total / totalTokens : 0,
    ...outcomeRates(r.outcomes),
    avgDepth: r.depthRuns > 0 ? r.depthSum / r.depthRuns : null,
    maxDepth: r.maxDepth,
    outcomes: r.outcomes,
  }));
  result.sort((a, b) => b.spawns - a.spawns || a.agentType.localeCompare(b.agentType) || a.agentGroup.localeCompare(b.agentGroup));
  return result;
}
