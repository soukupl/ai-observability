import type { UsageEntry } from '@ai-obs/protocol';

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
}

export interface UsageRow extends TokenTotals {
  model: string;
  effort: string | null;
}

const ZERO: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 };

/** Collapses entries with the same model × effort (the usage table has one row per pair). */
export function mergeUsage(entries: readonly UsageEntry[]): UsageRow[] {
  const byKey = new Map<string, UsageRow>();
  for (const e of entries) {
    const key = JSON.stringify([e.model, e.effort]);
    const row = byKey.get(key) ?? { model: e.model, effort: e.effort, ...ZERO };
    row.input += e.input;
    row.output += e.output;
    row.cacheRead += e.cache_read;
    row.cacheWrite += e.cache_write;
    row.reasoning += e.reasoning;
    row.requests += e.requests;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

/** Sum of all rows (token convention: input excludes cache; reasoning is part of output). */
export function sumUsage(rows: readonly TokenTotals[]): TokenTotals {
  return rows.reduce<TokenTotals>(
    (a, r) => ({
      input: a.input + r.input,
      output: a.output + r.output,
      cacheRead: a.cacheRead + r.cacheRead,
      cacheWrite: a.cacheWrite + r.cacheWrite,
      reasoning: a.reasoning + r.reasoning,
      requests: a.requests + r.requests,
    }),
    { ...ZERO },
  );
}
