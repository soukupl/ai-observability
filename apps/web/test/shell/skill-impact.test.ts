import { describe, expect, it } from 'vitest';
import { MIN_IMPACT_TURNS, skillImpacts, type ImpactCellSide } from '../../src/lib/skill-impact';

const side = (withSkill: boolean, over: Partial<ImpactCellSide> = {}): ImpactCellSide => ({
  skill: 's', projectId: 'p', model: 'm', withSkill, turns: 40, decided: 40, success: 20, pricedTurns: 40,
  medianCostUsd: 1, medianTokens: 1000, medianDurationMs: 60_000, ...over,
});

describe('skillImpacts', () => {
  it('compares within a cell: success delta in points, medians as relative deltas', () => {
    const [i] = skillImpacts([side(true, { success: 30, medianCostUsd: 0.8 }), side(false, { success: 20 })]);
    expect(i).toMatchObject({ skill: 's', turns: 40, comparableTurns: 40, enough: true, successRate: 0.75, comparableSuccessRate: 0.5 });
    expect(i!.successDelta).toBeCloseTo(0.25);
    expect(i!.cost!.delta).toBeCloseTo(-0.2);
    expect(i!.tokens!.delta).toBeCloseTo(0);
  });

  it('re-weights the comparable side to the cells the skill was used in (no project mix effect)', () => {
    // Easy project p1 (90 % success) has most skill turns; hard p2 (30 %). The skill matches each cell exactly.
    const cells = [
      side(true, { projectId: 'p1', turns: 90, decided: 90, success: 81 }), side(false, { projectId: 'p1', turns: 10, decided: 10, success: 9 }),
      side(true, { projectId: 'p2', turns: 10, decided: 10, success: 3 }), side(false, { projectId: 'p2', turns: 90, decided: 90, success: 27 }),
    ];
    const [i] = skillImpacts(cells);
    expect(i!.successDelta).toBeCloseTo(0); // a naive pooled comparison would say +60 points
  });

  it('ignores cells without both sides, flags small samples, and has no medians on rollup rows', () => {
    const [i] = skillImpacts([
      side(true, { projectId: 'only-skill', turns: 500 }),
      side(true, { turns: MIN_IMPACT_TURNS - 1, medianCostUsd: null, medianTokens: null, medianDurationMs: null, pricedTurns: 0 }),
      side(false, { medianCostUsd: null, medianTokens: null, medianDurationMs: null, pricedTurns: 0 }),
    ]);
    expect(i).toMatchObject({ turns: MIN_IMPACT_TURNS - 1, enough: false, cost: null, tokens: null, durationMs: null });
  });
});
