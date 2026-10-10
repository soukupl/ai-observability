import type { AgentRow, AgentsResult } from '@/lib/queries/agents';
import { TIMELINE_PARAMS } from '../../../lib/queries/agent-timeline';
import { addTokens, emptyTokens, outcomeRates, type Outcomes, type TokenTotals } from '../../../lib/queries/sqlutil';

/**
 * One logical agent group (ADR-0019) with its raw agent types. Plain data: a server page passes it to
 * the AgentGroupsTable client component.
 */
export interface AgentGroupRow {
  group: string;
  spawns: number;
  tokens: TokenTotals;
  /** This group's share of all sub-agent tokens (0..1). */
  tokenShare: number;
  outcomes: Outcomes;
  successRate: number | null;
  unknownShare: number | null;
  /** Spawn-weighted over the member types that have a depth. */
  avgDepth: number | null;
  maxDepth: number | null;
  /** Member types, spawns desc then name. */
  types: AgentRow[];
}

/** One row per agent group: spawns, tokens and outcomes summed over its types. Spawns desc, then name. */
export function groupAgentRows(r: Pick<AgentsResult, 'rows'>): AgentGroupRow[] {
  const by = new Map<string, AgentRow[]>();
  for (const a of r.rows) {
    const list = by.get(a.agentGroup);
    if (list) list.push(a);
    else by.set(a.agentGroup, [a]);
  }
  const totalTokens = r.rows.reduce((s, a) => s + a.tokens.total, 0);
  const out: AgentGroupRow[] = [];
  for (const [group, members] of by) {
    const tokens = emptyTokens();
    const outcomes: Outcomes = { success: 0, failed: 0, abandoned: 0, unknown: 0 };
    let spawns = 0;
    let depthSum = 0;
    let depthSpawns = 0;
    let maxDepth: number | null = null;
    for (const a of members) {
      spawns += a.spawns;
      addTokens(tokens, a.tokens);
      outcomes.success += a.outcomes.success;
      outcomes.failed += a.outcomes.failed;
      outcomes.abandoned += a.outcomes.abandoned;
      outcomes.unknown += a.outcomes.unknown;
      if (a.avgDepth !== null) {
        depthSum += a.avgDepth * a.spawns;
        depthSpawns += a.spawns;
      }
      if (a.maxDepth !== null) maxDepth = maxDepth === null ? a.maxDepth : Math.max(maxDepth, a.maxDepth);
    }
    out.push({
      group,
      spawns,
      tokens,
      tokenShare: totalTokens > 0 ? tokens.total / totalTokens : 0,
      outcomes,
      ...outcomeRates(outcomes),
      avgDepth: depthSpawns > 0 ? depthSum / depthSpawns : null,
      maxDepth,
      types: [...members].sort((a, b) => b.spawns - a.spawns || a.agentType.localeCompare(b.agentType)),
    });
  }
  return out.sort((a, b) => b.spawns - a.spawns || a.group.localeCompare(b.group));
}

/** Table rows for DataTable / raw use, one per agent type (serializable). Share and rates are fractions 0..1. */
export function agentTableRows(r: AgentsResult): Record<string, unknown>[] {
  return r.rows.map((a) => ({
    agentType: a.agentType,
    agentGroup: a.agentGroup,
    spawns: a.spawns,
    tokens: a.tokens.total,
    tokenShare: a.tokenShare,
    successRate: a.successRate,
    unknownShare: a.unknownShare,
    avgDepth: a.avgDepth === null ? null : Math.round(a.avgDepth * 10) / 10,
    maxDepth: a.maxDepth,
  }));
}

/**
 * Tokens per agent GROUP for the bar chart, biggest first, zero-token groups dropped, tail folded into
 * "other". Takes the group rows (or a whole result, which is grouped first).
 */
export function tokenBars(src: AgentGroupRow[] | Pick<AgentsResult, 'rows'>, max = 12): { label: string; value: number }[] {
  const groups = Array.isArray(src) ? src : groupAgentRows(src);
  const sorted = groups.filter((g) => g.tokens.total > 0).sort((a, b) => b.tokens.total - a.tokens.total || a.group.localeCompare(b.group));
  const head = sorted.slice(0, max).map((g) => ({ label: g.group, value: g.tokens.total }));
  const rest = sorted.slice(max).reduce((s, g) => s + g.tokens.total, 0);
  return rest > 0 ? [...head, { label: 'other', value: rest }] : head;
}

export function depthBars(r: AgentsResult): { label: string; value: number }[] | null {
  return r.depthHistogram ? r.depthHistogram.map((h) => ({ label: `depth ${h.depth}`, value: h.runs })) : null;
}

/** Sub-agent spawns per turn (the query layer has no distinct "turns with sub-agents" count). Null when no turns. */
export function spawnsPerTurn(totalSpawns: number, turns: number): number | null {
  return turns > 0 ? totalSpawns / turns : null;
}

/** Params the Agents page drops when it links to /flows: the timeline window and the page number. */
const NOT_FOR_FLOWS = new Set<string>([TIMELINE_PARAMS.day, TIMELINE_PARAMS.from, TIMELINE_PARAMS.to, 'page']);

/**
 * Query string (without `?`) for the "flows →" links of the agent groups table: the current search params minus the
 * timeline window and paging, so the flows list opens under the same filters; the table appends `group=`.
 */
export function flowsQueryString(sp: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (NOT_FOR_FLOWS.has(k) || k === 'group' || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) p.append(k, one);
  }
  return p.toString();
}
