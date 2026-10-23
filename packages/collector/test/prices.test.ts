import { DEFAULT_MODEL_PRICES as DB_PRICES } from '@ai-obs/db';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_PRICES, estimateUsageCost } from '../src/prices.js';
import type { UsageEntry } from '../src/protocol-types.js';

const usage = (model: string, o: Partial<UsageEntry> = {}): UsageEntry => ({
  model,
  effort: null,
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  reasoning: 0,
  requests: 1,
  ...o,
});

describe('local price table (ADR-0027)', () => {
  it('is a copy of the db default prices, in the same order', () => {
    expect(DB_PRICES.every((p) => p.effectiveFrom === '2026-01-01')).toBe(true);
    const asNumbers = DB_PRICES.map((p) => ({
      model: p.model,
      input: Number(p.inputPerMtok),
      output: Number(p.outputPerMtok),
      cacheRead: Number(p.cacheReadPerMtok),
      cacheWrite: Number(p.cacheWritePerMtok),
    }));
    expect(DEFAULT_MODEL_PRICES).toEqual(asNumbers);
    expect(DEFAULT_MODEL_PRICES).toHaveLength(14);
  });

  it('costs a known model with the db formula: cache reads and writes at their own rates', () => {
    // claude-opus-5-5: 4 / 20 / 0.2 / 5 per Mtok
    const c = estimateUsageCost([usage('claude-opus-5-5', { input: 1_000_000, output: 500_000, cache_read: 2_000_000, cache_write: 100_000 })]);
    expect(c.usd).toBeCloseTo(4 + 10 + 0.4 + 0.5, 10);
    expect(c.partial).toBe(false);
    expect(c.unknownModels).toEqual([]);
  });

  it('does not bill reasoning tokens again (they are part of output)', () => {
    const base = estimateUsageCost([usage('gpt-5.5', { output: 1000 })]).usd;
    const withReasoning = estimateUsageCost([usage('gpt-5.5', { output: 1000, reasoning: 800 })]).usd;
    expect(withReasoning).toBe(base);
  });

  it('sums several models', () => {
    const c = estimateUsageCost([usage('gpt-5.5', { input: 1_000_000 }), usage('claude-haiku-4-5', { output: 1_000_000 })]);
    expect(c.usd).toBeCloseTo(5 + 5, 10);
  });

  it('marks a partial cost when some model has no price, and n/a (null) when none has', () => {
    const partial = estimateUsageCost([usage('gpt-5.5', { input: 1_000_000 }), usage('mystery-1', { input: 5 }), usage('mystery-1', { input: 5 })]);
    expect(partial).toEqual({ usd: 5, partial: true, unknownModels: ['mystery-1'] });
    expect(estimateUsageCost([usage('mystery-1', { input: 5 })])).toEqual({ usd: null, partial: false, unknownModels: ['mystery-1'] });
    expect(estimateUsageCost([])).toEqual({ usd: 0, partial: false, unknownModels: [] });
  });

  it('matches the model name exactly', () => {
    expect(estimateUsageCost([usage('claude-opus-5-5-20260101', { input: 1000 })]).usd).toBeNull();
  });
});
