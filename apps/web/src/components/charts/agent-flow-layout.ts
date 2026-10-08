/**
 * Pure layout for the agent flow chart (ADR-0020): lanes of stage rows, sub-rows for runs that overlap in time, pill
 * and edge geometry, the chain highlighted on hover and link counts. React-free so it is unit-tested in
 * test/shell/agent-flow-layout.test.ts; AgentFlow.tsx only draws. Time scale, ticks, clock format, spans and group
 * colours come from agent-graph-layout.ts so both charts read alike.
 */
import { allocateSubRows, type GraphRun, type GraphTurn, type TimeScale, spanX } from './agent-graph-layout';

export interface FlowLane {
  id: string;
  label: string;
  sublabel: string | null;
  /** stage names by index; [] when the lane has no stages */
  stages: string[];
}
export interface FlowNode {
  id: string;
  laneId: string;
  label: string;
  group: string;
  stageIndex: number | null;
  startMs: number;
  endMs: number;
  outcome: string;
  model: string | null;
  href: string | null;
}
export interface FlowEdge {
  fromId: string;
  toId: string;
  kind: 'item' | 'sequence';
}

export interface FlowLayoutOptions {
  /** Space above the first lane (the time axis). */
  top: number;
  /** Height of a stage row with one sub-row. */
  rowH: number;
  /** Height each extra sub-row adds to its stage row. */
  subRowH: number;
  /** Vertical space between two lanes. */
  laneGap: number;
  /** Least lane height when the lane has a sublabel (two gutter lines). */
  labelMinH: number;
  /** Most sub-rows per stage row; the rest share one extra overflow sub-row. */
  maxSubRows: number;
  /** Least time a node holds its sub-row (the pixel width of a short pill, in ms at the current zoom). */
  minSpanMs: number;
}
export const FLOW_LAYOUT_DEFAULTS: FlowLayoutOptions = {
  top: 28,
  rowH: 22,
  subRowH: 20,
  laneGap: 10,
  labelMinH: 32,
  maxSubRows: Number.POSITIVE_INFINITY,
  minSpanMs: 0,
};

/** Pill geometry (px). */
export const PILL_H = 14;
export const PILL_RX = 7;
export const MIN_PILL_W = 6;
/** Label of the row that collects nodes without a stage in a lane that has stages. */
export const UNSTAGED_LABEL = 'unstaged';

// ---------------------------------------------------------------------------------------------------------------
// Rows and sub-rows

/**
 * Stage row of a node inside its lane: its stage index when the lane has that stage, else the lane's last row
 * ("unstaged", index = stages.length). A lane without stages has the single row 0.
 */
export function stageRowOf(node: Pick<FlowNode, 'stageIndex'>, lane: Pick<FlowLane, 'stages'>): number {
  const n = lane.stages.length;
  if (n === 0) return 0;
  const s = node.stageIndex;
  return s !== null && Number.isInteger(s) && s >= 0 && s < n ? s : n;
}

export interface FlowPlacement {
  laneId: string;
  /** Stage row inside the lane (see stageRowOf). */
  row: number;
  /** Sub-row inside the stage row (0 = first); the overflow sub-row is `maxSubRows`. */
  subRow: number;
}
export interface FlowRowAllocation {
  /** Placement of each node whose lane is known. */
  placement: Map<string, FlowPlacement>;
  /** Sub-rows per stage row of each lane (index = row; at least 1, overflow included). */
  rowSubRows: Map<string, number[]>;
  /** Whether each lane shows an "unstaged" row (it has stages and nodes without a known stage). */
  unstaged: Map<string, boolean>;
  /** Nodes on the overflow sub-row, per `${laneId}\u0000${row}` (rows without overflow absent). */
  overflow: Map<string, string[]>;
}

const rowKey = (laneId: string, row: number) => `${laneId}\u0000${row}`;

