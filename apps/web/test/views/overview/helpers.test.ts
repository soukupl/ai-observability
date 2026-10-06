import { describe, expect, it } from 'vitest';
import { barWidth, budgetLabel, outcomeSlices, sortBudgets, zeroFilledChartRows } from '../../../src/app/(dashboard)/overview/helpers';
import type { BudgetProgress } from '../../../src/lib/queries/budgets';

const b = (o: Partial<BudgetProgress>): BudgetProgress => ({
  id: 'x', scope: 'team', teamId: 't', teamName: 'Team', isMine: false, kind: 'tokens', limit: 100, used: 10, fraction: 0.1, level: 'ok', partialCost: false, ...o,
});

describe('outcomeSlices', () => {
  it('is empty without turns', () => expect(outcomeSlices({ success: 0, failed: 0, abandoned: 0, unknown: 0 })).toEqual([]));
  it('keeps unknown and sums to 1', () => {
    const s = outcomeSlices({ success: 5, failed: 1, abandoned: 0, unknown: 4 });
    expect(s.map((x) => x.key)).toEqual(['success', 'failed', 'abandoned', 'unknown']);
    expect(s[3]!.share).toBeCloseTo(0.4);
    expect(s.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1);
  });
});

describe('barWidth', () => {
  it.each([[null, 0], [0.5, 50], [1.7, 100], [-1, 0], [Number.NaN, 0]])('%s -> %s', (f, w) => expect(barWidth(f)).toBe(w));
});

describe('sortBudgets / budgetLabel', () => {
  it('own budget first, then teams by name', () => {
    const rows = [b({ id: 'b', teamName: 'B' }), b({ id: 'me', scope: 'user', isMine: true, teamName: null }), b({ id: 'a', teamName: 'A' })];
    expect(sortBudgets(rows).map((r) => r.id)).toEqual(['me', 'a', 'b']);
    expect(budgetLabel(rows[1]!)).toBe('My budget');
    expect(budgetLabel(rows[0]!)).toBe('B');
  });
});

describe('zeroFilledChartRows (review V1)', () => {
  const points = [
    { day: '2026-09-14', byModel: { a: 10 } },
    { day: '2026-09-15', byModel: {} },
    { day: '2026-09-16', byModel: { b: 5, a: 1 } },
  ];
  it('has every series key on every day, 0 when the model was idle', () => {
    const rows = zeroFilledChartRows(points, ['a', 'b']);
    expect(rows).toEqual([
      { x: '2026-09-14', a: 10, b: 0 },
      { x: '2026-09-15', a: 0, b: 0 },
      { x: '2026-09-16', a: 1, b: 5 },
    ]);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['a', 'b', 'x']);
  });
  it('keeps one row per day and drops keys that are not series', () => {
    expect(zeroFilledChartRows(points, ['a'])).toHaveLength(3);
    expect(zeroFilledChartRows(points, ['a'])[2]).toEqual({ x: '2026-09-16', a: 1 });
    expect(zeroFilledChartRows([], ['a'])).toEqual([]);
  });
});
