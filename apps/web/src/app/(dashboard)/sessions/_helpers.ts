import type { AgentGraphProps } from '@/components/charts/AgentGraph';
import { agentRunLabel } from '../../../lib/queries/agent-groups';
import type { Outcomes } from '../../../lib/queries/sqlutil';
import type { SessionDetail, SessionRow } from '../../../lib/queries/sessions';
import { flowHref, turnHref } from '../flows/_helpers';

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Detail page of a session (ADR-0026). */
export const sessionHref = (id: string): string => `/sessions/${id}`;

/** The turns / flows lists narrowed to one session (`?session=`). */
export const sessionTurnsHref = (id: string): string => `/turns?session=${id}`;
export const sessionFlowsHref = (id: string): string => `/flows?session=${id}`;

/** Page number (>= 1) from the URL; invalid values fall back to 1. */
export function parseSessionPage(sp: Params): number {
  const p = Number.parseInt(first(sp.page) ?? '', 10);
  return Number.isFinite(p) && p >= 1 && p <= 100_000 ? p : 1;
}

/** URL for the sessions list: keeps the current search params, sets / clears the page. */
export function sessionsListHref(sp: Params, change: { page?: number | null }): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = first(v);
    if (val !== undefined && k !== 'page') p.set(k, val);
  }
  if (change.page && change.page > 1) p.set('page', String(change.page));
  const s = p.toString();
  return s ? `/sessions?${s}` : '/sessions';
}

/** "4 success · 1 failed · 2 unknown": the non-zero outcome counts, in a fixed order; "—" when there are none. */
export function outcomeMix(o: Outcomes): string {
  const parts = (['success', 'failed', 'abandoned', 'unknown'] as const).filter((k) => o[k] > 0).map((k) => `${o[k]} ${k}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** Serializable DataTable rows of the sessions list (no user fields unless the row carries them). */
export function toSessionTableRows(rows: SessionRow[]) {
  return rows.map((r) => ({
    id: r.id,
    href: sessionHref(r.id),
    title: r.open ? `${r.title} (open)` : r.title,
    startedMs: r.startedMs,
    user: r.userName ?? (r.userId ? 'former member' : null),
    project: r.projectName ?? (r.projectId ? 'unknown project' : null),
    harness: r.harness,
    spanMs: r.spanMs,
    turns: r.turns,
    runs: r.runs,
    workflows: r.workflows,
    flows: r.flows,
    tokens: r.tokens.total,
    cost: r.cost,
    outcomes: outcomeMix(r.outcomes),
  }));
}

/**
 * The whole session as a one-lane agent graph (the ADR-0019 component): its turns are the trunk, their runs branch off
 * it. The axis is the session span padded by 2% on each side (at least a second), not clipped to a UTC day.
 */
export function sessionGraph(d: Pick<SessionDetail, 'session' | 'turns' | 'runs' | 'flows'>): Omit<AgentGraphProps, 'onZoom'> {
  const { session } = d;
  const first = Math.min(session.startedMs, ...d.turns.map((t) => t.startedMs), ...d.runs.map((r) => r.startedMs));
  const last = Math.max(session.lastActivityMs, ...d.turns.map((t) => t.endedMs), ...d.runs.map((r) => r.endedMs));
  const pad = Math.max(1000, Math.round((last - first) * 0.02));
  const project = session.projectName ?? (session.projectId ? 'unknown project' : 'no project');
  const turnById = new Map(d.turns.map((t) => [t.id, t]));
  const flowOfRun = new Map<string, (typeof d.flows)[number]>();
  for (const f of d.flows) for (const s of f.steps) flowOfRun.set(s.runId, f);
  const runs = d.runs.filter((r) => turnById.has(r.turnId));
  return {
    lanes: [{ id: 'session', label: project, sublabel: session.harness, colorIndex: 0 }],
    turns: d.turns.map((t) => ({
      id: t.id,
      laneId: 'session',
      label: t.summary ?? 'turn',
      href: turnHref(t),
      startMs: t.startedMs,
      endMs: Math.max(t.endedMs, t.startedMs + t.durationMs),
      outcome: t.outcome,
    })),
    runs: runs.map((r) => {
      const f = flowOfRun.get(r.id);
      return {
        id: r.id,
        turnId: r.turnId,
        parentRunId: r.parentRunId,
        label: agentRunLabel(r.agentType),
        group: r.agentGroup,
        depth: r.depth,
        startMs: r.startedMs,
        endMs: r.endedMs,
        outcome: r.outcome,
        model: r.model,
        href: f ? flowHref(f) : turnHref(turnById.get(r.turnId)!),
      };
    }),
    fromMs: first - pad,
    toMs: last + pad,
    projectLegend: [{ label: project, colorIndex: 0 }],
    ariaLabel: `Session timeline: ${d.turns.length} turn${d.turns.length === 1 ? '' : 's'} and ${runs.length} sub-agent run${runs.length === 1 ? '' : 's'}`,
  };
}