/**
 * Rows per lane: one per stage (empty stages keep their row so a pipeline reads in order), plus an "unstaged" row when
 * the lane has stages and some node has none; a lane without stages has one row. Inside a row, nodes that overlap in
 * time take sub-rows by interval scheduling (allocateSubRows from the graph: by start, then id; a node holds its
 * sub-row for at least `minSpanMs`). Nodes of unknown lanes are not placed.
 */
export function assignFlowRows(lanes: FlowLane[], nodes: FlowNode[], opts: Partial<Pick<FlowLayoutOptions, 'maxSubRows' | 'minSpanMs'>> = {}): FlowRowAllocation {
  const laneById = new Map(lanes.map((l) => [l.id, l]));
  // Each (lane, row) is a pseudo lane of the graph's allocator, so the interval scheduling is shared, not copied.
  const turns = new Map<string, GraphTurn>();
  const runs: GraphRun[] = [];
  const rowOfNode = new Map<string, { laneId: string; row: number }>();
  const unstaged = new Map<string, boolean>(lanes.map((l) => [l.id, false]));
  for (const node of nodes) {
    const lane = laneById.get(node.laneId);
    if (!lane) continue;
    const row = stageRowOf(node, lane);
    if (lane.stages.length > 0 && row === lane.stages.length) unstaged.set(lane.id, true);
    const key = rowKey(lane.id, row);
    if (!turns.has(key)) turns.set(key, { id: key, laneId: key, label: key, href: null, startMs: 0, endMs: 0, outcome: 'success' });
    rowOfNode.set(node.id, { laneId: lane.id, row });
    runs.push({ id: node.id, turnId: key, parentRunId: null, label: node.label, group: node.group, depth: 0, startMs: node.startMs, endMs: Math.max(node.endMs, node.startMs), outcome: node.outcome, model: node.model });
  }
  const alloc = allocateSubRows(runs, turns, opts);
  const placement = new Map<string, FlowPlacement>();
  for (const [id, { laneId, row }] of rowOfNode) placement.set(id, { laneId, row, subRow: alloc.subRowOf.get(id) ?? 0 });
  const rowSubRows = new Map<string, number[]>();
  for (const lane of lanes) {
    const rows = lane.stages.length === 0 ? 1 : lane.stages.length + (unstaged.get(lane.id) ? 1 : 0);
    rowSubRows.set(
      lane.id,
      Array.from({ length: rows }, (_, r) => Math.max(1, alloc.laneSubRows.get(rowKey(lane.id, r)) ?? 0)),
    );
  }
  return { placement, rowSubRows, unstaged, overflow: alloc.overflow };
}

// ---------------------------------------------------------------------------------------------------------------
// Lane boxes

export interface FlowRowBox {
  /** Stage index, or stages.length for the unstaged row (0 for a lane without stages). */
  index: number;
  /** Stage name, UNSTAGED_LABEL, or null for the single row of a lane without stages. */
  label: string | null;
  unstaged: boolean;
  top: number;
  height: number;
  subRows: number;
  /** Nodes sharing the overflow sub-row. */
  overflow: number;
}
export interface FlowLaneBox {
  id: string;
  top: number;
  height: number;
  rows: FlowRowBox[];
}
export interface FlowLayout extends FlowRowAllocation {
  opts: FlowLayoutOptions;
  lanes: FlowLaneBox[];
  laneById: Map<string, FlowLaneBox>;
  /** Total height of axis + lanes + gaps (no bottom padding). */
  height: number;
}

/** Height of a stage row with `subRows` sub-rows: the first takes rowH, each further one subRowH. */
export const rowHeight = (subRows: number, opts: Pick<FlowLayoutOptions, 'rowH' | 'subRowH'> = FLOW_LAYOUT_DEFAULTS): number =>
  opts.rowH + Math.max(0, subRows - 1) * opts.subRowH;

