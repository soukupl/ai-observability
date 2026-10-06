import { sql } from 'drizzle-orm';
import { CostSum, ZERO_COST, type CostValue } from '../cost';
import type { Filters } from '../filters';
import { dims, rollupFacts, turnConds, turnDaily, usageDaily, type Dims } from './providers';
import { medianAvailableFor, rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { addTokens, costTokens, emptyOutcomes, emptyTokens, median, numOrNull, outcomeRates, rows, where, type Outcomes, type TokenTotals } from './sqlutil';
import { loadTurnRows } from './turn-rows';

export interface Kpis {
  range: ResolvedRange;
  turns: number;
  tokens: TokenTotals;
  cost: CostValue;
  outcomes: Outcomes;
  /** success / (turns - unknown); null when no turn has a decided outcome. */
  successRate: number | null;
  /** unknown / turns: how much of the success rate is not measurable (ADR-0003). */
  unknownShare: number | null;
  /**
   * Median turn duration, from raw turns: exact on the raw source and, for a long range, as long as the
   * range starts inside the retention window (rollups hold no durations to take a median of). null with
   * medianAvailable false once raw rows no longer cover the range.
   */
  medianDurationMs: number | null;
  medianAvailable: boolean;
  /** true when the outcome stats (and the median) were computed from a capped sample of turns. */
  approximate: boolean;
  /** true when only the median came from a capped sample (aggregate path over a long range; outcomes are exact). */
  medianApproximate: boolean;
  /** Filters that could not be applied to every figure (aggregate path: effort). */
  ignoredFilters: string[];
}

export async function getKpis(ctx: QueryCtx, f: Filters): Promise<Kpis> {
  const range = rangeFor(ctx, f);
  const d = dims(ctx, f, range);
  return range.source === 'rollup' ? kpisFromRollups(ctx, d, range) : kpisFromRaw(ctx, d, range);
}

async function kpisFromRollups(ctx: QueryCtx, d: Dims, range: ResolvedRange): Promise<Kpis> {
  const facts = await rollupFacts(ctx, d);
  const cost = new CostSum(ctx.prices);
  const tokens = emptyTokens();
  const outcomes = emptyOutcomes();
  let turns = 0;
  for (const x of facts) {
    turns += x.turns;
    addTokens(tokens, x.tokens);
    outcomes.success += x.outcomes.success;
    outcomes.failed += x.outcomes.failed;
    outcomes.abandoned += x.outcomes.abandoned;
    outcomes.unknown += x.outcomes.unknown;
    if (x.tokens.total > 0) cost.add(x.model, x.day, costTokens(x.tokens)); // turn-only rows carry no cost
  }
  // Rollups hold no durations; the median comes from the raw turns while they still cover the range.
  let medianMs: number | null = null;
  let medianApproximate = false;
  const medianAvailable = medianAvailableFor(ctx, range);
  if (medianAvailable) {
    if (!ctx.agg) {
      const [m] = await rows<{ m: unknown }>(
        ctx.tx,
        sql`select percentile_cont(0.5) within group (order by t.duration_ms) as m from turns t ${where(turnConds(ctx, d))}`,
      );
      medianMs = numOrNull(m?.m);
    } else {
      const sample = await loadTurnRows(ctx, d);
      medianMs = median(sample.rows.map((r) => r.durationMs));
      medianApproximate = sample.truncated;
    }
  }
  return finish(range, turns, tokens, facts.length ? cost.value() : ZERO_COST, outcomes, medianMs, medianAvailable, false, [], medianApproximate);
}

async function kpisFromRaw(ctx: QueryCtx, d: Dims, range: ResolvedRange): Promise<Kpis> {
  // Tokens and cost: usage rows (a mixed-model turn is priced per model).
  const usage = await usageDaily(ctx, d);
  const tokens = emptyTokens();
  const cost = new CostSum(ctx.prices);
  for (const u of usage) {
    addTokens(tokens, u.tokens);
    cost.add(u.model, u.day, costTokens(u.tokens));
  }

  let turns = 0;
  const outcomes = emptyOutcomes();
  let medianMs: number | null = null;
  let approximate = false;

  if (!ctx.agg) {
    const t = await turnDaily(ctx, d);
    for (const r of t.rows) {
      turns += r.turns;
      outcomes.success += r.outcomes.success;
      outcomes.failed += r.outcomes.failed;
      outcomes.abandoned += r.outcomes.abandoned;
      outcomes.unknown += r.outcomes.unknown;
    }
    const [m] = await rows<{ m: unknown }>(
      ctx.tx,
      sql`select percentile_cont(0.5) within group (order by t.duration_ms) as m from turns t ${where(turnConds(ctx, d))}`,
    );
    medianMs = numOrNull(m?.m);
  } else {
    // The aggregate functions give no overall median (and no effort filter), so use a capped sample
    // of turns. Counts come from the sample when it is complete; otherwise from agg_turns_daily.
    const sample = await loadTurnRows(ctx, d);
    medianMs = median(sample.rows.map((r) => r.durationMs));
    approximate = sample.truncated;
    if (!sample.truncated || d.effort) {
      turns = sample.rows.length;
      for (const r of sample.rows) outcomes[r.outcome] += 1;
    } else {
      const t = await turnDaily(ctx, d);
      for (const r of t.rows) {
        turns += r.turns;
        outcomes.success += r.outcomes.success;
        outcomes.failed += r.outcomes.failed;
        outcomes.abandoned += r.outcomes.abandoned;
        outcomes.unknown += r.outcomes.unknown;
      }
    }
  }
  return finish(range, turns, tokens, usage.length ? cost.value() : ZERO_COST, outcomes, medianMs, true, approximate, [], approximate);
}

function finish(
  range: ResolvedRange,
  turns: number,
  tokens: TokenTotals,
  cost: CostValue,
  outcomes: Outcomes,
  medianMs: number | null,
  medianAvailable: boolean,
  approximate: boolean,
  ignoredFilters: string[],
  medianApproximate: boolean,
): Kpis {
  return {
    range,
    turns,
    tokens,
    cost,
    outcomes,
    ...outcomeRates(outcomes),
    medianDurationMs: medianMs,
    medianAvailable,
    approximate,
    medianApproximate,
    ignoredFilters,
  };
}
