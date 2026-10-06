'use client';

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useChartTheme } from '../chart-theme';
import { formatDuration } from '../format';

export interface TimelineBar {
  id: string;
  label: string;
  /** Nesting level: 0 = main agent. Shown as indentation and colour. */
  depth: number;
  offsetMs: number;
  durationMs: number;
  outcome: string | null;
}

/** Gantt-style run timeline of one turn: one bar per run, positioned by its start offset. */
export function Timeline({ items, totalMs, rowHeight = 30 }: { items: TimelineBar[]; totalMs: number; rowHeight?: number }) {
  const t = useChartTheme();
  const data = items.map((it) => ({
    ...it,
    name: `${'  '.repeat(it.depth)}${it.label}`,
    // Recharts "floating" bar: an invisible spacer stacked below the visible duration.
    spacer: it.offsetMs,
    span: Math.max(it.durationMs, totalMs / 400),
  }));
  const height = Math.max(100, items.length * rowHeight + 50);
  return (
    <div role="img" aria-label="Timeline of the turn's agent runs" style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 0 }} barCategoryGap={4}>
          <CartesianGrid stroke={t.grid} strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" domain={[0, Math.max(totalMs, 1)]} tickFormatter={(v: number) => formatDuration(v)} stroke={t.axis} tick={{ fill: t.axis, fontSize: 11 }} />
          <YAxis type="category" dataKey="name" width={140} stroke={t.axis} tick={{ fill: t.text, fontSize: 12 }} interval={0} />
          <Tooltip
            cursor={{ fill: t.grid, opacity: 0.3 }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!active || !p) return null;
              return (
                <div style={{ background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}`, color: t.text, fontSize: 12, padding: '6px 8px', borderRadius: 6 }}>
                  <div style={{ fontWeight: 600 }}>{p.label}</div>
                  <div>
                    starts +{formatDuration(p.offsetMs)}, runs {formatDuration(p.durationMs)}
                  </div>
                  {p.outcome && <div>outcome: {p.outcome}</div>}
                </div>
              );
            }}
          />
          <Bar dataKey="spacer" stackId="t" fill="transparent" isAnimationActive={false} legendType="none" />
          <Bar dataKey="span" stackId="t" radius={3} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.id} fill={d.outcome === 'failed' ? t.color(0, 'failed') : t.color(d.depth)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
