import type { Database } from './client.js';
import { modelPrices } from './schema/index.js';

type Price = typeof modelPrices.$inferInsert;
const p = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number): Price => ({
  model,
  effectiveFrom: '2026-01-01',
  inputPerMtok: String(input),
  outputPerMtok: String(output),
  cacheReadPerMtok: String(cacheRead),
  cacheWritePerMtok: String(cacheWrite),
});

/**
 * Default API list prices, USD per million tokens (BRIEF §7 "Cost"). Anthropic cache writes are the
 * 5-minute rate (1.25x input); OpenAI bills no cache writes. Verify against the vendors' pricing pages
 * before relying on them; the super admin can edit rows, and newer rows (later effective_from) win.
 */
export const DEFAULT_MODEL_PRICES: Price[] = [
  p('claude-fable-5-1', 10, 50, 0.25, 12.5),
  p('claude-fable-5', 10, 50, 1, 12.5),
  p('claude-opus-5-5', 4, 20, 0.2, 5),
  p('claude-opus-5', 5, 25, 0.5, 6.25),
  p('claude-opus-4-8', 5, 25, 0.5, 6.25),
  p('claude-opus-4-7', 5, 25, 0.5, 6.25),
  p('claude-opus-4-6', 5, 25, 0.5, 6.25),
  p('claude-sonnet-5-5', 2, 10, 0.2, 2.5),
  p('claude-sonnet-5', 2, 10, 0.2, 2.5),
  p('claude-sonnet-4-6', 3, 15, 0.3, 3.75),
  p('claude-haiku-4-5', 1, 5, 0.1, 1.25),
  p('gpt-5.5', 5, 30, 0.5, 0),
  p('gpt-5.4', 2.5, 15, 0.25, 0),
  p('gpt-5.4-mini', 0.75, 4.5, 0.075, 0),
];

/** Inserts missing default prices; never overwrites rows an operator has edited. */
export async function ensureDefaultModelPrices(db: Database): Promise<number> {
  const inserted = await db
    .insert(modelPrices)
    .values(DEFAULT_MODEL_PRICES)
    .onConflictDoNothing({ target: [modelPrices.model, modelPrices.effectiveFrom] })
    .returning({ id: modelPrices.id });
  return inserted.length;
}

/**
 * The price row in effect on `day` (YYYY-MM-DD) among one model's rows (any order): the newest row
 * with effectiveFrom <= day; for a day before the earliest row, that earliest row (so history older
 * than the first price is still costed). undefined only when there are no rows. Same rule as the SQL
 * function estimate_cost_usd (migration 0003); dashboard and worker lookups should use it too.
 */
export function priceInEffect<T extends { effectiveFrom: string }>(rows: readonly T[], day: string): T | undefined {
  let current: T | undefined;
  let earliest: T | undefined;
  for (const r of rows) {
    if (!earliest || r.effectiveFrom < earliest.effectiveFrom) earliest = r;
    if (r.effectiveFrom <= day && (!current || r.effectiveFrom > current.effectiveFrom)) current = r;
  }
  return current ?? earliest;
}

/** ≈ cost in USD (same formula as the SQL function estimate_cost_usd). */
export function estimateCostUsd(
  price: Pick<Price, 'inputPerMtok' | 'outputPerMtok' | 'cacheReadPerMtok' | 'cacheWritePerMtok'>,
  t: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  return (
    (t.input * Number(price.inputPerMtok) +
      t.output * Number(price.outputPerMtok) +
      t.cacheRead * Number(price.cacheReadPerMtok) +
      t.cacheWrite * Number(price.cacheWritePerMtok)) /
    1_000_000
  );
}

