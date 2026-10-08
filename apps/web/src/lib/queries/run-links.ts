/**
 * Typed links between sub-agent runs of one turn (ADR-0020): which run's result fed which later run.
 *
 * - `item`: workflow agents of one orchestration that work on the same item (`flow_key`), chained in start order.
 *   Stored only (the collector needs the label convention and the journal), never derived here.
 * - `sequence`: Agent-tool agents (no orchestration) with the same parent: each links to the sibling with the
 *   latest end that ended before it started. The collector stores them; for older rows (no stored incoming link) the
 *   same rule is applied on read by deriveSequenceLinks, so old data gets chains too.
 */

export type LinkKind = 'item' | 'sequence';

export interface RunLink {
  fromRunId: string;
  toRunId: string;
  kind: LinkKind;
}

export interface LinkableRun {
  id: string;
  parentRunId: string | null;
  orchestrationId: string | null;
  startedMs: number;
  endedMs: number;
  /**
   * The run's turn, when runs of several turns are passed (the Agents timeline): `parentRunId: null` means "the main
   * agent of THIS turn", so main-agent spawns of two turns are not siblings. Omit for a single turn.
   */
  turnId?: string;
}

const edgeKey = (l: RunLink) => `${l.fromRunId}\u0000${l.toRunId}\u0000${l.kind}`;

/** Maps a `run_links` / `agg_*_links` row; null when an end is not resolved yet or the kind is unknown. */
export function mapRunLink(r: Record<string, unknown>): RunLink | null {
  const from = r.from_run_id;
  const to = r.to_run_id;
  const kind = r.kind;
  if (from === null || from === undefined || to === null || to === undefined) return null;
  if (kind !== 'item' && kind !== 'sequence') return null;
  return { fromRunId: String(from), toRunId: String(to), kind };
}

/**
 * The stored links (deduplicated, self-links dropped) plus `sequence` links derived for runs that have no orchestration
 * and no stored incoming link. Rule (same as the collector): siblings = runs without orchestration that share the
 * parent (and the turn); run B links to the sibling A with the greatest end such that A.end <= B.start (ties: the
 * greater id wins, so the result is deterministic). Siblings that overlap in time are not chained. Cycle guard: of two
 * siblings that start at the same instant, only the lower id can lead the other (zero-length runs would otherwise link
 * both ways). A derived edge never
 * duplicates a stored one. Output order: stored links first (input order), then derived ones by target start.
 */
export function deriveSequenceLinks(runs: LinkableRun[], stored: RunLink[]): RunLink[] {
  const out: RunLink[] = [];
  const seen = new Set<string>();
  const withIncoming = new Set<string>();
  for (const l of stored) {
    if (l.fromRunId === l.toRunId) continue;
    const k = edgeKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    withIncoming.add(l.toRunId);
    out.push(l);
  }

  const groups = new Map<string, LinkableRun[]>();
  for (const r of runs) {
    if (r.orchestrationId !== null) continue;
    const key = `${r.turnId ?? ''}\u0000${r.parentRunId ?? ''}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const derived: Array<RunLink & { startedMs: number }> = [];
  for (const siblings of groups.values()) {
    if (siblings.length < 2) continue;
    for (const b of siblings) {
      if (withIncoming.has(b.id)) continue;
      let best: LinkableRun | null = null;
      for (const a of siblings) {
        if (a.id === b.id || a.endedMs > b.startedMs) continue;
        // two zero-length runs at the same instant would link both ways: only the lower id leads (collector rule)
        if (a.startedMs === b.startedMs && a.id > b.id) continue;
        if (!best || a.endedMs > best.endedMs || (a.endedMs === best.endedMs && a.id > best.id)) best = a;
      }
      if (!best) continue;
      const l: RunLink = { fromRunId: best.id, toRunId: b.id, kind: 'sequence' };
      const k = edgeKey(l);
      if (seen.has(k)) continue;
      seen.add(k);
      derived.push({ ...l, startedMs: b.startedMs });
    }
  }
  derived.sort((x, y) => x.startedMs - y.startedMs || (x.toRunId < y.toRunId ? -1 : x.toRunId > y.toRunId ? 1 : 0));
  for (const d of derived) out.push({ fromRunId: d.fromRunId, toRunId: d.toRunId, kind: d.kind });
  return out;
}

/** Stored `agent_type` of a workflow agent: `workflow:<label>`, or `workflow-subagent` when it had no label. */
const WORKFLOW_TYPE = /^workflow(:|-subagent$)/;
/** Stored or derived `agent_group` of a workflow agent (`workflow:<phase|verb>`, or `workflow`). */
const WORKFLOW_GROUP = /^workflow(:|$)/;

/** Whether a run is a workflow agent, from its type or group (for rows whose orchestration is unknown). */
export function isWorkflowRun(r: { agentType: string; agentGroup?: string | null }): boolean {
  return WORKFLOW_TYPE.test(r.agentType) || (r.agentGroup != null && WORKFLOW_GROUP.test(r.agentGroup));
}

/**
 * The orchestration a run is drawn and chained under: the stored one, else — for a workflow agent whose orchestration
 * is unknown (rows from before ADR-0019) — one pseudo orchestration per turn (`workflow` + the turn id when given), so
 * old workflow agents are neither chained as `sequence` siblings nor scattered over the main agent's lane. A workflow
 * agent is told by its type or group (`isWorkflowRun`), labelled or not. Agent-tool runs keep null.
 */
export function flowOrchestrationId(r: { orchestrationId: string | null; agentType: string; agentGroup?: string | null; turnId?: string }): string | null {
  if (r.orchestrationId) return r.orchestrationId;
  return isWorkflowRun(r) ? `workflow${r.turnId ? `@${r.turnId}` : ''}` : null;
}
