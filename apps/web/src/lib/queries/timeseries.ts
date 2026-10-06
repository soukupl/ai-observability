import { CostSum, type CostValue } from '../cost';
import type { Filters } from '../filters';
import { dims, rollupFacts, usageDaily } from './providers';
import { eachDay, rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { addTokens, costTokens, emptyTokens, type TokenTotals } from './sqlutil';

export interface TokenSeriesRow {
  day: string;
  model: string;
  tokens: TokenTotals;
  cost: CostValue;
}

export interface TokenSeries {
  range: ResolvedRange;
  /** Models by total tokens, largest first; beyond MAX_SERIES_MODELS they fold into 'other' in `points`. */
  models: string[];
  /** One entry per day of the range (zero-filled): tokens per model, for the stacked area chart. */
  points: { day: string; byModel: Record<string, number>; total: number }[];
  /** Un-folded rows (day x model) with the token kinds and cost: CSV and tables. */
  rows: TokenSeriesRow[];
}

export const MAX_SERIES_MODELS = 8;
export const OTHER_MODELS = 'other';

/** Tokens per day and model, stacked. Raw: usage rows. Rollup source: rollup rows (tokens on the usage row's model, ADR-0015). */
export async function getTokenSeries(ctx: QueryCtx, f: Filters): Promise<TokenSeries> {
  const range = rangeFor(ctx, f);
  const d = dims(ctx, f, range);
  const items =
    range.source === 'rollup'
      ? (await rollupFacts(ctx, d)).filter((x) => x.tokens.total > 0).map((x) => ({ day: x.day, model: x.model, tokens: x.tokens }))
      : (await usageDaily(ctx, d)).map((x) => ({ day: x.day, model: x.model, tokens: x.tokens }));

  const cell = new Map<string, TokenTotals>();
  for (const it of items) {
    const key = `${it.day}\u0000${it.model}`;
    addTokens(cell.get(key) ?? cell.set(key, emptyTokens()).get(key)!, it.tokens);
  }
  const rows: TokenSeriesRow[] = [];
  const modelTotal = new Map<string, number>();
  for (const [key, tokens] of cell) {
    const [day, model] = key.split('\u0000') as [string, string];
    const cs = new CostSum(ctx.prices);
    cs.add(model, day, costTokens(tokens));
    rows.push({ day, model, tokens, cost: cs.value() });
    modelTotal.set(model, (modelTotal.get(model) ?? 0) + tokens.total);
  }
  rows.sort((a, b) => (a.day === b.day ? (a.model < b.model ? -1 : 1) : a.day < b.day ? -1 : 1));

  const models = [...modelTotal.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([m]) => m);
  const shown = new Set(models.slice(0, MAX_SERIES_MODELS));
  const byDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const slot = byDay.get(r.day) ?? byDay.set(r.day, {}).get(r.day)!;
    const key = shown.has(r.model) ? r.model : OTHER_MODELS;
    slot[key] = (slot[key] ?? 0) + r.tokens.total;
  }
  const points = eachDay(range.fromDay, range.toDay).map((day) => {
    const byModel = byDay.get(day) ?? {};
    return { day, byModel, total: Object.values(byModel).reduce((a, b) => a + b, 0) };
  });
  const names = models.slice(0, MAX_SERIES_MODELS);
  if (models.length > MAX_SERIES_MODELS) names.push(OTHER_MODELS);
  return { range, models: names, points, rows };
}
