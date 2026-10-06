import { describe, expect, it } from 'vitest';
import { costUsd, indexPrices, priceOn, totalTokens, type PriceRow } from '../src/lib/cost.js';

const p = (model: string, effectiveFrom: string, input: number, output: number, cr = 0, cw = 0): PriceRow => ({
  model, effectiveFrom, inputPerMtok: String(input), outputPerMtok: String(output),
  cacheReadPerMtok: String(cr), cacheWritePerMtok: String(cw),
});
const prices = indexPrices([p('opus', '2026-01-01', 5, 25, 0.5, 6.25), p('opus', '2026-06-01', 4, 20, 0.2, 5), p('gpt', '2026-01-01', 2.5, 15, 0.25, 0)]);

describe('cost math', () => {
  it('picks the newest price effective on or before the day', () => {
    expect(priceOn(prices, 'opus', '2026-05-31')?.effectiveFrom).toBe('2026-01-01');
    expect(priceOn(prices, 'opus', '2026-06-01')?.effectiveFrom).toBe('2026-06-01');
    expect(priceOn(prices, 'opus', '2026-12-31')?.effectiveFrom).toBe('2026-06-01');
    expect(priceOn(prices, 'opus', '2025-12-31')?.effectiveFrom).toBe('2026-01-01'); // before the first row: the earliest row
    expect(priceOn(prices, 'nope', '2026-06-01')).toBeUndefined();
  });

  it('prices each token kind per million tokens (reasoning is part of output, never added)', () => {
    // 1M input @5 + 100k output @25 + 2M cache read @0.5 + 400k cache write @6.25
    const c = costUsd(prices, 'opus', '2026-02-01', { input: 1e6, output: 1e5, cacheRead: 2e6, cacheWrite: 4e5 });
    expect(c).toBeCloseTo(5 + 2.5 + 1 + 2.5, 9);
  });

  it('uses the price in effect on the usage day, not today', () => {
    const t = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(costUsd(prices, 'opus', '2026-05-01', t)).toBeCloseTo(5);
    expect(costUsd(prices, 'opus', '2026-07-01', t)).toBeCloseTo(4);
  });

  it('returns null for an unpriced model', () => {
    expect(costUsd(prices, 'mystery', '2026-07-01', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  it('totalTokens counts input, output and cache tokens', () => {
    expect(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10);
  });
});
