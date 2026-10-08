import type { Outcome } from '@ai-obs/db';
import type { TokenTotals } from './sqlutil';

export interface RunRow {
  id: string;
  parentRunId: string | null;
  agentType: string;
  /** agentGroupOf(agent_type, stored agent_group) — the same group as on the Agents page. */
  agentGroup: string;
  /**
   * The workflow run the agent belongs to (ADR-0019); from agg_turn_runs on both paths. Null for Agent-tool runs and
   * rows from before ADR-0019, where the flow falls back to `flowOrchestrationId` (workflow agents by type / group).
   */
  orchestrationId: string | null;
  /** 0-based ordinal of the agent's phase inside its orchestration (ADR-0020); null when unknown. */
  stageIndex: number | null;
  /** The `<item>` of a `<stage>:<item>` label, slugged (ADR-0020); null when the label does not follow it. */
  flowKey: string | null;
  depth: number;
  model: string | null;
  effort: string | null;
  startedMs: number;
  endedMs: number;
  durationMs: number;
  tokens: TokenTotals;
  phasesMs: Record<string, number>;
  tools: Record<string, number>;
  /** Skill uses of the run (name -> model / user invocations); null when the row did not carry them. */
  skills: Record<string, { model: number; user: number }> | null;
  /** MCP calls of the run (server -> tool -> calls); null when the row did not carry them. */
  mcp: Record<string, Record<string, number>> | null;
  outcome: Outcome;
}

export interface RunNode extends RunRow {
  /** Start relative to the start of the turn (ms). */
  offsetMs: number;
  children: RunNode[];
}

/**
 * Builds the parent -> child tree of a turn's runs. A run whose parent is not in the set (or has none)
 * is a root: the main agent's direct children. Children are ordered by start time; cycles cannot
 * loop forever because each run is attached once.
 */
export function buildRunTree(runs: RunRow[], turnStartMs: number): RunNode[] {
  const nodes = new Map<string, RunNode>();
  for (const r of [...runs].sort((a, b) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : 1))) {
    nodes.set(r.id, { ...r, offsetMs: Math.max(0, r.startedMs - turnStartMs), children: [] });
  }
  const roots: RunNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentRunId ? nodes.get(n.parentRunId) : undefined;
    if (parent && parent !== n && !isAncestor(nodes, n, parent)) parent.children.push(n);
    else roots.push(n);
  }
  return roots;
}

function isAncestor(nodes: Map<string, RunNode>, candidate: RunNode, of: RunNode): boolean {
  // true when `candidate` is already an ancestor of `of` (attaching would create a cycle)
  let cur: RunNode | undefined = of;
  for (let i = 0; cur && i < nodes.size; i++) {
    if (cur.parentRunId === candidate.id) return true;
    cur = cur.parentRunId ? nodes.get(cur.parentRunId) : undefined;
  }
  return false;
}
