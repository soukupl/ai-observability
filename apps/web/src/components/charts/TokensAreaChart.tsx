'use client';

import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useChartTheme } from '../chart-theme';
import { formatDay, formatTokens, formatValue, type ValueFormat } from '../format';
import { applyZoom, zoomRange, type ZoomRange } from './zoom-range';

/** One row per x (a day) with a number per series, e.g. `{ x: '2026-10-01', 'claude-opus-5-5': 1200, … }`. */
export type SeriesRow = { x: string } & Record<string, number | string>;

/** What Recharts hands to the chart's mouse / touch handlers; only the active x label is used here. */
type ChartPointer = { activeLabel?: unknown };

/** A drag in progress: the x label where it started and the one under the pointer now. */
interface Drag {
  a: string;
  b: string | null;
}

/**
 * Stacked area over time, e.g. tokens by model (or any count with `valueFormat`). Time zoom: drag across the chart to
 * show only the days between the two ends (zooming again narrows further); "Reset zoom" or a double-click shows the
 * whole range. The zoom is client state over the rows already loaded and is tied to the `data` array it was made for,
 * so a new render with new data (navigation, filter change) starts un-zoomed.
 */
export function TokensAreaChart({
  data,
  series,
  height = 280,
  valueFormat = 'tokens',
  seriesLabels,
  ariaLabel = 'Stacked area chart of tokens over time by model',
}: {
  data: SeriesRow[];
  series: string[];
  height?: number;
  valueFormat?: ValueFormat;
  /** Display names by series key (e.g. friendly model names); keys stay the raw data keys. */
  seriesLabels?: Record<string, string>;
  ariaLabel?: string;
}) {
  const t = useChartTheme();
  const [zoom, setZoom] = useState<{ data: SeriesRow[]; range: ZoomRange } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const range = zoom && zoom.data === data ? zoom.range : null;
  const shown = applyZoom(data, range);
  const zoomed = range !== null;

  const start = (p: ChartPointer) => {
    if (p.activeLabel !== undefined && p.activeLabel !== null) setDrag({ a: String(p.activeLabel), b: null });
  };
  const move = (p: ChartPointer) => {
    if (drag && p.activeLabel !== undefined && p.activeLabel !== null) setDrag({ a: drag.a, b: String(p.activeLabel) });
  };
  const end = () => {
    const r = drag && drag.b !== null ? zoomRange(shown, drag.a, drag.b) : null;
    setDrag(null);
    if (!r) return;
    const base = range?.from ?? 0;
    setZoom({ data, range: { from: base + r.from, to: base + r.to } });
  };
  const cancel = () => setDrag(null);
  const reset = () => {
    setDrag(null);
    setZoom(null);
  };

  const first = shown[0]?.x;
  const last = shown[shown.length - 1]?.x;
  const label = zoomed && first && last ? `${ariaLabel}, zoomed to ${formatDay(first)}–${formatDay(last)}` : ariaLabel;
  const selecting = drag !== null && drag.b !== null && drag.b !== drag.a;

  return (
    <div className="relative select-none">
      {zoomed && (
        <button
          type="button"
          onClick={reset}
          className="absolute top-0 right-2 z-10 rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Reset zoom
        </button>
      )}
      <div role="img" aria-label={label} style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
          <AreaChart
            data={shown}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            onMouseDown={start}
            onMouseMove={move}
            onMouseUp={end}
            onMouseLeave={cancel}
            onDoubleClick={reset}
            onTouchStart={start}
            onTouchMove={move}
            onTouchEnd={end}
            style={{ cursor: drag ? 'col-resize' : 'crosshair' }}
          >
            <CartesianGrid stroke={t.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="x" tickFormatter={formatDay} stroke={t.axis} tick={{ fill: t.axis, fontSize: 11 }} minTickGap={24} />
            <YAxis
              tickFormatter={(v: number) => (valueFormat === 'int' ? formatValue('int', v) : formatTokens(v))}
              allowDecimals={valueFormat !== 'int'}
              stroke={t.axis}
              tick={{ fill: t.axis, fontSize: 11 }}
              width={48}
            />
            <Tooltip
              formatter={(v, name) => [formatValue(valueFormat, Number(v)), String(name)]}
              labelFormatter={(l) => formatDay(String(l))}
              contentStyle={{ background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, color: t.text, fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: t.text }} />
            {series.map((s, i) => (
              <Area key={s} type="linear" dataKey={s} name={seriesLabels?.[s] ?? s} stackId="tokens" stroke={t.color(i, s)} fill={t.color(i, s)} fillOpacity={0.6} isAnimationActive={false} />
            ))}
            {selecting && <ReferenceArea x1={drag!.a} x2={drag!.b!} fill={t.color(0)} fillOpacity={0.15} stroke={t.color(0)} strokeOpacity={0.4} ifOverflow="discard" />}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {!zoomed && data.length > 2 && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Drag to zoom.</p>}
      {zoomed && first && last && (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Zoomed to {formatDay(first)}–{formatDay(last)}. Double-click to reset.
        </p>
      )}
    </div>
  );
}
