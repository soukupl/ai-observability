import type { BudgetProgress } from '@/lib/queries/budgets';

export const OUTCOME_ORDER = ['success', 'failed', 'abandoned', 'unknown'] as const;
export type OutcomeKey = (typeof OUTCOME_ORDER)[number];

export interface OutcomeSlice {
  key: OutcomeKey;
  count: number;
  share: number;
}

/** Shares of all turns per outcome (unknown included, never hidden). Empty when there are no turns. */
export function outcomeSlices(outcomes: Record<OutcomeKey, number>): OutcomeSlice[] {
  const total = OUTCOME_ORDER.reduce((s, k) => s + (outcomes[k] ?? 0), 0);
  if (total <= 0) return [];
  return OUTCOME_ORDER.map((key) => ({ key, count: outcomes[key] ?? 0, share: (outcomes[key] ?? 0) / total }));
}

/** Bar width in percent, clamped to 0..100 (usage over the limit fills the bar). */
export function barWidth(fraction: number | null): number {
  if (fraction === null || !Number.isFinite(fraction)) return 0;
  return Math.min(100, Math.max(0, fraction * 100));
}

/** Own budget first, then teams, then names. */
export function sortBudgets(rows: BudgetProgress[]): BudgetProgress[] {
  const rank = (b: BudgetProgress) => (b.scope === 'user' && b.isMine ? 0 : b.scope === 'team' ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.teamName ?? a.userName ?? '').localeCompare(b.teamName ?? b.userName ?? ''));
}

export function budgetLabel(b: BudgetProgress): string {
  if (b.scope === 'user') return b.isMine ? 'My budget' : (b.userName ?? 'User budget');
  return b.teamName ?? 'Team budget';
}

/**
 * Rows for the stacked area chart: one per day, with EVERY series key present (0 when the model was idle
 * that day). Recharts breaks a stack on a missing key, which drew gaps and spikes (review V1).
 */
export function zeroFilledChartRows(
  points: { day: string; byModel: Record<string, number> }[],
  models: string[],
): ({ x: string } & Record<string, number | string>)[] {
  return points.map((p) => {
    const row: { x: string } & Record<string, number | string> = { x: p.day };
    for (const m of models) row[m] = p.byModel[m] ?? 0;
    return row;
  });
}
