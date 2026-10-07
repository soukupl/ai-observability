import type { AgentGraphProps } from '@/components/charts/AgentGraph';
import { formatClock, type GraphLane, type GraphRun, type GraphTurn } from '../../../components/charts/agent-graph-layout';
import { agentRunLabel } from '../../../lib/queries/agent-groups';
import { TIMELINE_PARAMS, type AgentTimelineResult } from '../../../lib/queries/agent-timeline';

/**
 * Server-side mapping of the agent timeline (ADR-0019) to the git-graph props: one lane per session, lanes ordered by
 * project name then first turn, coloured by project (the user asked for every agent to be bound to its project: a
 * run sits on its turn's session lane, whose label and colour are the project's).
 */

type Params = Record<string, string | string[] | undefined>;

export const NO_PROJECT = 'no project';

interface ProjectKey {
  key: string;
  label: string;
}

const projectOf = (t: { projectId: string | null; projectName: string | null }): ProjectKey =>
  t.projectId ? { key: t.projectId, label: t.projectName ?? 'unknown project' } : { key: '', label: NO_PROJECT };

const byLabel = (a: ProjectKey, b: ProjectKey) => {
  // "no project" last; otherwise by name (case-insensitive), ties by id so equal names stay stable.
  if (!a.key !== !b.key) return a.key ? -1 : 1;
  return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
};

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export type TimelineGraph = Omit<AgentGraphProps, 'onZoom'>;

/**
 * Sublabel of a session lane: the harness and when the session's first turn in the window started (UTC), so two
 * sessions of one project are told apart without showing any session id ("claude-code · 21:46"; "10-04 23:10" when
 * that turn started on an earlier day). Short enough for the graph's lane gutter.
 */
export function laneSublabel(harness: string, firstMs: number, dayStartMs: number): string {
  const day = new Date(firstMs).toISOString().slice(5, 10);
  return `${harness} · ${firstMs < dayStartMs ? `${day} ` : ''}${formatClock(firstMs)}`;
}

/**
 * Lanes, turns, runs and the project legend of the window. `groupOrder` ranks the agent groups for their colours (the
 * Agents page passes its groups by spawns in the filter range, so colours stay put when the window changes).
 */
export function timelineGraph(r: Pick<AgentTimelineResult, 'window' | 'turns' | 'runs'>, groupOrder?: string[]): TimelineGraph {
  // Project legend: the projects present, sorted by name; the index is the colour.
  const projects = new Map<string, ProjectKey>();
  for (const t of r.turns) {
    const p = projectOf(t);
    if (!projects.has(p.key)) projects.set(p.key, p);
  }
  const legend = [...projects.values()].sort(byLabel);
  const colorOf = new Map(legend.map((p, i) => [p.key, i]));

  // Lanes: one per session (a turn without a session gets its own lane).
  interface LaneAcc {
    id: string;
    project: ProjectKey;
    harness: string;
    firstMs: number;
  }
  const lanes = new Map<string, LaneAcc>();
  const laneOfTurn = new Map<string, string>();
  for (const t of r.turns) {
    const id = t.sessionId ? `s:${t.sessionId}` : `t:${t.id}`;
    laneOfTurn.set(t.id, id);
    const cur = lanes.get(id);
    if (!cur) lanes.set(id, { id, project: projectOf(t), harness: t.harness, firstMs: t.startedMs });
    else if (t.startedMs < cur.firstMs) cur.firstMs = t.startedMs;
  }
  const ordered = [...lanes.values()].sort(
    (a, b) => byLabel(a.project, b.project) || a.firstMs - b.firstMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const dayStartMs = Date.parse(`${r.window.day}T00:00:00Z`);
  const graphLanes: GraphLane[] = ordered.map((l) => ({
    id: l.id,
    label: l.project.label,
    sublabel: laneSublabel(l.harness, l.firstMs, dayStartMs),
    colorIndex: colorOf.get(l.project.key) ?? 0,
  }));

  const turns: GraphTurn[] = r.turns.map((t) => ({
    id: t.id,
    laneId: laneOfTurn.get(t.id)!,
    label: t.summary ?? 'turn',
    href: `/turns/${t.id}?startedMs=${t.startedMs}`,
    startMs: t.startedMs,
    endMs: t.endedMs,
    outcome: t.outcome,
  }));
  const turnIds = new Set(r.turns.map((t) => t.id));
  const runs: GraphRun[] = r.runs
    .filter((x) => turnIds.has(x.turnId))
    .map((x) => ({
      id: x.id,
      turnId: x.turnId,
      parentRunId: x.parentRunId,
      label: agentRunLabel(x.agentType),
      group: x.agentGroup,
      depth: x.depth,
      startMs: x.startedMs,
      endMs: x.endedMs,
      outcome: x.outcome,
      model: x.model,
    }));

  return {
    lanes: graphLanes,
    turns,
    runs,
    fromMs: r.window.fromMs,
    toMs: r.window.toMs,
    projectLegend: legend.map((p, i) => ({ label: p.label, colorIndex: i })),
    ...(groupOrder ? { groupOrder } : {}),
    ariaLabel: `Agent timeline: ${plural(turns.length, 'turn')} and ${plural(runs.length, 'sub-agent run')} in ${plural(graphLanes.length, 'session')}`,
  };
}

/** `path?query` with every current param kept, the day set and the window params replaced (none = whole day). */
export function timelineHref(pathname: string, sp: Params, day: string, window?: { from: string; to: string }): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === TIMELINE_PARAMS.day || k === TIMELINE_PARAMS.from || k === TIMELINE_PARAMS.to || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) p.append(k, one);
  }
  p.set(TIMELINE_PARAMS.day, day);
  if (window) {
    p.set(TIMELINE_PARAMS.from, window.from);
    p.set(TIMELINE_PARAMS.to, window.to);
  }
  return `${pathname}?${p.toString()}`;
}

/** Prev / next day that has turns (relative to the window's day), and the whole-day link (null when already whole). */
export function timelineNav(
  pathname: string,
  sp: Params,
  r: Pick<AgentTimelineResult, 'window' | 'days'>,
): { prevHref: string | null; nextHref: string | null; wholeDayHref: string | null } {
  const { day, fromMin, toMin } = r.window;
  const prev = [...r.days].reverse().find((d) => d < day) ?? null;
  const next = r.days.find((d) => d > day) ?? null;
  const whole = fromMin <= 0 && toMin >= 1440;
  return {
    prevHref: prev ? timelineHref(pathname, sp, prev) : null,
    nextHref: next ? timelineHref(pathname, sp, next) : null,
    wholeDayHref: whole ? null : timelineHref(pathname, sp, day),
  };
}
