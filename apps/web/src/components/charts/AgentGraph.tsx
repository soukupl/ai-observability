'use client';

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useChartTheme } from '../chart-theme';
import { formatModel } from '../../lib/model-name';
import {
  backgroundEnds,
  branchPath,
  branchY,
  DAY_MS,
  formatClock,
  formatDuration,
  groupColorIndex,
  isShortBranch,
  laneLayout,
  LAYOUT_DEFAULTS,
  MINUTE_MS,
  parentY,
  snapToMinute,
  spanX,
  tickNeedsSeconds,
  tickStepMs,
  tickTimes,
  timeScale,
  type GraphLane,
  type GraphRun,
  type GraphTurn,
} from './agent-graph-layout';

export type { GraphLane, GraphRun, GraphTurn } from './agent-graph-layout';

export interface AgentGraphProps {
  lanes: GraphLane[];
  turns: GraphTurn[];
  runs: GraphRun[];
  fromMs: number;
  toMs: number;
  projectLegend: { label: string; colorIndex: number }[];
  /**
   * Agent groups ranked by importance (the Agents page: spawns in the filter range). The first GROUP_COLORS present get
   * their own colour, in this order, the rest are grey; so a group keeps its colour across windows. Default: by run
   * count in this graph.
   */
  groupOrder?: string[];
  /** Called with a dragged range on the time axis, snapped to whole minutes (≥ 1 minute). */
  onZoom?: (fromMs: number, toMs: number) => void;
  ariaLabel: string;
}

/** Lane label gutter; narrower on phones so the plot keeps most of the first screen. It stays put on horizontal scroll. */
const GUTTER = 160;
const GUTTER_NARROW = 104;
const NARROW_BELOW = 560;
const RIGHT_PAD = 16;
const MIN_WIDTH = 640;
const TOOLTIP_W = 240;
/** Least on-screen width a run holds its sub-row for (px), so neighbours on one row never touch. */
const MIN_RUN_PX = 6;

type Tip = { x: number; y: number; content: ReactNode };

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 opacity-70">{k}</span>
      <span className="min-w-0 truncate">{v}</span>
    </div>
  );
}

/**
 * Git graph over time (ADR-0019): one lane per session, coloured by project; turns are the trunk, each sub-agent run
 * is a branch that forks from its parent (trunk or parent run) at its start and merges back at its end. Parallel
 * runs stack in sub-rows below the trunk (at most LAYOUT_DEFAULTS.maxSubRows, then one shared overflow row); runs too
 * short on screen for a fork are pills on their row. A dashed trunk tail marks agents still running after their turn
 * ended. Drag on the time axis to zoom.
 */
