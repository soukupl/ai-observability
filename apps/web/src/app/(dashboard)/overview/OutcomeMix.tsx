import { Card } from '@/components/Card';
import { formatInt, formatPercent } from '@/components/format';
import { OUTCOME_ORDER, outcomeSlices, type OutcomeKey } from './helpers';

const COLOR: Record<OutcomeKey, string> = {
  success: 'bg-emerald-500',
  failed: 'bg-red-500',
  abandoned: 'bg-amber-500',
  unknown: 'bg-zinc-400 dark:bg-zinc-600',
};

export function OutcomeMix({ outcomes, approximate }: { outcomes: Record<OutcomeKey, number>; approximate: boolean }) {
  const slices = outcomeSlices(outcomes);
  return (
    <Card title="Outcome mix" description={approximate ? 'Share of turns, from a sample of recent turns.' : 'Share of turns.'}>
      {slices.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No turns in range.</p>
      ) : (
        <>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" role="img" aria-label={slices.map((s) => `${s.key} ${formatPercent(s.share)}`).join(', ')}>
            {slices.filter((s) => s.share > 0).map((s) => (
              <div key={s.key} className={COLOR[s.key]} style={{ width: `${s.share * 100}%` }} title={`${s.key}: ${formatInt(s.count)}`} />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-700 dark:text-zinc-300">
            {OUTCOME_ORDER.map((k) => {
              const s = slices.find((x) => x.key === k)!;
              return (
                <li key={k} className="flex items-center gap-1.5">
                  <span className={`inline-block size-2.5 rounded-sm ${COLOR[k]}`} />
                  {k} {formatPercent(s.share, 1)} <span className="text-zinc-500">({formatInt(s.count)})</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}
