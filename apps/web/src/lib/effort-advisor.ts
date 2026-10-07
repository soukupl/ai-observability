/*
 * Effort advisor (docs/briefs/effort-advisor.md, ADR-0017). Pure: given per project × model × effort cells,
 * suggest a lower effort level where it was observed to succeed about as often for clearly less ≈ cost.
 * Observed, not tested: people may pick a higher effort for harder tasks, and the UI says so.
 */

/** Effort levels from lowest to highest (Claude Code and Codex use the same words). Unknown levels are skipped. */
export const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const ADVISOR_RULES = {
  /** decided turns (success / failed / abandoned) each level needs */
  minDecided: 30,
  /** turns with a known ≈ cost each level needs */
  minPriced: 30,
  /** the lower level may succeed at most this much less often (fraction, 0.05 = 5 points) */
  maxSuccessDrop: 0.05,
  /** the lower level's median ≈ cost per turn must be at most this fraction of the higher one's */
  maxCostRatio: 0.8,
  /** smallest estimated saving worth showing, USD */
  minSavingsUsd: 5,
} as const;

export interface EffortCell {
  projectId: string | null;
  model: string;
  effort: string;
  turns: number;
  decided: number;
  success: number;
  pricedTurns: number;
  medianCostUsd: number | null;
  medianDurationMs: number | null;
}

export interface EffortSide {
  effort: string;
  turns: number;
  decided: number;
  successRate: number;
  medianCostUsd: number;
  medianDurationMs: number | null;
}

export interface EffortSuggestion {
  projectId: string | null;
  model: string;
  /** the level used today */
  from: EffortSide;
  /** the suggested lower level */
  to: EffortSide;
  /** 1 - to.medianCost / from.medianCost */
  costReduction: number;
  /** (from.medianCost - to.medianCost) × from.turns: "≈ if these turns had run at the lower level" */
  savingsUsd: number;
}

const rank = (effort: string): number => (EFFORT_ORDER as readonly string[]).indexOf(effort);

function side(c: EffortCell): EffortSide | null {
  const rules = ADVISOR_RULES;
  if (rank(c.effort) < 0 || c.decided < rules.minDecided || c.pricedTurns < rules.minPriced || c.medianCostUsd === null) return null;
  return {
    effort: c.effort,
    turns: c.turns,
    decided: c.decided,
    successRate: c.success / c.decided,
    medianCostUsd: c.medianCostUsd,
    medianDurationMs: c.medianDurationMs,
  };
}

/**
 * For each project × model, each qualifying level is compared with the next lower qualifying level. A pair
 * becomes a suggestion when the lower level's success rate is at most 5 points lower, its median ≈ cost per
 * turn at least 20 % lower, and the estimated saving at least $5. Sorted by saving, at most `limit`.
 */
export function suggestEfforts(cells: readonly EffortCell[], limit = 5): EffortSuggestion[] {
  const rules = ADVISOR_RULES;
  const byCell = new Map<string, EffortCell[]>();
  for (const c of cells) {
    const key = `${c.projectId ?? ''}\u0000${c.model}`;
    const list = byCell.get(key) ?? [];
    list.push(c);
    byCell.set(key, list);
  }
  const out: EffortSuggestion[] = [];
  for (const list of byCell.values()) {
    const sides = list
      .map((c) => ({ cell: c, side: side(c) }))
      .filter((x): x is { cell: EffortCell; side: EffortSide } => x.side !== null)
      .sort((a, b) => rank(a.side.effort) - rank(b.side.effort));
    for (let i = 1; i < sides.length; i++) {
      const hi = sides[i]!;
      const lo = sides[i - 1]!;
      if (lo.side.successRate < hi.side.successRate - rules.maxSuccessDrop) continue;
      if (hi.side.medianCostUsd <= 0 || lo.side.medianCostUsd > hi.side.medianCostUsd * rules.maxCostRatio) continue;
      const savingsUsd = (hi.side.medianCostUsd - lo.side.medianCostUsd) * hi.side.turns;
      if (savingsUsd < rules.minSavingsUsd) continue;
      out.push({
        projectId: hi.cell.projectId,
        model: hi.cell.model,
        from: hi.side,
        to: lo.side,
        costReduction: 1 - lo.side.medianCostUsd / hi.side.medianCostUsd,
        savingsUsd,
      });
    }
  }
  return out.sort((a, b) => b.savingsUsd - a.savingsUsd || a.model.localeCompare(b.model)).slice(0, limit);
}
