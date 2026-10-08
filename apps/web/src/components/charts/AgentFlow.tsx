'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useChartTheme } from '../chart-theme';
import { formatModel } from '../../lib/model-name';
import {
  chain,
  edgeChain,
  edgeKey,
  edgePath,
  fitLabel,
  flowLayout,
  linkCounts,
  MIN_PILL_W,
  nodeGeometry,
  PILL_H,
  PILL_RX,
  tooltipPosition,
  UNSTAGED_LABEL,
  visibleSpan,
  type Chain,
  type FlowEdge,
  type FlowLane,
  type FlowNode,
  type NodeGeometry,
} from './agent-flow-layout';
import { DAY_MS, formatClock, formatDuration, groupColorIndex, tickNeedsSeconds, tickStepMs, tickTimes, timeScale } from './agent-graph-layout';

export type { FlowEdge, FlowLane, FlowNode } from './agent-flow-layout';

export interface AgentFlowProps {
  lanes: FlowLane[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  fromMs: number;
  toMs: number;
  /** Agent groups ranked by importance, as for AgentGraph, so a group has the same colour in both charts. */
  groupOrder?: string[];
  ariaLabel: string;
}

const GUTTER = 160;
/** Right part of the gutter that holds the stage names. */
const STAGE_COL = 72;
const RIGHT_PAD = 16;
const MIN_WIDTH = 640;
const TOOLTIP_W = 240;
const BOTTOM_PAD = 8;
/** Most sub-rows of one stage row; a larger burst of parallel agents shares one overflow sub-row. */
const MAX_SUB_ROWS = 16;
const DIM = 0.25;
const KIND_LABEL: Record<FlowEdge['kind'], string> = { item: 'same item (next stage)', sequence: 'ran after (same parent)' };

type Hover = { kind: 'node'; id: string } | { kind: 'edge'; edge: FlowEdge } | null;
/** Cursor in viewport px: the tooltip is fixed-positioned in a portal, so the chart's scroll box cannot clip it. */
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
 * Agent flow (ADR-0020): one lane per orchestration or per turn's direct spawns, one row per stage, time on x. Each
 * sub-agent is a pill from start to end coloured by its agent group (dashed outline when failed); links are arrows from
 * the source's end to the target's start (`item` solid, `sequence` dashed). Hovering a node or link highlights its
 * whole chain upstream and downstream and dims the rest; clicking a node opens its turn.
 */
export function AgentFlow({ lanes, nodes, edges, fromMs, toMs, groupOrder, ariaLabel }: AgentFlowProps) {
  const t = useChartTheme();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clipId = `agent-flow-clip-${uid}`;
  const arrowId = `agent-flow-arrow-${uid}`;
  const arrowHiId = `agent-flow-arrow-hi-${uid}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(MIN_WIDTH);
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // Place the tooltip once its size is known: below-right of the cursor, flipped above / left near the viewport edges.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    const p = tooltipPosition({ x: tip.x, y: tip.y }, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight });
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    el.style.visibility = 'visible';
  }, [tip]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // The wrapper only exists when there are nodes to draw.
  }, [nodes.length === 0]);

  const width = Math.max(MIN_WIDTH, containerWidth);
  const plotW = width - GUTTER - RIGHT_PAD;
  const scale = useMemo(() => timeScale(fromMs, toMs, GUTTER, plotW), [fromMs, toMs, plotW]);
  const minSpanMs = (MIN_PILL_W / Math.max(plotW, 1)) * Math.max(toMs - fromMs, 1);
  const layout = useMemo(() => flowLayout(lanes, nodes, { maxSubRows: MAX_SUB_ROWS, minSpanMs }), [lanes, nodes, minSpanMs]);
  const groupIdx = useMemo(() => groupColorIndex(nodes.map((n) => n.group), groupOrder), [nodes, groupOrder]);
  const laneMeta = useMemo(() => new Map(lanes.map((l) => [l.id, l])), [lanes]);
  const counts = useMemo(() => linkCounts(edges), [edges]);
  const geo = useMemo(() => {
    const m = new Map<string, NodeGeometry>();
    for (const n of nodes) {
      const g = nodeGeometry(n, layout, scale);
      if (g) m.set(n.id, g);
    }
    return m;
  }, [nodes, layout, scale]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const ticks = useMemo(() => tickTimes(fromMs, toMs), [fromMs, toMs]);
  const tickSeconds = tickNeedsSeconds(tickStepMs(fromMs, toMs));
  const lit: Chain | null = useMemo(() => {
    if (!hover) return null;
    return hover.kind === 'node' ? chain(hover.id, edges) : edgeChain(hover.edge, edges);
  }, [hover, edges]);

  if (nodes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        No sub-agent runs in this window.
      </div>
    );
  }

  const height = layout.height + BOTTOM_PAD;
  const plotBottom = layout.height;
  const axisH = layout.opts.top;
  const dayStartMs = Math.floor(fromMs / DAY_MS) * DAY_MS;
  const otherColor = t.color(0, 'other');
  const groupColor = (g: string) => {
    const i = groupIdx.get(g);
    return i === null || i === undefined ? otherColor : t.color(i);
  };
  const pillText = t.dark ? '#18181b' : '#ffffff';
  const clock = (ms: number) => `${formatClock(ms, { seconds: true })} UTC`;

  function showTip(e: { clientX: number; clientY: number }, content: ReactNode) {
    setTip({ x: e.clientX, y: e.clientY, content });
  }
  const leave = () => {
    setTip(null);
    setHover(null);
  };

  const stageName = (n: FlowNode) => {
    const lane = laneMeta.get(n.laneId);
    if (!lane || lane.stages.length === 0) return n.stageIndex === null ? null : `#${n.stageIndex + 1}`;
    return n.stageIndex !== null && n.stageIndex >= 0 && n.stageIndex < lane.stages.length ? lane.stages[n.stageIndex]! : UNSTAGED_LABEL;
  };
  const nodeTip = (n: FlowNode) => {
    const c = counts.get(n.id) ?? { in: 0, out: 0 };
    const lane = laneMeta.get(n.laneId);
    const stage = stageName(n);
    return (
      <>
        <div className="mb-0.5 truncate font-semibold">{n.label}</div>
        <Row k="group" v={n.group} />
        {lane && <Row k="lane" v={lane.sublabel ? `${lane.label} · ${lane.sublabel}` : lane.label} />}
        {stage && <Row k="stage" v={stage} />}
        {n.model && <Row k="model" v={formatModel(n.model)} />}
        <Row k="start" v={clock(n.startMs)} />
        <Row k="duration" v={formatDuration(n.endMs - n.startMs)} />
        <Row k="outcome" v={n.outcome} />
        <Row k="links" v={`${c.in} in → ${c.out} out`} />
      </>
    );
  };
  const edgeTip = (e: FlowEdge) => (
    <>
      <div className="mb-0.5 truncate font-semibold">{KIND_LABEL[e.kind]}</div>
      <Row k="from" v={nodeById.get(e.fromId)?.label ?? e.fromId} />
      <Row k="to" v={nodeById.get(e.toId)?.label ?? e.toId} />
    </>
  );

