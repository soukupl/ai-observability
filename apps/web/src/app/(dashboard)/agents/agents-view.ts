import type { AgentsResult } from '@/lib/queries/agents';

/** Table rows for DataTable (serializable). Share and rates are fractions 0..1. */
export function agentTableRows(r: AgentsResult): Record<string, unknown>[] {
  return r.rows.map((a) => ({
    agentType: a.agentType,
    spawns: a.spawns,
    tokens: a.tokens.total,
    tokenShare: a.tokenShare,
    successRate: a.successRate,
    unknownShare: a.unknownShare,
    avgDepth: a.avgDepth === null ? null : Math.round(a.avgDepth * 10) / 10,
    maxDepth: a.maxDepth,
  }));
}

/** Tokens per agent type for the bar chart, biggest first, zero-token types dropped, tail folded into "other". */
export function tokenBars(r: AgentsResult, max = 12): { label: string; value: number }[] {
  const sorted = r.rows.filter((a) => a.tokens.total > 0).sort((a, b) => b.tokens.total - a.tokens.total);
  const head = sorted.slice(0, max).map((a) => ({ label: a.agentType, value: a.tokens.total }));
  const rest = sorted.slice(max).reduce((s, a) => s + a.tokens.total, 0);
  return rest > 0 ? [...head, { label: 'other', value: rest }] : head;
}

export function depthBars(r: AgentsResult): { label: string; value: number }[] | null {
  return r.depthHistogram ? r.depthHistogram.map((h) => ({ label: `depth ${h.depth}`, value: h.runs })) : null;
}

/** Sub-agent spawns per turn (the query layer has no distinct "turns with sub-agents" count). Null when no turns. */
export function spawnsPerTurn(totalSpawns: number, turns: number): number | null {
  return turns > 0 ? totalSpawns / turns : null;
}
