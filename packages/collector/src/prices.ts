import type { UsageEntry } from './protocol-types.js';

/** One model's API list price, USD per million tokens. */
export interface ModelPrice {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const p = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number): ModelPrice => ({ model, input, output, cacheRead, cacheWrite });

/**
 * Copy of DEFAULT_MODEL_PRICES in packages/db/src/prices.ts (USD/Mtok); test/prices.test.ts keeps them equal.
 * Operator-edited rows are not visible locally, so `ai-obs live` shows "≈ at default list prices" (ADR-0027).
 */
export const DEFAULT_MODEL_PRICES: readonly ModelPrice[] = [
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

const BY_MODEL = new Map(DEFAULT_MODEL_PRICES.map((r) => [r.model, r]));

/**
 * ≈ cost, same formula as db estimateCostUsd (prices.ts); reasoning is part of output, not billed again.
 * Exact model match. `usd` is null when every model is unknown (and there is usage), `partial` when some are.
 */
export function estimateUsageCost(usage: readonly UsageEntry[]): { usd: number | null; partial: boolean; unknownModels: string[] } {
  let usd = 0;
  let known = 0;
  const unknown = new Set<string>();
  for (const u of usage) {
    const price = BY_MODEL.get(u.model);
    if (!price) {
      unknown.add(u.model);
      continue;
    }
    known++;
    usd += (u.input * price.input + u.output * price.output + u.cache_read * price.cacheRead + u.cache_write * price.cacheWrite) / 1_000_000;
  }
  const unknownModels = [...unknown].sort();
  if (usage.length && !known) return { usd: null, partial: false, unknownModels };
  return { usd, partial: unknownModels.length > 0, unknownModels };
}
