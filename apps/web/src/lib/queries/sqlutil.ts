import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '@ai-obs/db';
import type { CostTokens } from '../cost';

/** Runs a query and returns its rows as a plain array. */
export async function rows<T>(tx: Tx, q: SQL): Promise<T[]> {
  return Array.from((await tx.execute(q)) as unknown as T[]);
}

/** bigint / numeric come back as strings from the driver. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function where(conds: SQL[]): SQL {
  return conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
}

/** Token counts as the queries return them (all kinds, plus reasoning which is part of output). */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  /** input + output + cacheRead + cacheWrite (reasoning is already inside output). */
  total: number;
}

export const emptyTokens = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });

export function addTokens(into: TokenTotals, t: Omit<TokenTotals, 'total'> & Partial<Pick<TokenTotals, 'total'>>): TokenTotals {
  into.input += t.input;
  into.output += t.output;
  into.cacheRead += t.cacheRead;
  into.cacheWrite += t.cacheWrite;
  into.reasoning += t.reasoning;
  into.total = into.input + into.output + into.cacheRead + into.cacheWrite;
  return into;
}

/** Token columns of a raw DB row (snake_case) -> TokenTotals. */
export function tokensOf(r: Record<string, unknown>): TokenTotals {
  return addTokens(emptyTokens(), {
    input: num(r.input_tokens),
    output: num(r.output_tokens),
    cacheRead: num(r.cache_read_tokens),
    cacheWrite: num(r.cache_write_tokens),
    reasoning: num(r.reasoning_tokens),
  });
}

export const costTokens = (t: TokenTotals): CostTokens => ({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite });

/** success / (turns - unknown); null when nothing is decided yet. unknownShare is reported next to it. */
export function outcomeRates(o: { success: number; failed: number; abandoned: number; unknown: number }) {
  const total = o.success + o.failed + o.abandoned + o.unknown;
  const decided = total - o.unknown;
  return {
    successRate: decided > 0 ? o.success / decided : null,
    unknownShare: total > 0 ? o.unknown / total : null,
  };
}

export interface Outcomes {
  success: number;
  failed: number;
  abandoned: number;
  unknown: number;
}
export const emptyOutcomes = (): Outcomes => ({ success: 0, failed: 0, abandoned: 0, unknown: 0 });

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Caps for work done in JS over agg_* output (those functions return at most 1000 rows per call). */
export const AGG_PAGE = 1000;
