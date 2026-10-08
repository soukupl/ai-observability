import type { FlowEdge, FlowLane, FlowNode } from '@/components/charts/agent-flow-layout';
import { formatClock } from '../../../components/charts/agent-graph-layout';
import { agentRunLabel } from '../../../lib/queries/agent-groups';
import { orchestrationStages } from '../../../lib/queries/flow-stages';
import type { AgentTimelineResult } from '../../../lib/queries/agent-timeline';
import { flowOrchestrationId, type RunLink } from '../../../lib/queries/run-links';

/**
 * Server-side mapping of runs + links to the Agent flow props (ADR-0020). One lane per orchestration (workflow run),
 * whose rows are its stages (phase ordinal, labelled with the phase name), and one lane per turn for its Agent-tool
 * spawns (no stages). x is time; edges are the stored + derived links between nodes that are drawn. Shared by the
 * Agents page (flowGraph) and turn detail (turnFlow in turns/_helpers).
 */

/** Most lanes one flow draws; the rest are counted in `hiddenLanes` ("+N more"). */
export const FLOW_MAX_LANES = 40;

/** The AgentFlow props without the aria label (the page words it), plus how many lanes were cut by the cap. */
export interface FlowGraph {
  lanes: FlowLane[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  fromMs: number;
  toMs: number;
  groupOrder?: string[];
  hiddenLanes: number;
}

/** The fields of a run the flow needs (a TimelineRun, or a turn-detail RunRow with its turn id). */
export interface FlowRun {
  id: string;
  turnId: string;
  agentType: string;
  agentGroup: string;
  orchestrationId: string | null;
  stageIndex: number | null;
  startedMs: number;
  endedMs: number;
  outcome: string;
  model: string | null;
}

/** The stage rule lives in lib/queries/flow-stages (shared with the Agent flows view); re-exported for callers here. */
export { orchestrationStages, stageName } from '../../../lib/queries/flow-stages';

const byStart = (a: FlowRun, b: FlowRun) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** "HH:MM" (UTC), prefixed with "MM-DD " when before `dayStartMs` (a turn that started on an earlier day). */
function clock(ms: number, dayStartMs?: number): string {
  const day = dayStartMs !== undefined && ms < dayStartMs ? `${new Date(ms).toISOString().slice(5, 10)} ` : '';
  return `${day}${formatClock(ms)}`;
}

interface LaneSpec {
  /** Lane id prefix: `o:` orchestration, `t:` a turn's Agent-tool spawns. */
  kind: 'o' | 't';
  key: string;
  runs: FlowRun[];
}

interface BuildOptions {
  /** Orchestration of a run as drawn (stored, else the pseudo one of flowOrchestrationId). */
  orchestrationOf: (r: FlowRun) => string | null;
  /** Label + sublabel of a turn lane (its Agent-tool spawns). */
  turnLane: (turnId: string, runs: FlowRun[]) => { label: string; sublabel: string | null };
  /** Sublabel of an orchestration lane. */
  orchestrationSublabel: (runs: FlowRun[]) => string | null;
  hrefOf: (r: FlowRun) => string | null;
}

/** Lanes (ordered by first run start, capped), nodes and the edges between drawn nodes. */
function buildFlow(runs: FlowRun[], links: RunLink[], o: BuildOptions): Pick<FlowGraph, 'lanes' | 'nodes' | 'edges' | 'hiddenLanes'> {
  const specs = new Map<string, LaneSpec>();
  for (const r of [...runs].sort(byStart)) {
    const orch = o.orchestrationOf(r);
    const kind = orch === null ? 't' : 'o';
    const key = orch ?? r.turnId;
    const id = `${kind}:${key}`;
    const s = specs.get(id);
    if (s) s.runs.push(r);
    else specs.set(id, { kind, key, runs: [r] });
  }
  // Insertion order = first run start (runs were sorted), ties by run id.
  const all = [...specs.entries()];
  const shown = all.slice(0, FLOW_MAX_LANES);

  const lanes: FlowLane[] = [];
  const nodes: FlowNode[] = [];
  for (const [id, s] of shown) {
    let stages: string[] = [];
    let indexOf = new Map<string, number | null>();
    let label: string;
    let sublabel: string | null;
    if (s.kind === 'o') {
      ({ stages, indexOf } = orchestrationStages(s.runs));
      label = stages.length > 0 ? stages.join(' → ') : 'workflow';
      sublabel = o.orchestrationSublabel(s.runs);
    } else {
      ({ label, sublabel } = o.turnLane(s.key, s.runs));
    }
    lanes.push({ id, label, sublabel, stages });
    for (const r of s.runs) {
      nodes.push({
        id: r.id,
        laneId: id,
        label: agentRunLabel(r.agentType),
        group: r.agentGroup,
        stageIndex: indexOf.get(r.id) ?? null,
        startMs: r.startedMs,
        endMs: r.endedMs,
        outcome: r.outcome,
        model: r.model,
        href: o.hrefOf(r),
      });
    }
  }

  const drawn = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const edges: FlowEdge[] = [];
  for (const l of links) {
    if (l.fromRunId === l.toRunId || !drawn.has(l.fromRunId) || !drawn.has(l.toRunId)) continue;
    const k = `${l.fromRunId}\u0000${l.toRunId}\u0000${l.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ fromId: l.fromRunId, toId: l.toRunId, kind: l.kind });
  }
  return { lanes, nodes, edges, hiddenLanes: all.length - shown.length };
}

const projectLabel = (t: { projectId: string | null; projectName: string | null }): string =>
  t.projectName ?? (t.projectId ? 'unknown project' : 'no project');

/**
 * The Agent flow of a timeline window: one lane per orchestration among the window's runs and one per turn that has
 * Agent-tool runs, ordered by first run start, capped at FLOW_MAX_LANES. Nodes link to their turn's detail page.
 * `groupOrder` ranks agent groups for their colours, as for the timeline graph.
 */
export function flowGraph(r: Pick<AgentTimelineResult, 'window' | 'turns' | 'runs' | 'links'>, groupOrder?: string[]): FlowGraph {
  const turns = new Map(r.turns.map((t) => [t.id, t]));
  const dayStartMs = Date.parse(`${r.window.day}T00:00:00Z`);
  const runs = r.runs.filter((x) => turns.has(x.turnId));
  const projectOfRun = (x: FlowRun) => projectLabel(turns.get(x.turnId)!);
  const built = buildFlow(runs, r.links, {
    orchestrationOf: (x) => flowOrchestrationId(x),
    turnLane: (turnId) => {
      const t = turns.get(turnId)!;
      return { label: t.summary ?? 'turn', sublabel: `${projectLabel(t)} · ${clock(t.startedMs, dayStartMs)}` };
    },
    orchestrationSublabel: (rs) => `${projectOfRun(rs[0]!)} · ${clock(rs[0]!.startedMs, dayStartMs)}`,
    hrefOf: (x) => `/turns/${x.turnId}?startedMs=${turns.get(x.turnId)!.startedMs}`,
  });
  return { ...built, fromMs: r.window.fromMs, toMs: r.window.toMs, ...(groupOrder ? { groupOrder } : {}) };
}

/** Lane builder for one turn (turn detail): exported for turns/_helpers' turnFlow. */
export function turnFlowParts(
  turn: { id: string; projectId: string | null; projectName: string | null },
  runs: FlowRun[],
  links: RunLink[],
): Pick<FlowGraph, 'lanes' | 'nodes' | 'edges' | 'hiddenLanes'> {
  const project = projectLabel(turn);
  return buildFlow(runs, links, {
    // One turn: workflow agents without a known orchestration share one pseudo lane.
    orchestrationOf: (x) => flowOrchestrationId({ orchestrationId: x.orchestrationId, agentType: x.agentType, agentGroup: x.agentGroup }),
    turnLane: (_turnId, rs) => ({ label: 'main agent spawns', sublabel: `${project} · ${clock(rs[0]!.startedMs)}` }),
    orchestrationSublabel: (rs) => `${project} · ${clock(rs[0]!.startedMs)}`,
    hrefOf: () => null,
  });
}
