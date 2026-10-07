/**
 * Pure layout for the agent git-graph timeline (ADR-0019): lanes, sub-rows, scales, ticks and paths.
 * React-free so it is unit-tested in test/shell/agent-graph-layout.test.ts; AgentGraph.tsx only draws.
 */
import { formatDuration } from '../format';

export interface GraphLane {
  id: string;
  label: string;
  sublabel: string | null;
  /** Index into the chart palette (the lane's project colour). */
  colorIndex: number;
}
export interface GraphTurn {
  id: string;
  laneId: string;
  label: string;
  href: string | null;
  startMs: number;
  endMs: number;
  outcome: string;
}
export interface GraphRun {
  id: string;
  turnId: string;
  parentRunId: string | null;
  label: string;
  group: string;
  depth: number;
  startMs: number;
  endMs: number;
  outcome: string;
  model: string | null;
}

export interface LayoutOptions {
  /** Height of the trunk row (turn segments). */
  trunkRow: number;
  /** Height of one branch sub-row. */
  subRow: number;
  /** Space above the first lane (the time axis). */
  top: number;
  /**
   * Most sub-rows a lane gets; runs that find no free row among them share one extra overflow row (drawn with a
   * "+N" marker), so a burst of parallel runs does not make the lane hundreds of pixels tall.
   */
  maxSubRows: number;
  /**
   * Least time a run occupies its sub-row (the pixel width of a short run, in ms at the current zoom), so rows are
   * reused only once the previous occupant has ended on screen, not just in time.
   */
  minSpanMs: number;
}
export const LAYOUT_DEFAULTS: LayoutOptions = { trunkRow: 28, subRow: 18, top: 28, maxSubRows: 6, minSpanMs: 0 };

/**
 * URL params of the timeline window inside the day (`HH:MM`, UTC). parseTimelineWindow (TIMELINE_PARAMS in
 * lib/queries/agent-timeline.ts) reads the same names; `from` / `to` are the filter bar's custom date range.
 */
