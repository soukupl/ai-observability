import type { ReactNode } from 'react';
import { Sparkline } from './charts/Sparkline';

/** One headline number. `sub` is the small line under it (e.g. "12% unknown"); `title` is a tooltip. */
export function KpiTile({
  label,
  value,
  sub,
  title,
  tone = 'default',
  spark,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  title?: string;
  tone?: 'default' | 'good' | 'warn' | 'bad';
  /** optional small trend line under the value */
  spark?: number[];
}) {
  const toneClass = {
    default: 'text-zinc-900 dark:text-zinc-50',
    good: 'text-emerald-700 dark:text-emerald-400',
    warn: 'text-amber-700 dark:text-amber-400',
    bad: 'text-red-700 dark:text-red-400',
  }[tone];
  return (
    <div title={title} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xs dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
      {spark && spark.length > 1 && (
        <div className="mt-1">
          <Sparkline values={spark} width={120} height={24} />
        </div>
      )}
    </div>
  );
}
