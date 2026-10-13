import type { Flow, FlowKind, FlowStep, FlowTurn } from '@/lib/queries/flows';
import type { FlowEdge, FlowLane, FlowNode } from '@/components/charts/agent-flow-layout';
import { groupColorIndex } from '../../../components/charts/agent-graph-layout';
import type { CostValue } from '../../../lib/cost';
import type { TokenTotals } from '../../../lib/queries/sqlutil';
import { paletteColor } from '../../../components/chart-palette';
import { formatCost, formatDuration, formatInt, formatTokens, formatUsageName } from '../../../components/format';
import { modelLabels } from '../../../lib/model-name';

/**
 * Pure data shaping of the Agent flows pages (brief docs/briefs/agent-flows-view.md, ADR-0020 amendment): list rows,
 * pagination hrefs, KPI tiles, facts, step rows, the one-lane flow chart and the stage / phase bars. The pages only
 * lay these out; everything here is unit-tested in test/views/flows/helpers.test.ts.
 */

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Flow key as the URL carries it (orchestration id, `workflow`, `seq-<run id>`); same rule as flows.ts FLOW_KEY_RE (kept here so this module stays free of server imports). */
export const FLOW_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export const FLOW_KIND_LABEL: Record<FlowKind, string> = {
  workflow: 'workflow',
  'legacy-workflow': 'workflow (legacy)',
  sequence: 'agent sequence',
};

/** Longest agent group the `group` list filter accepts (agent types are capped at 128 by the protocol). */
export const FLOW_GROUP_MAX = 128;

/** The `group` list filter from the search params: trimmed, 1..128 chars; null when absent or out of range. */
export function parseFlowGroup(sp: Params): string | null {
  const g = first(sp.group)?.trim() ?? '';
  return g.length > 0 && g.length <= FLOW_GROUP_MAX ? g : null;
}

/**
 * URL for the flows list: keeps the current search params (the agent `group` filter included), sets/clears page,
 * outcome and group (as turns' listHref). Changing outcome or group resets the page.
 */
export function flowsListHref(sp: Params, change: { page?: number | null; outcome?: string | null; group?: string | null; session?: string | null }): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = first(v);
    if (
      val !== undefined &&
      k !== 'page' &&
      !(k === 'outcome' && 'outcome' in change) &&
      !(k === 'group' && 'group' in change) &&
      !(k === 'session' && 'session' in change)
    )
      p.set(k, val);
  }
  if (change.outcome) p.set('outcome', change.outcome);
  if (change.group) p.set('group', change.group);
  if (change.session) p.set('session', change.session);
  if (change.page && change.page > 1) p.set('page', String(change.page));
  const s = p.toString();
  return s ? `/flows?${s}` : '/flows';
}

/**
 * Flow key from the route segment. Next may hand the segment over still percent-encoded, so it is decoded once
 * (a malformed escape -> null); null as well when it does not match FLOW_KEY_RE.
 */
export function parseFlowKey(raw: string | undefined): string | null {
  if (!raw) return null;
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return FLOW_KEY_RE.test(key) ? key : null;
}

/**
 * Pagination of the list. `pastEnd` when the page holds no rows although flows match (a page number beyond the last
 * page): the page then says so and links to the last page instead of claiming nothing matches.
 */
export function flowsPaging(page: number, pageSize: number, total: number, rowCount: number) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const pastEnd = rowCount === 0 && total > 0 && page > lastPage;
  return {
    first: (page - 1) * pageSize + 1,
    last: (page - 1) * pageSize + rowCount,
    lastPage,
    pastEnd,
    hasPrev: page > 1 && !pastEnd,
    hasNext: page * pageSize < total,
    emptyMessage: pastEnd
      ? `Page ${formatInt(page)} is past the last page (${formatInt(lastPage)}) of the ${formatInt(total)} matching flows.`
      : 'No multi-step agent flows match these filters. Widen the date range or clear a filter.',
  };
}

