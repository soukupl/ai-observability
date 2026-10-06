'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useChartTheme } from '../chart-theme';
import { formatValue, type ValueFormat } from '../format';

export interface StackedRow {
  label: string;
  values: Record<string, number>;
}

/** 100 % stacked horizontal bars: how each row's total splits over `keys` (e.g. phases per team). */
export function StackedBar100({
  rows,
  keys,
  valueFormat,
  barHeight = 34,
  labelWidth = 130,
  ariaLabel = '100 percent stacked bars',
}: {
  rows: StackedRow[];
  keys: string[];
  /** Formats the absolute value in the tooltip (e.g. 'duration'). */
  valueFormat: ValueFormat;
  barHeight?: number;
  labelWidth?: number;
  ariaLabel?: string;
}) {
  const t = useChartTheme();
  const data = rows.map((r) => ({ label: r.label, ...r.values }));
  const totals = new Map(rows.map((r) => [r.label, Object.values(r.values).reduce((a, b) => a + b, 0)]));
  const height = Math.max(120, rows.length * barHeight + 70);
  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
        <BarChart data={data} layout="vertical" stackOffset="expand" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={t.grid} strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tickFormatter={(v: number) => `${Math.round(v * 100)}%`} stroke={t.axis} tick={{ fill: t.axis, fontSize: 11 }} />
          <YAxis type="category" dataKey="label" width={labelWidth} stroke={t.axis} tick={{ fill: t.text, fontSize: 12 }} interval={0} />
          <Tooltip
            cursor={{ fill: t.grid, opacity: 0.4 }}
            formatter={(v, name, item) => {
              const total = totals.get(String((item?.payload as { label?: string } | undefined)?.label)) ?? 0;
              const share = total > 0 ? Math.round((Number(v) / total) * 100) : 0;
              return [`${formatValue(valueFormat, Number(v))} (${share}%)`, String(name)];
            }}
            contentStyle={{ background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, color: t.text, fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: t.text }} />
          {keys.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="share" fill={t.color(i, k)} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
