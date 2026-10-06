'use client';

import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useChartTheme } from '../chart-theme';
import { formatDay, formatTokens, formatValue, type ValueFormat } from '../format';

/** One row per x (a day) with a number per series, e.g. `{ x: '2026-10-01', 'claude-opus-5-5': 1200, … }`. */
export type SeriesRow = { x: string } & Record<string, number | string>;

/** Stacked area over time, e.g. tokens by model (or any count with `valueFormat`). */
export function TokensAreaChart({
  data,
  series,
  height = 280,
  valueFormat = 'tokens',
  ariaLabel = 'Stacked area chart of tokens over time by model',
}: {
  data: SeriesRow[];
  series: string[];
  height?: number;
  valueFormat?: ValueFormat;
  ariaLabel?: string;
}) {
  const t = useChartTheme();
  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
            <Area key={s} type="linear" dataKey={s} stackId="tokens" stroke={t.color(i, s)} fill={t.color(i, s)} fillOpacity={0.6} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