/** Element id of a flow's section on the turn page (`#flow-<key>`); keys are URL-safe (FLOW_KEY_RE), so no escaping. */
export const flowAnchor = (key: string): string => `flow-${key}`;

/**
 * Detail of a flow: its section on the turn page (ADR-0025: one page for a turn and its flows), `startedMs` helping
 * the aggregates-only lookup of the turn. The old `/flows/<turnId>/<key>` route redirects here.
 */
export function flowHref(f: Pick<Flow, 'turnId' | 'key'> & { turn: Pick<FlowTurn, 'startedMs'> }): string {
  const key = FLOW_KEY_RE.test(f.key) ? f.key : encodeURIComponent(f.key);
  return `/turns/${f.turnId}?startedMs=${f.turn.startedMs}#${flowAnchor(key)}`;
}

/** Detail page of a flagged flow (ADR-0024); the flag stores the turn id and key, the turn's start comes from the join. */
export function flaggedFlowHref(r: { turnId: string; key: string; turn: { startedMs: number } }): string {
  return flowHref({ turnId: r.turnId, key: r.key, turn: { startedMs: r.turn.startedMs } });
}

/** Turn detail page of the flow's turn. */
export function turnHref(t: Pick<FlowTurn, 'id' | 'startedMs'>): string {
  return `/turns/${t.id}?startedMs=${t.startedMs}`;
}

/** Printable report of the flow (`/report/flows/…`, "Download PDF"); same key encoding and `startedMs` as flowHref. */
export function reportHref(f: Pick<Flow, 'turnId' | 'key'> & { turn: Pick<FlowTurn, 'startedMs'> }): string {
  const key = FLOW_KEY_RE.test(f.key) ? f.key : encodeURIComponent(f.key);
  return `/report/flows/${f.turnId}/${key}?startedMs=${f.turn.startedMs}`;
}

export const projectLabel = (t: Pick<FlowTurn, 'projectId' | 'projectName'>): string =>
  t.projectName ?? (t.projectId ? 'unknown project' : 'no project');

/** Serializable DataTable rows of the flows list. */
export function toFlowTableRows(flows: Flow[]) {
  return flows.map((f) => ({
    id: f.id,
    href: flowHref(f),
    startedMs: f.startedMs,
    project: projectLabel(f.turn),
    name: f.name,
    kind: FLOW_KIND_LABEL[f.kind] ?? f.kind,
    steps: f.steps.length,
    stages: f.stages.length > 0 ? f.stages.join(' → ') : null,
    durationMs: f.durationMs,
    tokens: f.tokens.total,
    cost: f.cost,
    models: f.models.length > 0 ? friendlyModels(f.models) : null,
    outcome: f.outcome,
  }));
}

const plural = (n: number, word: string) => `${formatInt(n)} ${word}${n === 1 ? '' : 's'}`;
const tokenCount = (t: number | TokenTotals): number => (typeof t === 'number' ? t : t.total);

export interface Kpi {
  label: string;
  value: string;
  sub?: string;
  title?: string;
}

/** Headline tiles of the list: totals over every flow in the range (not only this page). */
export function flowKpis(totals: { flows: number; steps: number; tokens: number | TokenTotals; cost: CostValue }, truncated = false): Kpi[] {
  const avg = totals.flows > 0 ? totals.steps / totals.flows : 0;
  const cut = truncated ? ' (cut at the run cap)' : '';
  return [
    { label: 'Flows', value: formatInt(totals.flows), sub: `with 2 or more steps${cut}` },
    { label: 'Steps', value: formatInt(totals.steps), sub: totals.flows > 0 ? `${avg.toFixed(1)} per flow` : undefined },
    { label: 'Tokens', value: formatTokens(tokenCount(totals.tokens)), sub: 'all steps' },
    {
      label: '≈ Cost',
      value: formatCost(totals.cost),
      sub: 'at API list prices',
      title: "≈ per step at the run's model price on that day, summed",
    },
  ];
}

