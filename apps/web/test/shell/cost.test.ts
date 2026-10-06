import { describe, expect, it } from 'vitest';
import { CostSum, PriceBook, ZERO_COST, type PriceRow } from '../../src/lib/cost';

const price = (model: string, effectiveFrom: string, i: number, o: number, cr: number, cw: number): PriceRow => ({
  model, effectiveFrom, inputPerMtok: i, outputPerMtok: o, cacheReadPerMtok: cr, cacheWritePerMtok: cw,
});
const book = new PriceBook([
  price('opus', '2026-06-01', 10, 50, 1, 12.5), // newer row listed first on purpose
  price('opus', '2026-01-01', 5, 25, 0.5, 6.25),
  price('haiku', '2026-01-01', 1, 5, 0.1, 1.25),
]);
const tok = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };

describe('PriceBook', () => {
  it('prices every token kind per million tokens', () => {
    expect(book.cost('haiku', '2026-03-01', tok)).toEqual({ usd: 1 + 5 + 0.1 + 1.25, unknown: false });
    expect(book.cost('haiku', '2026-03-01', { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 }).usd).toBeCloseTo(0.5);
  });

  it('picks the row effective on the day', () => {
    expect(book.priceFor('opus', '2026-05-31')?.inputPerMtok).toBe(5);
    expect(book.priceFor('opus', '2026-06-01')?.inputPerMtok).toBe(10); // effective_from itself counts
    expect(book.priceFor('opus', '2026-12-31')?.inputPerMtok).toBe(10);
    expect(book.cost('opus', '2026-05-31', tok).usd).toBeCloseTo(5 + 25 + 0.5 + 6.25);
    expect(book.cost('opus', '2026-06-02', tok).usd).toBeCloseTo(10 + 50 + 1 + 12.5);
  });

  it("uses the model's earliest row for days before its first effective_from (DP-03)", () => {
    expect(book.priceFor('opus', '2025-12-31')?.inputPerMtok).toBe(5);
    expect(book.cost('opus', '2025-12-31', tok).usd).toBeCloseTo(5 + 25 + 0.5 + 6.25);
    expect(book.priceFor('nope', '2025-12-31')).toBeNull();
  });

  it('flags an unknown or missing model as n/a, never as $0', () => {
    expect(book.cost('mystery', '2026-03-01', tok)).toEqual({ usd: null, unknown: true });
    expect(book.cost(null, '2026-03-01', tok)).toEqual({ usd: null, unknown: true });
    expect(book.cost('', '2026-03-01', tok).unknown).toBe(true);
  });
});

describe('CostSum', () => {
  it('adds known groups', () => {
    const s = new CostSum(book);
    s.add('haiku', '2026-03-01', tok);
    s.add('haiku', '2026-03-02', tok);
    expect(s.value()).toEqual({ usd: 2 * 7.35, partial: false, unknownModels: [] });
  });

  it('is partial when some models are unknown, and n/a when all are', () => {
    const s = new CostSum(book);
    s.add('haiku', '2026-03-01', tok);
    s.add('mystery', '2026-03-01', tok);
    expect(s.value()).toMatchObject({ usd: 7.35, partial: true, unknownModels: ['mystery'] });

    const all = new CostSum(book);
    all.add('mystery', '2026-03-01', tok);
    all.add(null, '2026-03-01', tok);
    expect(all.value()).toEqual({ usd: null, partial: false, unknownModels: ['(none)', 'mystery'] });
  });

  it('an empty sum is $0, not n/a', () => {
    expect(new CostSum(book).value()).toMatchObject({ usd: 0, partial: false });
    expect(ZERO_COST.usd).toBe(0);
  });
});