export const TIMELINE_WINDOW_PARAMS = { from: 'fromH', to: 'toH' } as const;
export interface TimelineParamNames {
  from: string;
  to: string;
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------
// Sub-rows

export interface SubRowAllocation {
  /** Sub-row (0 = first row under the trunk) of each run whose turn is known; the overflow row is `maxSubRows`. */
  subRowOf: Map<string, number>;
  /** Number of sub-rows each lane needs, overflow row included (lanes without runs are absent). */
  laneSubRows: Map<string, number>;
  /** Lane of each placed run. */
  laneOfRun: Map<string, string>;
  /** Runs of each lane that found no free sub-row and share the lane's overflow row (lanes without overflow absent). */
  overflow: Map<string, string[]>;
}

const byStart = (a: GraphRun, b: GraphRun) => a.startMs - b.startMs || a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Interval scheduling per lane: runs sorted by start, then depth (a parent before its children that start with it),
 * then id; each takes the lowest sub-row whose previous occupant ended at or before its start (an occupant holds its
 * row for at least `minSpanMs`). A run that finds none of the `maxSubRows` rows free goes to the lane's shared
 * overflow row. Runs whose turn is not in `turnsById` (cut by the row cap) are not placed.
 */
export function allocateSubRows(
  runs: GraphRun[],
  turnsById: Map<string, GraphTurn>,
  opts: Partial<Pick<LayoutOptions, 'maxSubRows' | 'minSpanMs'>> = {},
): SubRowAllocation {
  const maxRows = Math.max(1, opts.maxSubRows ?? Number.POSITIVE_INFINITY);
  const minSpan = Math.max(0, opts.minSpanMs ?? 0);
  const sorted = [...runs].sort(byStart);
  const rowEnds = new Map<string, number[]>(); // laneId -> end ms of the last occupant of each sub-row
  const subRowOf = new Map<string, number>();
  const laneOfRun = new Map<string, string>();
  const overflow = new Map<string, string[]>();
  for (const run of sorted) {
    const laneId = turnsById.get(run.turnId)?.laneId;
    if (laneId === undefined) continue;
    let ends = rowEnds.get(laneId);
    if (!ends) rowEnds.set(laneId, (ends = []));
    let row = ends.findIndex((end) => end <= run.startMs);
    if (row === -1 && ends.length < maxRows) row = ends.length;
    if (row === -1) {
      row = maxRows;
      const list = overflow.get(laneId);
      if (list) list.push(run.id);
      else overflow.set(laneId, [run.id]);
    } else {
      ends[row] = Math.max(run.endMs, run.startMs + minSpan);
    }
    subRowOf.set(run.id, row);
    laneOfRun.set(run.id, laneId);
  }
  const laneSubRows = new Map<string, number>();
  for (const [laneId, ends] of rowEnds) laneSubRows.set(laneId, ends.length + (overflow.has(laneId) ? 1 : 0));
  return { subRowOf, laneSubRows, laneOfRun, overflow };
}

/**
 * Background tail of each turn: the latest end of its runs when that is after the turn's own end (workflow agents run
 * in the background and outlive the turn that launched them). Turns without such runs are absent.
 */
export function backgroundEnds(turns: GraphTurn[], runs: GraphRun[]): Map<string, number> {
  const ends = new Map(turns.map((t) => [t.id, t.endMs]));
  const out = new Map<string, number>();
  for (const r of runs) {
    const turnEnd = ends.get(r.turnId);
    if (turnEnd === undefined || r.endMs <= turnEnd) continue;
    out.set(r.turnId, Math.max(out.get(r.turnId) ?? 0, r.endMs));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Lanes

export interface LaneBox {
  id: string;
  /** y of the lane's top edge. */
  top: number;
  /** y of the trunk's centre line. */
  trunkY: number;
  height: number;
  subRows: number;
}
export interface GraphLayout extends SubRowAllocation {
  opts: LayoutOptions;
  lanes: LaneBox[];
  laneById: Map<string, LaneBox>;
  /** Total SVG height (axis + all lanes). */
  height: number;
}

/** Stacks the lanes under the axis: each lane is a trunk row plus its sub-rows. */
export function laneLayout(lanes: GraphLane[], turns: GraphTurn[], runs: GraphRun[], opts: LayoutOptions = LAYOUT_DEFAULTS): GraphLayout {
  const turnsById = new Map(turns.map((t) => [t.id, t]));
  const alloc = allocateSubRows(runs, turnsById, opts);
  const boxes: LaneBox[] = [];
  const laneById = new Map<string, LaneBox>();
  let y = opts.top;
  for (const lane of lanes) {
    const subRows = alloc.laneSubRows.get(lane.id) ?? 0;
    const height = opts.trunkRow + subRows * opts.subRow;
    const box: LaneBox = { id: lane.id, top: y, trunkY: y + opts.trunkRow / 2, height, subRows };
    boxes.push(box);
    laneById.set(lane.id, box);
    y += height;
  }
  return { ...alloc, opts, lanes: boxes, laneById, height: y };
}

/** y of a run's branch line, or null when the run was not placed (unknown turn / lane). */
export function branchY(runId: string, layout: GraphLayout): number | null {
  const row = layout.subRowOf.get(runId);
  const lane = layout.laneById.get(layout.laneOfRun.get(runId) ?? '');
  if (row === undefined || !lane) return null;
  return lane.top + layout.opts.trunkRow + row * layout.opts.subRow + layout.opts.subRow / 2;
}

/**
 * y the run forks from and merges back to: its lane's trunk for a depth-1 run (or when the parent is missing or in
 * another lane), else its parent run's branch. null when the run was not placed.
 */
export function parentY(run: GraphRun, layout: GraphLayout): number | null {
  const laneId = layout.laneOfRun.get(run.id);
  const lane = layout.laneById.get(laneId ?? '');
  if (!lane) return null;
  if (run.depth > 1 && run.parentRunId && layout.laneOfRun.get(run.parentRunId) === laneId) {
    const y = branchY(run.parentRunId, layout);
    if (y !== null) return y;
  }
  return lane.trunkY;
}

// ---------------------------------------------------------------------------------------------------------------
// Time scale and ticks

export interface TimeScale {
  fromMs: number;
  toMs: number;
  x0: number;
  width: number;
  /** Pixel x of a time (not clamped). */
  x: (ms: number) => number;
  /** Time at a pixel x (clamped to the window). */
  invert: (px: number) => number;
}

export function timeScale(fromMs: number, toMs: number, x0: number, width: number): TimeScale {
  const span = Math.max(toMs - fromMs, 1);
  const w = Math.max(width, 1);
  return {
    fromMs,
    toMs,
    x0,
    width: w,
    x: (ms) => x0 + ((ms - fromMs) / span) * w,
    invert: (px) => Math.min(toMs, Math.max(fromMs, fromMs + ((px - x0) / w) * span)),
  };
}

/**
 * Tick steps in ms: seconds for short turns on turn detail (a 30 s turn still gets an axis), minutes for zoomed
 * windows, hours for a whole day. Every step divides a day, so ticks align to UTC midnight.
 */
const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30].map((s) => s * 1000).concat([1, 2, 5, 10, 15, 30, 60, 120, 180, 360].map((m) => m * MINUTE_MS));

/** The smallest step that gives at most `targetCount` intervals over the window. */
export function tickStepMs(fromMs: number, toMs: number, targetCount = 8): number {
  const span = Math.max(toMs - fromMs, 0);
  for (const step of TICK_STEPS_MS) if (span / step <= targetCount) return step;
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
}

/** Whether tick labels need seconds (the step is under a minute). */
export const tickNeedsSeconds = (stepMs: number): boolean => stepMs < MINUTE_MS;

/** Tick times inside [fromMs, toMs], aligned to multiples of the step (UTC; steps divide a day). */
export function tickTimes(fromMs: number, toMs: number, targetCount = 8): number[] {
  const step = tickStepMs(fromMs, toMs, targetCount);
  const out: number[] = [];
  for (let t = Math.ceil(fromMs / step) * step; t <= toMs; t += step) out.push(t);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Colours

/** Distinct colours available for agent groups (the chart palette's size); the rest are drawn grey as "other". */
export const GROUP_COLORS = 8;

/**
 * Agent group -> palette index, or null for the grey "other groups". The palette has only GROUP_COLORS colours, so
 * cycling would give two groups in one view the same colour. Instead the first GROUP_COLORS groups of `ranking` always
 * get the colour of their rank (the Agents page ranks by spawns in the whole filter range, so the main groups keep
 * their colour when the window is zoomed or moved); the other groups present take the colours not used by a present
 * head group, by run count here (ties by name), and the rest are grey. No colour appears twice in one view. Without a
 * ranking (turn detail) all groups rank by count.
 */
export function groupColorIndex(groups: Iterable<string>, ranking: readonly string[] = [], max = GROUP_COLORS): Map<string, number | null> {
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g, (counts.get(g) ?? 0) + 1);
  const owned = new Map<string, number>();
  for (const g of ranking) if (owned.size < max && !owned.has(g)) owned.set(g, owned.size);
  const out = new Map<string, number | null>();
  const rest: string[] = [];
  for (const g of counts.keys()) {
    const i = owned.get(g);
    if (i !== undefined) out.set(g, i);
    else rest.push(g);
  }
  const used = new Set(out.values());
  const unowned = Array.from({ length: max }, (_, i) => i).filter((i) => !used.has(i));
  rest.sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
  rest.forEach((g, k) => out.set(g, k < unowned.length ? unowned[k]! : null));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry

/** Horizontal extent of an item clipped to the plot (with a small overhang) and at least `minWidth` wide. */
export function spanX(startMs: number, endMs: number, scale: TimeScale, minWidth = 2, overhang = 24): { x1: number; x2: number } | null {
  if (endMs < scale.fromMs || startMs > scale.toMs) return null;
  const lo = scale.x0 - overhang;
  const hi = scale.x0 + scale.width + overhang;
  let x1 = Math.max(lo, scale.x(startMs));
  let x2 = Math.min(hi, scale.x(Math.max(endMs, startMs)));
  if (x2 - x1 < minWidth) {
    const mid = (x1 + x2) / 2;
    x1 = mid - minWidth / 2;
    x2 = mid + minWidth / 2;
  }
  return { x1, x2 };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Default fork / merge curve width of a branch (px). */
export const BRANCH_CURVE = 8;

/**
 * Whether a branch is too short on screen for fork, line and merge (they would collapse into two vertical strokes
 * from the parent line): such a run is drawn as a short pill on its sub-row with no connector.
 */
export const isShortBranch = (x1: number, x2: number, curve = BRANCH_CURVE): boolean => x2 - x1 < 2 * curve + 4;

/**
 * Git-graph branch: a curve from the parent line (py) at x1 up / down to the branch row (ry), a straight line, and a
 * curve back to the parent line at x2 (the merge). Curves take at most `curve` px, and a third of the span each.
 */
export function branchPath(x1: number, x2: number, py: number, ry: number, curve = BRANCH_CURVE): string {
  const k = Math.max(0, Math.min(curve, (x2 - x1) / 3));
  const a = x1 + k;
  const b = x2 - k;
  if (py === ry || k === 0) return `M${r1(x1)},${r1(ry)}L${r1(x2)},${r1(ry)}`;
  return (
    `M${r1(x1)},${r1(py)}` +
    `C${r1(x1 + k / 2)},${r1(py)} ${r1(a - k / 2)},${r1(ry)} ${r1(a)},${r1(ry)}` +
    `L${r1(b)},${r1(ry)}` +
    `C${r1(b + k / 2)},${r1(ry)} ${r1(x2 - k / 2)},${r1(py)} ${r1(x2)},${r1(py)}`
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting and zoom

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * UTC clock time "HH:MM" (or "HH:MM:SS"). With `dayStartMs`, the next midnight is "24:00" so the end of a whole-day
 * window does not read "00:00".
 */
export function formatClock(ms: number, opts: { seconds?: boolean; dayStartMs?: number } = {}): string {
  if (opts.dayStartMs !== undefined && ms - opts.dayStartMs === DAY_MS) return opts.seconds ? '24:00:00' : '24:00';
  const d = new Date(ms);
  const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return opts.seconds ? `${hm}:${pad2(d.getUTCSeconds())}` : hm;
}

/** Minutes since midnight -> "HH:MM" (1440 -> "24:00"). */
export function minutesToClock(min: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(min)));
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export { formatDuration };

/** ms -> nearest whole minute. */
export const snapToMinute = (ms: number): number => Math.round(ms / MINUTE_MS) * MINUTE_MS;

/**
 * A dragged selection as the timeline's URL window: `from` / `to` as "HH:MM" within `day` (UTC, to may be "24:00"),
 * snapped to whole minutes. null when the selection is shorter than one minute or `day` is not a date.
 */
export function zoomWindow(fromMs: number, toMs: number, day: string): { from: string; to: string } | null {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(dayStart)) return null;
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  const fromMin = Math.max(0, Math.min(1439, Math.round((lo - dayStart) / MINUTE_MS)));
  const toMin = Math.max(1, Math.min(1440, Math.round((hi - dayStart) / MINUTE_MS)));
  if (toMin - fromMin < 1) return null;
  return { from: minutesToClock(fromMin), to: minutesToClock(toMin) };
}