/** One line of the Facts card. `href` makes it a link; `kind: 'outcome'` renders the value as an outcome badge. */
export interface Fact {
  label: string;
  value: string;
  kind?: 'text' | 'outcome';
  href?: string;
  title?: string;
}

/** Friendly model names of a flow, one per id in order (so they pair with the efforts list), joined for display. */
function friendlyModels(ids: string[]): string {
  const names = modelLabels(ids);
  return ids.map((id) => names[id] ?? id).join(', ');
}

/** Facts the flow shares with its turn (project, harness, the turn itself): left out of the flow section on the turn page. */
const TURN_FACTS = new Set(['Project', 'Turn', 'Harness']);

/** Facts of a flow section on the turn page: flowFacts without the ones the turn's own Facts card already shows. */
export function flowSectionFacts(f: Flow): Fact[] {
  return flowFacts(f).filter((x) => !TURN_FACTS.has(x.label));
}

/** Facts of a flow, in display order (the report; the turn page uses flowSectionFacts). */
export function flowFacts(f: Flow): Fact[] {
  const models = f.models.length > 0 ? friendlyModels(f.models) : '—';
  const efforts = f.efforts.length > 0 ? f.efforts.join(', ') : '—';
  return [
    { label: 'Outcome', value: f.outcome, kind: 'outcome' },
    { label: 'Project', value: projectLabel(f.turn) },
    { label: 'Turn', value: f.turn.summary ?? 'open turn', href: turnHref(f.turn), title: 'The turn that ran this flow' },
    { label: 'Harness', value: f.turn.harness },
    { label: 'Kind', value: FLOW_KIND_LABEL[f.kind] ?? f.kind },
    { label: 'Started', value: formatClockDate(f.startedMs) },
    { label: 'Duration', value: formatDuration(f.durationMs), title: 'First step start to last step end' },
    { label: 'Steps', value: formatInt(f.steps.length) },
    { label: 'Stages', value: f.stages.length > 0 ? f.stages.join(' → ') : '—' },
    { label: 'Tokens', value: formatTokens(f.tokens.total) },
    { label: '≈ Cost (API list prices)', value: formatCost(f.cost) },
    { label: 'Models · efforts', value: `${models} · ${efforts}` },
  ];
}