/** Stacks lanes under the axis, `laneGap` apart; each lane is its stage rows (at least `labelMinH` with a sublabel). */
export function flowLayout(lanes: FlowLane[], nodes: FlowNode[], partial: Partial<FlowLayoutOptions> = {}): FlowLayout {
  const opts: FlowLayoutOptions = { ...FLOW_LAYOUT_DEFAULTS, ...partial };
  const alloc = assignFlowRows(lanes, nodes, opts);
  const boxes: FlowLaneBox[] = [];
  const laneById = new Map<string, FlowLaneBox>();
  let y = opts.top;
  lanes.forEach((lane, i) => {
    if (i > 0) y += opts.laneGap;
    const subRows = alloc.rowSubRows.get(lane.id) ?? [1];
    const rows: FlowRowBox[] = [];
    let ry = y;
    subRows.forEach((n, r) => {
      const unstagedRow = lane.stages.length > 0 && r === lane.stages.length;
      const label = lane.stages.length === 0 ? null : unstagedRow ? UNSTAGED_LABEL : (lane.stages[r] ?? null);
      const h = rowHeight(n, opts);
      rows.push({ index: r, label, unstaged: unstagedRow, top: ry, height: h, subRows: n, overflow: alloc.overflow.get(rowKey(lane.id, r))?.length ?? 0 });
      ry += h;
    });
    const height = Math.max(ry - y, lane.sublabel ? opts.labelMinH : 0);
    const box: FlowLaneBox = { id: lane.id, top: y, height, rows };
    boxes.push(box);
    laneById.set(lane.id, box);
    y += height;
  });
  return { ...alloc, opts, lanes: boxes, laneById, height: y };
}

/** Centre y of a node's pill, or null when the node was not placed (unknown lane). */
export function nodeY(nodeId: string, layout: FlowLayout): number | null {
  const p = layout.placement.get(nodeId);
  const row = p ? layout.laneById.get(p.laneId)?.rows[p.row] : undefined;
  if (!p || !row) return null;
  return row.top + layout.opts.rowH / 2 + p.subRow * layout.opts.subRowH;
}

export interface NodeGeometry {
  x1: number;
  x2: number;
  y: number;
}

/** Pill of a node: x from start to end (clipped to the plot, at least `minWidth`), y its sub-row centre. null when off-window or unplaced. */
export function nodeGeometry(node: Pick<FlowNode, 'id' | 'startMs' | 'endMs'>, layout: FlowLayout, scale: TimeScale, minWidth = MIN_PILL_W): NodeGeometry | null {
  const y = nodeY(node.id, layout);
  const sx = spanX(node.startMs, node.endMs, scale, minWidth);
  if (y === null || !sx) return null;
  return { x1: sx.x1, x2: sx.x2, y };
}

// ---------------------------------------------------------------------------------------------------------------
// Edges

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Cubic edge from the source's end (x1, y1) to the target's start (x2, y2): horizontal tangents at both ends, pulled
 * out by half the horizontal distance (at least `minPull` px, so a target that starts before its source ended — an
 * item chain whose agents overlap — curves out and back instead of folding into a vertical stroke).
 */
export function edgePath(x1: number, y1: number, x2: number, y2: number, minPull = 16): string {
  const pull = Math.max(minPull, Math.abs(x2 - x1) / 2);
  return `M${r1(x1)},${r1(y1)}C${r1(x1 + pull)},${r1(y1)} ${r1(x2 - pull)},${r1(y2)} ${r1(x2)},${r1(y2)}`;
}

/** Stable key of an edge (React key, highlight sets). */
export const edgeKey = (e: FlowEdge): string => `${e.fromId}->${e.toId}:${e.kind}`;

export interface Chain {
  nodes: Set<string>;
  /** Edge keys (edgeKey). */
  edges: Set<string>;
}

