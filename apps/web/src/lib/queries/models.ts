import { CostSum, ZERO_COST, type CostValue } from '../cost';
import type { Filters } from '../filters';
import { dims, rollupFacts, turnsByModel, usageDaily } from './providers';
import { medianAvailableFor, rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { addTokens, costTokens, emptyOutcomes, emptyTokens, outcomeRates, type Outcomes, type TokenTotals } from './sqlutil';

export interface ModelRow {
  model: string | null;
  effort: string | null;
  turns: number;
  tokens: TokenTotals;
  cost: CostValue;
  successRate: number | null;
  unknownShare: number | null;
  /** From raw turns (see {@link getModelsEffort}); null when they no longer cover the range. */
  medianDurationMs: number | null;
  avgDurationMs: number | null;
}

export interface ModelsResult {
  range: ResolvedRange;
  rows: ModelRow[];
  medianAvailable: boolean;
}

/**
 * Cost, tokens, success and duration per model x effort, on the same basis as daily_rollups
 * (packages/db/README "daily_rollups", ADR-0015), so short (raw) and long (rollup) ranges agree:
 *  - turns, outcomes and durations count for the turn's PRIMARY model x effort;
 *  - tokens and ≈ cost come from usage rows, by the model x effort that used them, priced per day.
 * A model used only by sub-agents therefore has a row with tokens and cost but 0 turns (rates null).
 * Medians cannot be kept in rollups: on a long range they are read from the raw turns while those still
 * cover the range (it starts inside the retention window), else they are unavailable.
 */
export async function getModelsEffort(ctx: QueryCtx, f: Filters): Promise<ModelsResult> {
  const range = rangeFor(ctx, f);
  const d = dims(ctx, f, range);
  type Group = { model: string | null; effort: string | null; turns: number; tokens: TokenTotals; outcomes: Outcomes; durationMs: number; median: number | null; cost: CostSum; any: boolean };
  /** Rows without tokens (turn-only rows) carry no cost on either source. */
  const addCost = (g: Group, model: string, day: string, t: TokenTotals) => {
    if (t.total <= 0) return;
    g.cost.add(model, day, costTokens(t));
    g.any = true;
  };
  const groups = new Map<string, Group>();
  const slot = (model: string | null, effort: string | null) => {
    const key = `${model ?? ''}\u0000${effort ?? ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { model, effort, turns: 0, tokens: emptyTokens(), outcomes: emptyOutcomes(), durationMs: 0, median: null, cost: new CostSum(ctx.prices), any: false }));
    return g;
  };

  if (range.source === 'rollup') {
    for (const x of await rollupFacts(ctx, d)) {
      if (x.turns === 0 && x.tokens.total <= 0) continue; // all-zero leftover of a re-sent turn: no phantom row
      const g = slot(x.model, x.effort);
      g.turns += x.turns;
      g.durationMs += x.durationMs;
      addTokens(g.tokens, x.tokens);
      for (const k of Object.keys(g.outcomes) as (keyof Outcomes)[]) g.outcomes[k] += x.outcomes[k];
      addCost(g, x.model, x.day, x.tokens);
    }
    if (medianAvailableFor(ctx, range)) {
      for (const x of await turnsByModel(ctx, d)) {
        const g = groups.get(`${x.model ?? 'unknown'}\u0000${x.effort ?? ''}`);
        if (g) g.median = x.medianDurationMs;
      }
    }
  } else {
    for (const x of await turnsByModel(ctx, d)) {
      // The worker files a turn without a primary model under 'unknown' (UNKNOWN_MODEL); do the same.
      const g = slot(x.model ?? 'unknown', x.effort ?? null);
      g.turns += x.turns;
      g.durationMs += x.durationMs;
      g.median = x.medianDurationMs;
      for (const k of Object.keys(g.outcomes) as (keyof Outcomes)[]) g.outcomes[k] += x.outcomes[k];
    }
    for (const u of await usageDaily(ctx, d)) {
      const g = slot(u.model, u.effort);
      addTokens(g.tokens, u.tokens);
      addCost(g, u.model, u.day, u.tokens);
    }
  }

  const out: ModelRow[] = [...groups.values()].map((g) => ({
    model: g.model,
    effort: g.effort,
    turns: g.turns,
    tokens: g.tokens,
    cost: g.any ? g.cost.value() : ZERO_COST,
    ...outcomeRates(g.outcomes),
    medianDurationMs: g.median,
    avgDurationMs: g.turns > 0 ? g.durationMs / g.turns : null,
  }));
  out.sort((a, b) => (b.cost.usd ?? -1) - (a.cost.usd ?? -1) || b.tokens.total - a.tokens.total);
  return { range, rows: out, medianAvailable: medianAvailableFor(ctx, range) };
}