/** "2026-10-08 12:03:04 UTC" (seconds matter for a flow's steps). */
export function formatClockDate(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** `name ×3` per skill (model + typed uses), most used first; null when none. */
export function skillsText(skills: FlowStep['skills']): string | null {
  const list = Object.entries(skills ?? {})
    .map(([name, c]) => [name, (c?.model ?? 0) + (c?.user ?? 0)] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return list.length > 0 ? list.map(([name, n]) => `${formatUsageName(name)} ×${n}`).join(', ') : null;
}

/** `server/tool ×3` per MCP tool, most called first; null when none. */
export function mcpText(mcp: FlowStep['mcp']): string | null {
  const list = Object.entries(mcp ?? {})
    .flatMap(([server, tools]) => Object.entries(tools ?? {}).map(([tool, n]) => [`${formatUsageName(server)}/${formatUsageName(tool)}`, n] as const))
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return list.length > 0 ? list.map(([k, n]) => `${k} ×${n}`).join(', ') : null;
}

/** One "Skills & MCP" summary: skills with typed / model split, and MCP calls per server (sorted, formatted). */
export interface UsesSummary {
  skills: string | null;
  mcp: { server: string; label: string; calls: string }[];
}

/** Summary of one set of skill uses / MCP calls (the flow's steps, or the turn's main agent). */
function summarizeUses(skillsIn: Flow['skills'] | undefined, mcpIn: Flow['mcp'] | undefined): UsesSummary {
  const skills = Object.entries(skillsIn ?? {})
    .filter(([, c]) => (c?.model ?? 0) + (c?.user ?? 0) > 0)
    .sort((a, b) => b[1].model + b[1].user - (a[1].model + a[1].user) || a[0].localeCompare(b[0]));
  const mcp = Object.entries(mcpIn ?? {})
    .map(([server, tools]) => {
      const calls = Object.entries(tools ?? {})
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { server, label: formatUsageName(server), calls: calls.map(([tool, n]) => `${formatUsageName(tool)} ×${n}`).join(', '), n: calls.length };
    })
    .filter((s) => s.n > 0)
    .sort((a, b) => a.server.localeCompare(b.server))
    .map(({ server, label, calls }) => ({ server, label, calls }));
  return {
    skills:
      skills.length > 0
        ? skills
            .map(([name, c]) => `${formatUsageName(name)}${c.user > 0 ? ` (typed ×${c.user})` : ''}${c.model > 0 ? ` (by the model ×${c.model})` : ''}`)
            .join(', ')
        : null,
    mcp,
  };
}

/** Skills & MCP card of the flow (like turn detail's): the steps' skill uses and MCP calls, summed. */
export function usesSummary(f: Pick<Flow, 'skills' | 'mcp'>): UsesSummary {
  return summarizeUses(f.skills, f.mcp);
}

/**
 * The same summary for the turn's MAIN agent alone (FlowTurn.skills / mcp: the turn row without its runs), so the
 * reader sees what the turn used even when its sub-agents used nothing. Both null on the list path or in limited
 * form: then `available` is false and nothing is known (not "none").
 */
export function turnUsesSummary(t: Pick<FlowTurn, 'skills' | 'mcp'>): UsesSummary & { available: boolean } {
  const available = t.skills !== null && t.skills !== undefined && t.mcp !== null && t.mcp !== undefined;
  return { ...summarizeUses(t.skills, t.mcp), available };
}

/** One segment of a server-rendered 100 % bar (the printable report): its share of the row and its colour. */
export interface BarSegment {
  key: string;
  value: number;
  /** 0..1 of the row's total; segments of a row sum to 1 (0 when the row is empty). */
  share: number;
  /** Light-theme colour, as StackedBar100 picks it: `colorIndex` first, else the named colour or the key's position. */
  color: string;
}

/**
 * Segments of one 100 % bar row for `keys` in order, skipping zero / missing values: the same colour rule as
 * StackedBar100 (a `colorIndex` entry wins, null = grey "other"; otherwise a named colour such as a phase, else the
 * palette colour of the key's position). Pure, so the report's bars print without Recharts.
 */
export function barSegments(values: Record<string, number>, keys: string[], colorIndex?: Record<string, number | null>): BarSegment[] {
  const present = keys.map((key, i) => ({ key, i, value: values[key] ?? 0 })).filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = present.reduce((a, s) => a + s.value, 0);
  return present.map(({ key, i, value }) => {
    const ci = colorIndex && key in colorIndex ? colorIndex[key] : undefined;
    const color = ci === undefined ? paletteColor(false, i, key) : paletteColor(false, ci, ci === null ? 'other' : undefined);
    return { key, value, share: total > 0 ? value / total : 0, color };
  });
}

/** Serializable DataTable rows of the steps table, in the flow's step order. */
export function toStepRows(f: Pick<Flow, 'steps'>) {
  return f.steps.map((s, i) => ({
    id: s.runId,
    n: i + 1,
    stage: s.stageName,
    label: s.label,
    group: s.group,
    model: s.model,
    effort: s.effort,
    startedMs: s.startedMs,
    offsetMs: s.offsetMs,
    durationMs: s.durationMs,
    tokens: s.tokens.total,
    cost: s.cost,
    skills: skillsText(s.skills),
    mcp: mcpText(s.mcp),
    outcome: s.outcome,
  }));
}

/** Characters of a step's label kept in chart axis labels (the axis is right-aligned, so longer ones lose their start). */
export const STEP_LABEL_CHARS = 20;
/** Width (px) of the "Phases per step" label column; fits `#nn ` + STEP_LABEL_CHARS + `…` at 12 px. */
export const STEP_LABEL_WIDTH = 170;

/** Label of a step in charts: `#n label`, cut to STEP_LABEL_CHARS with `…`; unique within the flow (bars are keyed by label). */
const stepLabel = (s: FlowStep, i: number) =>
  `#${i + 1} ${s.label.length > STEP_LABEL_CHARS ? `${s.label.slice(0, STEP_LABEL_CHARS - 1).trimEnd()}…` : s.label}`;

const UNSTAGED = 'unstaged';

/** Row of a step in `stages` (FlowStep.stageIndex is dense); null when it lies outside every stage. */
function stageRow(s: Pick<FlowStep, 'stageIndex'>, stages: string[]): number | null {
  const i = s.stageIndex;
  return i !== null && Number.isInteger(i) && i >= 0 && i < stages.length ? i : null;
}

/** Most common agent group of `steps` (ties: the earliest step in flow order); null when there are none. */
function mainGroup(steps: Pick<FlowStep, 'group'>[]): string | null {
  const counts = new Map<string, number>();
  for (const s of steps) counts.set(s.group, (counts.get(s.group) ?? 0) + 1);
  let best: string | null = null;
  for (const [g, n] of counts) if (best === null || n > counts.get(best)!) best = g;
  return best;
}

/**
 * Agent groups ranked for their colours (AgentFlow `groupOrder`): the main group of each stage in stage order, then
 * that of the unstaged steps. The flow chart colours a step by its group, so with this ranking stage i's main group
 * gets palette colour i, and stageBar can give each stage the colour of its steps in the chart.
 */
export function flowGroupOrder(f: Pick<Flow, 'stages' | 'steps'>): string[] {
  const order: string[] = [];
  const push = (g: string | null) => {
    if (g !== null && !order.includes(g)) order.push(g);
  };
  f.stages.forEach((_, i) => push(mainGroup(f.steps.filter((s) => stageRow(s, f.stages) === i))));
  push(mainGroup(f.steps.filter((s) => stageRow(s, f.stages) === null)));
  return order;
}

/**
 * Time by stage as one StackedBar100 row: summed step durations per stage (stage order), plus `unstaged` for steps
 * outside every stage. `colorIndex` gives each key the palette index the Agent flow card uses for that stage's main
 * group (same flowGroupOrder ranking, same groupColorIndex), so a stage has one colour on the page. null unless the
 * flow has more than one stage and some time to show.
 */
export function stageBar(
  f: Pick<Flow, 'stages' | 'steps'>,
): { keys: string[]; values: Record<string, number>; colorIndex: Record<string, number | null> } | null {
  if (f.stages.length <= 1) return null;
  const values = new Map<string, number>(f.stages.map((s) => [s, 0]));
  const members = new Map<string, FlowStep[]>();
  for (const s of f.steps) {
    const i = stageRow(s, f.stages);
    const k = i === null ? UNSTAGED : f.stages[i]!;
    values.set(k, (values.get(k) ?? 0) + Math.max(0, s.durationMs));
    members.set(k, [...(members.get(k) ?? []), s]);
  }
  const keys = [...values.keys()].filter((k) => values.get(k)! > 0);
  if (keys.length === 0) return null;
  const groupIdx = groupColorIndex(
    f.steps.map((s) => s.group),
    flowGroupOrder(f),
  );
  const colorIndex = Object.fromEntries(
    keys.map((k) => {
      const g = mainGroup(members.get(k) ?? []);
      return [k, g === null ? null : (groupIdx.get(g) ?? null)];
    }),
  );
  return { keys, values: Object.fromEntries(keys.map((k) => [k, values.get(k)!])), colorIndex };
}

/**
 * Phases per step as StackedBar100 rows (one per step with phase data); keys are the phases present, by total
 * time descending. null when no step has phases.
 */
export function stepPhaseBars(f: Pick<Flow, 'steps'>): { keys: string[]; rows: { label: string; values: Record<string, number> }[] } | null {
  const totals = new Map<string, number>();
  const rows: { label: string; values: Record<string, number> }[] = [];
  f.steps.forEach((s, i) => {
    const entries = Object.entries(s.phasesMs ?? {}).filter(([, v]) => typeof v === 'number' && v > 0);
    if (entries.length === 0) return;
    for (const [k, v] of entries) totals.set(k, (totals.get(k) ?? 0) + v);
    rows.push({ label: stepLabel(s, i), values: Object.fromEntries(entries) });
  });
  if (rows.length === 0) return null;
  const keys = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  return { keys, rows };
}

/** AgentFlow props (without the aria label) for one flow. */
export interface FlowChart {
  lanes: FlowLane[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  fromMs: number;
  toMs: number;
  /** flowGroupOrder: stage i's main group gets colour i, as in the Time by stage bar. */
  groupOrder: string[];
}

/**
 * The flow as an Agent flow chart (ADR-0020): one lane named after the flow whose rows are its
 * stages, nodes = steps (a step without a stage goes to the "unstaged" row), edges = the
 * flow's links between its steps, deduplicated. The axis is the flow padded by 2% on each side (at least a second).
 * Nodes do not link anywhere (the page is already the flow's turn).
 */
export function flowChart(f: Pick<Flow, 'name' | 'stages' | 'steps' | 'links' | 'startedMs' | 'endedMs'> & { turn: Pick<FlowTurn, 'projectId' | 'projectName' | 'harness'> }): FlowChart {
  const laneId = 'flow';
  const nodes: FlowNode[] = f.steps.map((s) => ({
    id: s.runId,
    laneId,
    label: s.label,
    group: s.group,
    stageIndex: stageRow(s, f.stages),
    startMs: s.startedMs,
    endMs: s.endedMs,
    outcome: s.outcome,
    model: s.model,
    href: null,
  }));
  const drawn = new Set(nodes.map((n) => n.id));
  const seen = new Set<string>();
  const edges: FlowEdge[] = [];
  for (const l of f.links) {
    if (l.fromRunId === l.toRunId || !drawn.has(l.fromRunId) || !drawn.has(l.toRunId)) continue;
    const k = `${l.fromRunId}\u0000${l.toRunId}\u0000${l.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ fromId: l.fromRunId, toId: l.toRunId, kind: l.kind });
  }
  const startMs = Math.min(f.startedMs, ...f.steps.map((s) => s.startedMs));
  const endMs = Math.max(f.endedMs, ...f.steps.map((s) => s.endedMs));
  const pad = Math.max(1000, Math.round((endMs - startMs) * 0.02));
  return {
    lanes: [{ id: laneId, label: f.name, sublabel: `${projectLabel(f.turn)} · ${f.turn.harness}`, stages: [...f.stages] }],
    nodes,
    edges,
    fromMs: startMs - pad,
    toMs: endMs + pad,
    groupOrder: flowGroupOrder(f),
  };
}

/** Description of the Flow card: workflows are drawn one row per stage, sequences on one row. */
export function flowChartDescription(f: Pick<Flow, 'kind' | 'stages'>): string {
  const rows =
    f.stages.length > 0
      ? 'one row per stage. A solid arrow links the stages of one item; a dashed arrow links an agent to the sibling that finished before it started.'
      : f.kind === 'sequence'
        ? 'on one row. A dashed arrow links an agent to the sibling that finished before it started; a solid arrow is a stored hand-over.'
        : 'on one row (no stages are known for this workflow).';
  return `The flow's steps in time, ${rows} Hover a step to follow its chain. Times are UTC.`;
}
