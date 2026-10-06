import { costUsd, totalTokens, type PriceIndex } from '../lib/cost.js';

export type BudgetKind = 'tokens' | 'cost';
export type Threshold = 80 | 100;

/** Tokens of one model on one UTC day (from a rollup row or from raw usage). */
export interface DayModelUsage {
  day: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface MeasureResult {
  value: number;
  /** Models with usage but no price on that day (their cost counts as 0). */
  unpriced: string[];
}

/** Month-to-date value of a budget: total tokens, or ≈ USD at the price in effect on each usage day. */
export function measureUsage(rows: DayModelUsage[], kind: BudgetKind, prices: PriceIndex): MeasureResult {
  let value = 0;
  const unpriced = new Set<string>();
  for (const r of rows) {
    if (kind === 'tokens') {
      value += totalTokens(r);
      continue;
    }
    const c = costUsd(prices, r.model, r.day, r);
    if (c === null) unpriced.add(r.model);
    else value += c;
  }
  return { value, unpriced: [...unpriced].sort() };
}

export interface BudgetMarks {
  /** First day of the month the marks belong to. */
  notifiedPeriod: string | null;
  notified80: boolean;
  notified100: boolean;
}

export interface BudgetDecision {
  /** The marks belong to an older period: clear them and stamp the current one before anything else. */
  reset: boolean;
  /** Which mail to send now, if any. Crossing 100 % straight away sends only the 100 % mail. */
  send: Threshold | null;
}

/** Exactly-once threshold logic per period (BRIEF §9). `period` is the first day of the current month. */
export function decideBudget(input: { period: string; limit: number; used: number; marks: BudgetMarks }): BudgetDecision {
  const { period, limit, used, marks } = input;
  const reset = marks.notifiedPeriod !== period;
  const n80 = reset ? false : marks.notified80;
  const n100 = reset ? false : marks.notified100;
  let send: Threshold | null = null;
  if (limit > 0) {
    if (used >= limit) {
      if (!n100) send = 100;
    } else if (used >= limit * 0.8 && !n80) {
      send = 80;
    }
  }
  return { reset, send };
}