  const groupsPresent = [...groupIdx.entries()];
  const coloured = groupsPresent.filter(([, i]) => i !== null).map(([g]) => g);
  const greyGroups = groupsPresent.filter(([, i]) => i === null).map(([g]) => g);
  const kindsPresent = new Set(edges.map((e) => e.kind));
  const hasFailed = nodes.some((n) => n.outcome === 'failed');

  return (
    <div>
      <div ref={wrapRef} className="w-full overflow-x-auto">
        <div className="relative" style={{ width, height }} onMouseLeave={leave}>
          <svg role="img" aria-label={ariaLabel} width={width} height={height} className="absolute top-0 left-0 block select-none">
            <defs>
              <clipPath id={clipId}>
                <rect x={GUTTER} y={0} width={plotW} height={height} />
              </clipPath>
              {[
                [arrowId, t.axis],
                [arrowHiId, t.text],
              ].map(([id, fill]) => (
                <marker key={id} id={id} viewBox="0 0 8 8" refX={8} refY={4} markerWidth={7} markerHeight={7} orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M0,0L8,4L0,8Z" fill={fill} />
                </marker>
              ))}
            </defs>

            {/* Lane separators (middle of the gap) and stage-row separators */}
            {layout.lanes.map((box, i) => (
              <g key={`sep-${box.id}`}>
                {i > 0 && (
                  <line x1={0} x2={width} y1={box.top - layout.opts.laneGap / 2} y2={box.top - layout.opts.laneGap / 2} stroke={t.grid} strokeWidth={1} />
                )}
                {box.rows.slice(1).map((row) => (
                  <line key={`row-${row.index}`} x1={GUTTER} x2={GUTTER + plotW} y1={row.top} y2={row.top} stroke={t.grid} strokeWidth={1} opacity={0.6} />
                ))}
              </g>
            ))}

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
            <line x1={GUTTER} x2={GUTTER + plotW} y1={axisH - 6} y2={axisH - 6} stroke={t.axis} strokeWidth={1} />

            <g clipPath={`url(#${clipId})`}>
              {/* Links, under the pills so an arrow tip touches its target's start */}
              {edges.map((e) => {
                const a = geo.get(e.fromId);
                const b = geo.get(e.toId);
                if (!a || !b) return null;
                const key = edgeKey(e);
                const on = lit?.edges.has(key) ?? false;
                const d = edgePath(a.x2, a.y, b.x1, b.y);
                return (
                  <g
                    key={`edge-${key}`}
                    opacity={lit && !on ? DIM : 1}
                    onMouseMove={(ev) => {
                      setHover({ kind: 'edge', edge: e });
                      showTip(ev, edgeTip(e));
                    }}
                    onMouseLeave={leave}
                  >
                    <path
                      d={d}
                      fill="none"
                      stroke={on ? t.text : t.axis}
                      strokeWidth={on ? 2 : 1.5}
                      strokeDasharray={e.kind === 'sequence' ? '4 3' : undefined}
                      markerEnd={`url(#${on ? arrowHiId : arrowId})`}
                    />
                    <path d={d} fill="none" stroke="transparent" strokeWidth={8} pointerEvents="stroke" />
                  </g>
                );
              })}

              {/* Agents */}
              {nodes.map((n) => {
                const g = geo.get(n.id);
                if (!g) return null;
                const w = g.x2 - g.x1;
                // Label inside the visible part of the pill (one that starts before the window overhangs the plot).
                const vis = visibleSpan(g, GUTTER, GUTTER + plotW);
                const label = fitLabel(n.label, vis.width);
                const failed = n.outcome === 'failed';
                const overflowRow = layout.placement.get(n.id)?.subRow === layout.opts.maxSubRows;
                const dim = lit ? !lit.nodes.has(n.id) : false;
                const body = (
                  <>
                    <rect
                      x={g.x1}
                      y={g.y - PILL_H / 2}
                      width={w}
                      height={PILL_H}
                      rx={Math.min(PILL_RX, w / 2)}
                      fill={groupColor(n.group)}
                      stroke={failed ? t.color(0, 'failed') : lit && !dim ? t.text : 'none'}
                      strokeWidth={failed ? 1.5 : 1}
                      strokeDasharray={failed ? '3 2' : undefined}
                    />
                    {label && (
                      <text x={vis.x + 5} y={g.y + 3.5} fontSize={10} fill={pillText} pointerEvents="none">
                        {label}
                      </text>
                    )}
                  </>
                );
                return (
                  <g
                    key={`node-${n.id}`}
                    opacity={dim ? DIM : overflowRow ? 0.65 : 1}
                    onMouseMove={(ev) => {
                      setHover({ kind: 'node', id: n.id });
                      showTip(ev, nodeTip(n));
                    }}
                    onMouseLeave={leave}
                    style={n.href ? { cursor: 'pointer' } : undefined}
                  >
                    {n.href ? (
                      <a href={n.href} aria-label={n.label}>
                        {body}
                      </a>
                    ) : (
                      body
                    )}
                  </g>
                );
              })}
            </g>
          </svg>

          {/*
            Lane gutter: HTML so long labels truncate with a title; sticky so it stays visible on horizontal scroll. Lane
            label on the left, stage names right-aligned per row.
          */}
          <div className="pointer-events-none sticky left-0 z-[1]" style={{ width: GUTTER, height }}>
            {layout.lanes.map((box) => {
              const lane = laneMeta.get(box.id);
              if (!lane) return null;
              const staged = lane.stages.length > 0;
              const labelW = staged ? GUTTER - STAGE_COL - 12 : GUTTER - 8;
              return (
                <div key={box.id} className="absolute left-0 bg-white dark:bg-zinc-900" style={{ top: box.top, width: GUTTER, height: box.height }}>
                  <div className="pointer-events-auto absolute top-0 left-0 flex flex-col pt-1 pl-1" style={{ width: labelW }}>
                    <span className="truncate text-xs leading-tight font-semibold text-zinc-800 dark:text-zinc-200" title={lane.label}>
                      {lane.label}
                    </span>
                    {lane.sublabel && (
                      <span className="truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-400" title={lane.sublabel}>
                        {lane.sublabel}
                      </span>
                    )}
                  </div>
                  {staged &&
                    box.rows.map((row) => (
                      <div
                        key={row.index}
                        className={`pointer-events-auto absolute right-2 flex items-center justify-end gap-1 text-[11px] leading-none ${
                          row.unstaged ? 'text-zinc-400 italic dark:text-zinc-500' : 'text-zinc-600 dark:text-zinc-400'
                        }`}
                        style={{ top: row.top - box.top, height: layout.opts.rowH, width: STAGE_COL }}
                        title={row.label ?? undefined}
                      >
                        <span className="truncate">{row.label}</span>
                      </div>
                    ))}
                  {/* "+N" beside the overflow sub-row (the row's last), where the shared pills are drawn */}
                  {box.rows
                    .filter((row) => row.overflow > 0)
                    .map((row) => (
                      <div
                        key={`ovf-${row.index}`}
                        className="pointer-events-auto absolute right-2 flex items-center justify-end text-[11px] leading-none text-zinc-500 dark:text-zinc-400"
                        style={{ top: row.top - box.top + (row.subRows - 1) * layout.opts.subRowH, height: layout.opts.rowH, width: STAGE_COL }}
                        title={`${row.label ?? 'row'}: ${row.overflow} more parallel agents share this sub-row`}
                      >
                        +{row.overflow}
                      </div>
                    ))}
                </div>
              );
            })}
          </div>

          {tip &&
            createPortal(
              <div
                ref={tipRef}
                role="tooltip"
                className="pointer-events-none fixed z-50 rounded-md px-2 py-1.5 text-xs shadow-sm"
                style={{
                  left: 0,
                  top: 0,
                  visibility: 'hidden',
                  width: TOOLTIP_W,
                  background: t.tooltipBg,
                  border: `1px solid ${t.tooltipBorder}`,
                  color: t.text,
                }}
              >
                {tip.content}
              </div>,
              document.body,
            )}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-col gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-zinc-500 dark:text-zinc-400">Agent groups</span>
          {coloured.map((g) => (
            <span key={g} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-4 rounded-full" style={{ background: groupColor(g) }} />
              {g}
            </span>
          ))}
          {greyGroups.length > 0 && (
            <span className="inline-flex items-center gap-1.5" title={greyGroups.join(', ')}>
              <span aria-hidden className="inline-block h-2.5 w-4 rounded-full" style={{ background: otherColor }} />
              {greyGroups.length === 1 ? greyGroups[0] : `${greyGroups.length} other groups`}
            </span>
          )}
          {hasFailed && (
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden width={18} height={12}>
                <rect x={1} y={1} width={16} height={10} rx={5} fill="none" stroke={t.color(0, 'failed')} strokeWidth={1.5} strokeDasharray="3 2" />
              </svg>
              failed
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-zinc-500 dark:text-zinc-400">Links</span>
          {(['item', 'sequence'] as const).map((kind) => (
            <span key={kind} className={`inline-flex items-center gap-1.5 ${kindsPresent.has(kind) ? '' : 'opacity-50'}`}>
              <svg aria-hidden width={24} height={8}>
                <line x1={1} x2={17} y1={4} y2={4} stroke={t.axis} strokeWidth={1.5} strokeDasharray={kind === 'sequence' ? '4 3' : undefined} />
                <path d="M16,0L23,4L16,8Z" fill={t.axis} />
              </svg>
              {KIND_LABEL[kind]}
            </span>
          ))}
          <span className="text-zinc-500 dark:text-zinc-500">Hover an agent to follow its chain.</span>
        </div>
      </div>
    </div>
  );
}