function walk(start: string, adj: Map<string, FlowEdge[]>, next: (e: FlowEdge) => string, out: Chain): void {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.nodes.add(id);
    for (const e of adj.get(id) ?? []) {
      out.edges.add(edgeKey(e));
      const n = next(e);
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
}

function adjacency(edges: FlowEdge[]) {
  const outs = new Map<string, FlowEdge[]>();
  const ins = new Map<string, FlowEdge[]>();
  for (const e of edges) {
    const o = outs.get(e.fromId);
    if (o) o.push(e);
    else outs.set(e.fromId, [e]);
    const i = ins.get(e.toId);
    if (i) i.push(e);
    else ins.set(e.toId, [e]);
  }
  return { outs, ins };
}

/**
 * The chain through a node: everything upstream (transitively along incoming edges) and downstream (along outgoing
 * edges), with the edges walked. Siblings that only share an ancestor are not included. Cycles are safe.
 */
export function chain(nodeId: string, edges: FlowEdge[]): Chain {
  const { outs, ins } = adjacency(edges);
  const out: Chain = { nodes: new Set(), edges: new Set() };
  walk(nodeId, ins, (e) => e.fromId, out);
  walk(nodeId, outs, (e) => e.toId, out);
  return out;
}

/** The chain through an edge: upstream of its source, the edge, and downstream of its target. */
export function edgeChain(edge: FlowEdge, edges: FlowEdge[]): Chain {
  const { outs, ins } = adjacency(edges);
  const out: Chain = { nodes: new Set(), edges: new Set([edgeKey(edge)]) };
  walk(edge.fromId, ins, (e) => e.fromId, out);
  walk(edge.toId, outs, (e) => e.toId, out);
  return out;
}

/** Incoming / outgoing link count of every node that has links (a duplicated edge counts once). */
export function linkCounts(edges: FlowEdge[]): Map<string, { in: number; out: number }> {
  const out = new Map<string, { in: number; out: number }>();
  const get = (id: string) => {
    let c = out.get(id);
    if (!c) out.set(id, (c = { in: 0, out: 0 }));
    return c;
  };
  const seen = new Set<string>();
  for (const e of edges) {
    const k = edgeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    get(e.fromId).out += 1;
    get(e.toId).in += 1;
  }
  return out;
}

/**
 * Label as it fits inside a pill `widthPx` wide (estimated `charPx` per character, `padPx` padding on each side):
 * whole, cut with an ellipsis, or null when fewer than 3 characters plus the ellipsis would fit.
 */
export function fitLabel(label: string, widthPx: number, charPx = 6, padPx = 5): string | null {
  const max = Math.floor((widthPx - 2 * padPx) / charPx);
  if (label.length <= max) return label.length > 0 ? label : null;
  if (max < 4) return null;
  return `${label.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------------------------------------------
// Labels and tooltip

/**
 * The visible part of a pill inside the plot [plotX1, plotX2], where its label goes: a pill that starts before the
 * window overhangs the plot's left edge (spanX) and is clipped there, so a label drawn from its x1 would lose its start.
 * Edges keep using the unclipped x1 / x2.
 */
export function visibleSpan(g: Pick<NodeGeometry, 'x1' | 'x2'>, plotX1: number, plotX2: number): { x: number; width: number } {
  const x1 = Math.max(g.x1, plotX1);
  const x2 = Math.min(g.x2, plotX2);
  return { x: x1, width: Math.max(0, x2 - x1) };
}

/**
 * Top-left of a tooltip `size` big for a cursor at `cursor` (both in viewport px): below-right of the cursor by `gap`,
 * flipped above / to the left when it would cross the viewport's bottom / right edge, then kept `margin` px inside it.
 */
export function tooltipPosition(
  cursor: { x: number; y: number },
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  gap = 12,
  margin = 4,
): { left: number; top: number } {
  const place = (c: number, s: number, v: number) => {
    const after = c + gap;
    const p = after + s > v - margin ? c - gap - s : after;
    return Math.max(margin, Math.min(p, v - margin - s));
  };
  return { left: place(cursor.x, size.w, viewport.w), top: place(cursor.y, size.h, viewport.h) };
}
