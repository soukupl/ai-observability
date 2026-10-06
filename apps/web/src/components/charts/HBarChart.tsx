'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useChartTheme } from '../chart-theme';
import { formatValue, type ValueFormat } from '../format';

export interface HBarDatum {
  label: string;
  value: number;
}

/** Horizontal bars, one per category (e.g. cost per model x effort). `valueFormat` must match what `value` measures. */
export function HBarChart({
  data,
  valueFormat = 'tokens',
  barHeight = 28,
  labelWidth = 150,
  ariaLabel = 'Bar chart',
}: {
  data: HBarDatum[];
  valueFormat?: ValueFormat;
  barHeight?: number;
  labelWidth?: number;
  ariaLabel?: string;
}) {
  const t = useChartTheme();
  const height = Math.max(80, data.length * barHeight + 36);
  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={t.grid} strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tickFormatter={(v: number) => formatValue(valueFormat, v)} stroke={t.axis} tick={{ fill: t.axis, fontSize: 11 }} />
          <YAxis type="category" dataKey="label" width={labelWidth} stroke={t.axis} tick={{ fill: t.text, fontSize: 12 }} interval={0} />
          <Tooltip
            cursor={{ fill: t.grid, opacity: 0.4 }}
            formatter={(v) => [formatValue(valueFormat, Number(v)), '']}
            contentStyle={{ background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, color: t.text, fontSize: 12 }}
          />
          <Bar dataKey="value" fill={t.color(0)} radius={[0, 3, 3, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
