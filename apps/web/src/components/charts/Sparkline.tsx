'use client';

import { Line, LineChart, YAxis } from 'recharts';
import { useChartTheme } from '../chart-theme';

/** Tiny trend line for table cells. Fixed size (no ResponsiveContainer), so hundreds of rows stay cheap. */
export function Sparkline({ values, width = 96, height = 28, color }: { values: number[]; width?: number; height?: number; color?: string }) {
  const theme = useChartTheme();
  const data = values.map((v, i) => ({ i, v }));
  if (data.length === 0 || data.every((d) => d.v === 0)) {
    return <span className="text-xs text-zinc-400" aria-label="no activity">—</span>;
  }
  return (
    <LineChart width={width} height={height} data={data} margin={{ top: 3, right: 2, bottom: 3, left: 2 }} role="img" aria-label={`trend of ${values.length} days`}>
      <YAxis hide domain={[0, 'dataMax']} />
      <Line type="monotone" dataKey="v" stroke={color ?? theme.color(0)} strokeWidth={1.5} dot={false} isAnimationActive={false} />
    </LineChart>
  );
}