export function AgentGraph({ lanes, turns, runs, fromMs, toMs, projectLegend, groupOrder, onZoom, ariaLabel }: AgentGraphProps) {
  const t = useChartTheme();
  const clipId = `agent-graph-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(MIN_WIDTH);
  const [tip, setTip] = useState<Tip | null>(null);
  const [drag, setDrag] = useState<{ startPx: number; curPx: number; pointerId: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // The wrapper only exists when there are turns to draw.
  }, [turns.length === 0]);

  const gutter = containerWidth < NARROW_BELOW ? GUTTER_NARROW : GUTTER;
  const width = Math.max(MIN_WIDTH, containerWidth);
  const plotW = width - gutter - RIGHT_PAD;
  const scale = useMemo(() => timeScale(fromMs, toMs, gutter, plotW), [fromMs, toMs, gutter, plotW]);
  const minSpanMs = (MIN_RUN_PX / Math.max(plotW, 1)) * Math.max(toMs - fromMs, 1);
  const layout = useMemo(() => laneLayout(lanes, turns, runs, { ...LAYOUT_DEFAULTS, minSpanMs }), [lanes, turns, runs, minSpanMs]);
  const groupIdx = useMemo(() => groupColorIndex(runs.map((r) => r.group), groupOrder), [runs, groupOrder]);
  const laneMeta = useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const turnById = useMemo(() => new Map(turns.map((x) => [x.id, x])), [turns]);
  const tails = useMemo(() => backgroundEnds(turns, runs), [turns, runs]);
  const ticks = useMemo(() => tickTimes(fromMs, toMs), [fromMs, toMs]);
  const tickSeconds = tickNeedsSeconds(tickStepMs(fromMs, toMs));
  // Parents before children so nested branches draw on top of the branch they fork from.
  const runsByDepth = useMemo(() => [...runs].sort((a, b) => a.depth - b.depth || a.startMs - b.startMs), [runs]);

  if (turns.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        No turns in this window.
      </div>
    );
  }

  const height = layout.height + 8;
  const plotBottom = layout.height;
  const axisH = LAYOUT_DEFAULTS.top;
  const { trunkRow, subRow, maxSubRows } = LAYOUT_DEFAULTS;
  const dayStartMs = Math.floor(fromMs / DAY_MS) * DAY_MS;
  const otherColor = t.color(0, 'other');
  const groupColor = (g: string) => {
    const i = groupIdx.get(g);
    return i === null || i === undefined ? otherColor : t.color(i);
  };

  function showTip(e: { clientX: number; clientY: number }, content: ReactNode) {
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const left = x + 14 + TOOLTIP_W > width ? Math.max(0, x - 14 - TOOLTIP_W) : x + 14;
    setTip({ x: left, y: y + 12, content });
  }
  const hideTip = () => setTip(null);

  const laneLine = (laneId: string) => {
    const lane = laneMeta.get(laneId);
    if (!lane) return null;
    return <Row k="project" v={lane.sublabel ? `${lane.label} · ${lane.sublabel}` : lane.label} />;
  };
  const clock = (ms: number) => `${formatClock(ms, { seconds: true })} UTC`;

  // --- drag to zoom (pointer events cover mouse, pen and touch) ---
  const localX = (e: ReactPointerEvent) => {
    const rect = innerRef.current?.getBoundingClientRect();
    const px = rect ? e.clientX - rect.left : 0;
    return Math.min(gutter + plotW, Math.max(gutter, px));
  };
  const onDown = (e: ReactPointerEvent<SVGRectElement>) => {
    if (!onZoom || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const px = localX(e);
    setDrag({ startPx: px, curPx: px, pointerId: e.pointerId });
    hideTip();
  };
  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    if (drag && e.pointerId === drag.pointerId) setDrag({ ...drag, curPx: localX(e) });
  };
  const onUp = (e: ReactPointerEvent<SVGRectElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const a = snapToMinute(scale.invert(Math.min(drag.startPx, localX(e))));
    const b = snapToMinute(scale.invert(Math.max(drag.startPx, localX(e))));
    setDrag(null);
    if (onZoom && b - a >= MINUTE_MS) onZoom(a, b);
  };
  const onCancel = () => setDrag(null);

  const sel = drag ? { x: Math.min(drag.startPx, drag.curPx), w: Math.abs(drag.curPx - drag.startPx) } : null;
  const selLabel =
    drag && sel && sel.w > 2
      ? `${formatClock(snapToMinute(scale.invert(sel.x)), { dayStartMs })}–${formatClock(snapToMinute(scale.invert(sel.x + sel.w)), { dayStartMs })}`
      : null;

  const coloured = [...groupIdx.entries()].filter(([, i]) => i !== null).map(([g]) => g);
  const greyGroups = [...groupIdx.entries()].filter(([, i]) => i === null).map(([g]) => g);
  const hasTails = tails.size > 0;

  return (
    <div>
      <div ref={wrapRef} className="w-full overflow-x-auto">
        <div ref={innerRef} className="relative" style={{ width, height }}>
          <svg role="img" aria-label={ariaLabel} width={width} height={height} className="absolute top-0 left-0 block select-none" style={{ touchAction: 'pan-y' }}>
            <defs>
              <clipPath id={clipId}>
                <rect x={gutter} y={0} width={plotW} height={height} />
              </clipPath>
            </defs>

            {/* Lane separators */}
            {layout.lanes.map((box, i) =>
              i === 0 ? null : <line key={`sep-${box.id}`} x1={0} x2={width} y1={box.top} y2={box.top} stroke={t.grid} strokeWidth={1} />,
            )}

            {/* Ticks and grid */}
            {ticks.map((ms) => {
              const x = scale.x(ms);
              return (
                <g key={`tick-${ms}`}>
                  <line x1={x} x2={x} y1={axisH - 6} y2={plotBottom} stroke={t.grid} strokeDasharray="3 3" />
                  <text x={x} y={axisH - 10} textAnchor="middle" fontSize={11} fill={t.axis}>
                    {formatClock(ms, { dayStartMs, seconds: tickSeconds })}
                  </text>
                </g>
              );
            })}
            <line x1={gutter} x2={gutter + plotW} y1={axisH - 6} y2={axisH - 6} stroke={t.axis} strokeWidth={1} />

            <g clipPath={`url(#${clipId})`}>
              {/* Baselines: idle time on the lane */}
              {layout.lanes.map((box) => (
                <line key={`base-${box.id}`} x1={gutter} x2={gutter + plotW} y1={box.trunkY} y2={box.trunkY} stroke={t.grid} strokeWidth={2} />
              ))}

              {/* Background tails: the turn has ended but agents it launched are still running (workflow agents). */}
              {turns.map((turn) => {
                const tailEnd = tails.get(turn.id);
                const box = layout.laneById.get(turn.laneId);
                const lane = laneMeta.get(turn.laneId);
                const sx = tailEnd === undefined ? null : spanX(turn.endMs, tailEnd, scale, 0);
                if (!box || !lane || !sx) return null;
                return (
                  <line
                    key={`tail-${turn.id}`}
                    x1={sx.x1}
                    x2={sx.x2}
                    y1={box.trunkY}
                    y2={box.trunkY}
                    stroke={t.color(lane.colorIndex)}
                    strokeWidth={2}
                    strokeDasharray="2 3"
                    opacity={0.75}
                  />
                );
              })}

              {/* Branches (sub-agent runs) */}
              {runsByDepth.map((run) => {
                const ry = branchY(run.id, layout);
                const py = parentY(run, layout);
                const sx = spanX(run.startMs, run.endMs, scale);
                if (ry === null || py === null || !sx) return null;
                // Too short on screen for fork / line / merge (they would be two vertical strokes): a pill on its row.
                const short = isShortBranch(sx.x1, sx.x2);
                const d = short ? branchPath(sx.x1, Math.max(sx.x2, sx.x1 + 4), ry, ry) : branchPath(sx.x1, sx.x2, py, ry);
                const turn = turnById.get(run.turnId);
                const overflowRow = layout.subRowOf.get(run.id) === maxSubRows;
                const tipContent = (
                  <>
                    <div className="mb-0.5 truncate font-semibold">{run.label}</div>
                    <Row k="group" v={run.group} />
                    {turn && laneLine(turn.laneId)}
                    {run.model && <Row k="model" v={formatModel(run.model)} />}
                    <Row k="start" v={clock(run.startMs)} />
                    <Row k="duration" v={formatDuration(run.endMs - run.startMs)} />
                    <Row k="outcome" v={run.outcome} />
                    {turn && run.endMs > turn.endMs && <Row k="note" v="still running after its turn ended" />}
                  </>
                );
                return (
                  <g key={`run-${run.id}`} onMouseMove={(e) => showTip(e, tipContent)} onMouseLeave={hideTip} opacity={overflowRow ? 0.65 : 1}>
                    <path
                      d={d}
                      fill="none"
                      stroke={groupColor(run.group)}
                      strokeWidth={short ? 4 : 3}
                      strokeLinecap="round"
                      strokeDasharray={run.outcome === 'failed' && !short ? '4 3' : undefined}
                    />
                    {/* Wider invisible stroke so a thin branch is easy to hover. */}
                    <path d={d} fill="none" stroke="transparent" strokeWidth={10} pointerEvents="stroke" />
                  </g>
                );
              })}

              {/* Trunk (turns) */}
              {turns.map((turn) => {
                const box = layout.laneById.get(turn.laneId);
                const lane = laneMeta.get(turn.laneId);
                const sx = spanX(turn.startMs, turn.endMs, scale);
                if (!box || !lane || !sx) return null;
                const tailEnd = tails.get(turn.id);
                const tipContent = (
                  <>
                    <div className="mb-0.5 truncate font-semibold">{turn.label}</div>
                    {laneLine(turn.laneId)}
                    <Row k="start" v={clock(turn.startMs)} />
                    <Row k="duration" v={formatDuration(turn.endMs - turn.startMs)} />
                    <Row k="outcome" v={turn.outcome} />
                    {tailEnd !== undefined && <Row k="agents" v={`running until ${clock(tailEnd)}`} />}
                  </>
                );
                const endInView = turn.endMs >= fromMs && turn.endMs <= toMs;
                const body = (
                  <>
                    <rect x={sx.x1} y={box.trunkY - 4} width={sx.x2 - sx.x1} height={8} rx={3} fill={t.color(lane.colorIndex)} />
                    {endInView && <circle cx={scale.x(turn.endMs)} cy={box.trunkY} r={3.5} fill={t.color(0, turn.outcome)} stroke={t.tooltipBg} strokeWidth={1} />}
                    <rect x={sx.x1 - 2} y={box.trunkY - 8} width={sx.x2 - sx.x1 + 4} height={16} fill="transparent" />
                  </>
                );
                return (
                  <g key={`turn-${turn.id}`} onMouseMove={(e) => showTip(e, tipContent)} onMouseLeave={hideTip}>
                    {turn.href ? (
                      <a href={turn.href} aria-label={`${turn.label} (${lane.label})`}>
                        {body}
                      </a>
                    ) : (
                      body
                    )}
                  </g>
                );
              })}
            </g>

            {/* Selection */}
            {sel && sel.w > 0 && (
              <g pointerEvents="none">
                <rect x={sel.x} y={0} width={sel.w} height={plotBottom} fill={t.axis} opacity={0.15} />
                <line x1={sel.x} x2={sel.x} y1={0} y2={plotBottom} stroke={t.axis} />
                <line x1={sel.x + sel.w} x2={sel.x + sel.w} y1={0} y2={plotBottom} stroke={t.axis} />
              </g>
            )}

            {/* Drag target: the axis band */}
            {onZoom && (
              <rect
                x={gutter}
                y={0}
                width={plotW}
                height={axisH}
                fill="transparent"
                style={{ cursor: 'col-resize', touchAction: 'none' }}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onCancel}
              >
                <title>Drag to zoom into a time range</title>
              </rect>
            )}
          </svg>

          {/*
            Lane gutter: HTML so long labels truncate with a title. Sticky, so the labels stay visible when the graph
            scrolls sideways (narrow screens); its background hides the plot scrolling underneath.
          */}
          <div className="pointer-events-none sticky left-0 z-[1]" style={{ width: gutter, height }}>
            {layout.lanes.map((box, i) => {
              const lane = laneMeta.get(box.id);
              if (!lane) return null;
              const hidden = layout.overflow.get(box.id)?.length ?? 0;
              return (
                <div
                  key={box.id}
                  className={`absolute left-0 bg-white dark:bg-zinc-900 ${i === 0 ? '' : 'border-t border-zinc-200 dark:border-zinc-700'}`}
                  style={{ top: box.top, width: gutter, height: box.height }}
                >
                  <div className="pointer-events-auto flex flex-col justify-center pr-2 pl-1" style={{ height: trunkRow }}>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: t.color(lane.colorIndex) }} />
                      <span className="truncate text-xs font-semibold text-zinc-800 dark:text-zinc-200" title={lane.label}>
                        {lane.label}
                      </span>
                    </div>
                    {lane.sublabel && (
                      <span className="truncate pl-4 text-[11px] leading-tight text-zinc-500 dark:text-zinc-400" title={lane.sublabel}>
                        {lane.sublabel}
                      </span>
                    )}
                  </div>
                  {hidden > 0 && (
                    <div
                      className="pointer-events-auto absolute right-2 text-[11px] leading-none text-zinc-500 dark:text-zinc-400"
                      style={{ top: trunkRow + maxSubRows * subRow + subRow / 2 - 5 }}
                      title={`${hidden} more parallel runs share this row`}
                    >
                      +{hidden} more
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {selLabel && sel && (
            <div
              className="pointer-events-none absolute z-[2] rounded px-1.5 py-0.5 text-[11px] font-medium"
              style={{ left: Math.min(sel.x, width - 100), top: axisH + 2, background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, color: t.text }}
            >
              {selLabel} UTC
            </div>
          )}

          {tip && !drag && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 rounded-md px-2 py-1.5 text-xs shadow-sm"
              style={{ left: tip.x, top: tip.y, width: TOOLTIP_W, background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, color: t.text }}
            >
              {tip.content}
            </div>
          )}
        </div>
      </div>

      {/* Legends */}
      <div className="mt-3 flex flex-col gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
        {projectLegend.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-zinc-500 dark:text-zinc-400">Projects</span>
            {projectLegend.map((p) => (
              <span key={`${p.label}-${p.colorIndex}`} className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-2 w-4 rounded-sm" style={{ background: t.color(p.colorIndex) }} />
                {p.label}
              </span>
            ))}
            {hasTails && (
              <span className="inline-flex items-center gap-1.5">
                <svg aria-hidden width={16} height={4}>
                  <line x1={1} x2={15} y1={2} y2={2} stroke={t.axis} strokeWidth={2} strokeDasharray="2 3" />
                </svg>
                agents still running after the turn ended
              </span>
            )}
          </div>
        )}
        {coloured.length + greyGroups.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-zinc-500 dark:text-zinc-400">Agent groups</span>
            {coloured.map((g) => (
              <span key={g} className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-[3px] w-4 rounded-full" style={{ background: groupColor(g) }} />
                {g}
              </span>
            ))}
            {greyGroups.length > 0 && (
              <span className="inline-flex items-center gap-1.5" title={greyGroups.join(', ')}>
                <span aria-hidden className="inline-block h-[3px] w-4 rounded-full" style={{ background: otherColor }} />
                {greyGroups.length === 1 ? greyGroups[0] : `${greyGroups.length} other groups`}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden width={16} height={4}>
                <line x1={1} x2={15} y1={2} y2={2} stroke={t.axis} strokeWidth={2} strokeDasharray="4 3" />
              </svg>
              failed
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
