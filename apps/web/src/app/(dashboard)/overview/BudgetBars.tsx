import { Card } from '@/components/Card';
import { formatTokens, formatUsd } from '@/components/format';
import type { BudgetsResult } from '@/lib/queries/budgets';
import { barWidth, budgetLabel, sortBudgets } from './helpers';

const FILL = { ok: 'bg-emerald-500', warn: 'bg-amber-500', over: 'bg-red-500', unknown: 'bg-zinc-400' } as const;
const LEVEL_TEXT = { ok: 'on track', warn: 'over 80 %', over: 'over budget', unknown: 'no price yet' } as const;

export function BudgetBars({ budgets }: { budgets: BudgetsResult }) {
  const rows = sortBudgets(budgets.rows);
  const fmt = (b: (typeof rows)[number], v: number) => (b.kind === 'cost' ? `≈ ${formatUsd(v)}` : formatTokens(v));
  return (
    <Card title="Budgets this month" description={`Month starting ${budgets.month} (UTC). Cost at API list prices.`}>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No budgets set for you or your teams.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((b) => (
            <li key={b.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">
                  {budgetLabel(b)} <span className="text-xs font-normal text-zinc-500">({b.kind})</span>
                </span>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">
                  {b.used === null ? 'n/a' : fmt(b, b.used)} / {fmt(b, b.limit)}
                  {b.fraction !== null && ` · ${Math.round(b.fraction * 100)} %`} · {LEVEL_TEXT[b.level]}
                  {b.partialCost && ' · some models unpriced'}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={`${budgetLabel(b)} budget`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(barWidth(b.fraction))}
                className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
              >
                <div className={`h-full ${FILL[b.level]}`} style={{ width: `${barWidth(b.fraction)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {budgets.hiddenUserBudgets > 0 && (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          {budgets.hiddenUserBudgets} personal budget(s) are not shown (aggregates-only mode).
        </p>
      )}
    </Card>
  );
}
