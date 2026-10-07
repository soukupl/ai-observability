/*
 * Skill impact (docs/briefs/skill-impact.md, ADR-0017). Pure: per skill, compare the turns that used it with
 * the other turns of the same project × primary model cells, and weight each cell by how often the skill was
 * used there, so a skill used mostly on an easy project does not look good because of that project.
 * Observed, not causal: people may reach for a skill on harder tasks, and the UI says so.
 */

export const MIN_IMPACT_TURNS = 20;

/** One side (with or without the skill) of one cell. Medians are null on rollup ranges. */
export interface ImpactCellSide {
  skill: string;
  projectId: string | null;
  model: string;
  withSkill: boolean;
  turns: number;
  decided: number;
  success: number;
  pricedTurns: number;
  medianCostUsd: number | null;
  medianTokens: number | null;
  medianDurationMs: number | null;
}

/** A median comparison: the skill's and the comparable turns' weighted medians, and their relative difference. */
export interface MedianDelta {
  skill: number;
  comparable: number;
  /** skill / comparable - 1 (−0.2 = 20 % lower) */
  delta: number;
}

export interface SkillImpact {
  skill: string;
  /** skill turns / comparable turns in the cells both sides exist in */
  turns: number;
  comparableTurns: number;
  /** false below MIN_IMPACT_TURNS on either side: show "not enough data" */
  enough: boolean;
  /** success rate of the skill's decided turns, and of the comparable turns re-weighted to the skill's cell mix */
  successRate: number | null;
  comparableSuccessRate: number | null;
  /** successRate − comparableSuccessRate (fraction; 0.05 = 5 points) */
  successDelta: number | null;
  cost: MedianDelta | null;
  tokens: MedianDelta | null;
  durationMs: MedianDelta | null;
}

type Pair = { on: ImpactCellSide; off: ImpactCellSide };

function medianDelta(pairs: Pair[], pick: (s: ImpactCellSide) => number | null): MedianDelta | null {
  let w = 0;
  let a = 0;
  let b = 0;
  for (const p of pairs) {
    const x = pick(p.on);
    const y = pick(p.off);
    if (x === null || y === null) continue;
    w += p.on.turns;
    a += p.on.turns * x;
    b += p.on.turns * y;
  }
  if (w === 0 || b <= 0) return null;
  return { skill: a / w, comparable: b / w, delta: a / b - 1 };
}

export function skillImpacts(sides: readonly ImpactCellSide[]): SkillImpact[] {
  const pairs = new Map<string, Map<string, Partial<Pair>>>();
  for (const s of sides) {
    let bySkill = pairs.get(s.skill);
    if (!bySkill) pairs.set(s.skill, (bySkill = new Map()));
    const cell = `${s.projectId ?? ''}\u0000${s.model}`;
    const p = bySkill.get(cell) ?? {};
    if (s.withSkill) p.on = s;
    else p.off = s;
    bySkill.set(cell, p);
  }
  const out: SkillImpact[] = [];
  for (const [skill, cells] of pairs) {
    const both = [...cells.values()].filter((p): p is Pair => Boolean(p.on && p.off && p.on.turns > 0 && p.off.turns > 0));
    const turns = both.reduce((a, p) => a + p.on.turns, 0);
    const comparableTurns = both.reduce((a, p) => a + p.off.turns, 0);
    // success: the skill's own rate vs the comparable rate of each cell, weighted by the skill's decided turns there
    let decided = 0;
    let success = 0;
    let baseW = 0;
    for (const p of both) {
      if (p.on.decided === 0 || p.off.decided === 0) continue;
      decided += p.on.decided;
      success += p.on.success;
      baseW += p.on.decided * (p.off.success / p.off.decided);
    }
    const successRate = decided ? success / decided : null;
    const comparableSuccessRate = decided ? baseW / decided : null;
    out.push({
      skill,
      turns,
      comparableTurns,
      enough: turns >= MIN_IMPACT_TURNS && comparableTurns >= MIN_IMPACT_TURNS,
      successRate,
      comparableSuccessRate,
      successDelta: successRate === null || comparableSuccessRate === null ? null : successRate - comparableSuccessRate,
      cost: medianDelta(both, (s) => (s.pricedTurns > 0 ? s.medianCostUsd : null)),
      tokens: medianDelta(both, (s) => s.medianTokens),
      durationMs: medianDelta(both, (s) => s.medianDurationMs),
    });
  }
  return out.sort((a, b) => b.turns - a.turns || a.skill.localeCompare(b.skill));
}
