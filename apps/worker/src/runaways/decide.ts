/*
 * Runaway rules (docs/briefs/runaway-alerts.md, ADR-0018). Pure, so the thresholds are unit-tested. A finished
 * turn is a runaway when any rule fires. "Tokens" here are input + output + cache writes: cache reads are left out
 * (owner, 2026-10-07) because they dominate long agentic turns while costing little; the cost rule covers spend.
 * The user's percentiles are computed on the same measure.
 *   tokens   - its tokens exceed 3 × the user's own p99 of the 30 days before it (with ≥ 50 turns of history),
 *              or the absolute floor while there is too little history (or no user: ownerless turns from before ADR-0029);
 *   cost     - its ≈ cost reaches the deployment threshold (deployment.settings.runawayCostUsd, default $20);
 *   duration - it ran at least the deployment's hours (runawayHours, default 2) AND its tokens exceed the user's p95
 *              (or a quarter of the floor without history).
 */

export const RUNAWAY_RULES = {
  /** history turns needed before the user's own percentiles are trusted */
  minHistory: 50,
  /** tokens rule: multiple of the user's p99 */
  p99Factor: 3,
  /** tokens rule without enough history */
  floorTokens: 20_000_000,
} as const;

export type RunawayReason = 'tokens' | 'cost' | 'duration';

export interface RunawayInput {
  /** input + output + cache-write tokens of the turn (cache reads excluded) */
  tokens: number;
  durationMs: number;
  /** ≈ cost; null when a model had no price */
  costUsd: number | null;
  history: number;
  p95: number | null;
  p99: number | null;
}

export interface RunawayThresholds {
  costUsd: number;
  hours: number;
}

export function runawayReasons(t: RunawayInput, th: RunawayThresholds): RunawayReason[] {
  const r = RUNAWAY_RULES;
  const known = t.history >= r.minHistory && t.p99 !== null && t.p95 !== null;
  const out: RunawayReason[] = [];
  if (known ? t.tokens > r.p99Factor * t.p99! : t.tokens > r.floorTokens) out.push('tokens');
  if (t.costUsd !== null && t.costUsd >= th.costUsd) out.push('cost');
  if (t.durationMs >= th.hours * 3_600_000 && (known ? t.tokens > t.p95! : t.tokens > r.floorTokens / 4)) out.push('duration');
  return out;
}
