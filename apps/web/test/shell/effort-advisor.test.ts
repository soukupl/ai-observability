import { describe, expect, it } from 'vitest';
import { ADVISOR_RULES, suggestEfforts, type EffortCell } from '../../src/lib/effort-advisor';

const cell = (effort: string, over: Partial<EffortCell> = {}): EffortCell => ({
  projectId: 'p', model: 'm', effort, turns: 100, decided: 80, success: 60, pricedTurns: 100, medianCostUsd: 1, medianDurationMs: 60_000, ...over,
});

describe('suggestEfforts', () => {
  it('suggests the next lower qualifying level when success holds and cost drops by 20 %+', () => {
    const [s, ...rest] = suggestEfforts([cell('max', { medianCostUsd: 2 }), cell('high', { medianCostUsd: 1.2, success: 58 })]);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ model: 'm', from: { effort: 'max' }, to: { effort: 'high' } });
    expect(s!.costReduction).toBeCloseTo(0.4);
    expect(s!.savingsUsd).toBeCloseTo(80); // (2 - 1.2) × 100 turns
  });

  it('skips pairs that lose more than 5 points of success, save < 20 %, or save < $5', () => {
    expect(suggestEfforts([cell('max', { medianCostUsd: 2 }), cell('high', { medianCostUsd: 1, success: 55 })])).toEqual([]); // 75 % → 68.75 %
    expect(suggestEfforts([cell('max', { medianCostUsd: 1 }), cell('high', { medianCostUsd: 0.85 })])).toEqual([]);
    expect(suggestEfforts([cell('max', { medianCostUsd: 0.05, turns: 40 }), cell('high', { medianCostUsd: 0.01 })])).toEqual([]); // $1.60
  });

  it(`needs ${ADVISOR_RULES.minDecided} decided and priced turns on both sides; compares with the next qualifying level`, () => {
    expect(suggestEfforts([cell('max', { medianCostUsd: 2 }), cell('high', { medianCostUsd: 1, decided: 29 })])).toEqual([]);
    expect(suggestEfforts([cell('max', { medianCostUsd: 2 }), cell('high', { medianCostUsd: 1, pricedTurns: 10 })])).toEqual([]);
    // high lacks data: max is compared with medium
    const [s] = suggestEfforts([cell('max', { medianCostUsd: 2 }), cell('high', { decided: 5, medianCostUsd: 1 }), cell('medium', { medianCostUsd: 0.5 })]);
    expect(s).toMatchObject({ from: { effort: 'max' }, to: { effort: 'medium' } });
  });

  it('never mixes projects or models, skips unknown effort words, sorts by saving and caps the list', () => {
    const cells = [
      cell('max', { model: 'a', medianCostUsd: 2 }), cell('high', { model: 'b', medianCostUsd: 1 }),
      cell('turbo', { model: 'a', medianCostUsd: 0.1 }),
      ...['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].flatMap((p, i) => [cell('xhigh', { projectId: p, medianCostUsd: 2 + i }), cell('high', { projectId: p, medianCostUsd: 1 })]),
    ];
    const out = suggestEfforts(cells);
    expect(out).toHaveLength(5);
    expect(out.map((s) => s.projectId)).toEqual(['p6', 'p5', 'p4', 'p3', 'p2']);
    expect(out.every((s) => s.model === 'm')).toBe(true);
  });
});
