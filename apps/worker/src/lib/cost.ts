/** Cost math at API list prices (BRIEF §7). Same formula as the SQL function estimate_cost_usd. */
export interface PriceRow {
  model: string;
  /** 'YYYY-MM-DD' */
  effectiveFrom: string;
  inputPerMtok: string | number;
  outputPerMtok: string | number;
  cacheReadPerMtok: string | number;
  cacheWritePerMtok: string | number;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** model -> price rows, newest effective_from first. */
export type PriceIndex = Map<string, PriceRow[]>;

export function indexPrices(rows: PriceRow[]): PriceIndex {
  const index: PriceIndex = new Map();
  for (const row of rows) {
    const list = index.get(row.model) ?? [];
    list.push(row);
    index.set(row.model, list);
  }
  for (const list of index.values()) list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return index;
}

/**
 * The price row in effect on `day`: the newest row with effective_from <= day; for a day before the
 * model's earliest row, that earliest row (DP-03; same rule as estimate_cost_usd and priceInEffect()).
 */
export function priceOn(index: PriceIndex, model: string, day: string): PriceRow | undefined {
  const list = index.get(model);
  return list?.find((p) => p.effectiveFrom <= day) ?? list?.at(-1);
}

/** ≈ USD for these tokens on `day`; null when no price is known for the model on that day. */
export function costUsd(index: PriceIndex, model: string, day: string, t: TokenCounts): number | null {
  const p = priceOn(index, model, day);
  if (!p) return null;
  return (
    (t.input * Number(p.inputPerMtok) +
      t.output * Number(p.outputPerMtok) +
      t.cacheRead * Number(p.cacheReadPerMtok) +
      t.cacheWrite * Number(p.cacheWritePerMtok)) /
    1_000_000
  );
}

/** Total tokens for a token budget: everything the harness processed (input, output, cache reads and writes). */
export const totalTokens = (t: TokenCounts): number => t.input + t.output + t.cacheRead + t.cacheWrite;
