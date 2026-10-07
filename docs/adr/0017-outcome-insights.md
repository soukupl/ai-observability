# ADR-0017: Outcome-based insights (wasted spend, skill impact, effort advisor) and outcome-split rollups

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** Ladislav Soukup (owner: briefs accepted with "go, implement", 2026-10-07); implementation details by Claude
- **Tags:** dashboard, rollups, privacy
- **Briefs:** [wasted-spend](../briefs/wasted-spend.md), [skill-impact](../briefs/skill-impact.md), [effort-advisor](../briefs/effort-advisor.md)

## Context

The dashboard reported outcomes and cost side by side, but never connected them: what did failed work cost,
does a skill help, is the highest effort worth it? Raw turns carry everything needed. Rollups (ADR-0012) did not:
`daily_rollups` keeps tokens by model × effort and outcome counts by primary model, but no tokens per outcome, and
`daily_skill_mcp_rollups` kept no outcomes at all.

## Decision

- **Wasted spend** = ≈ cost of turns whose final outcome is `failed` or `abandoned`, including turns that were
  marked failed later because of a correction or a revert. `unknown` is shown separately as "unclassified". It
  appears as an Overview tile (with a share and a 7-day line) and as columns on Projects and Models & effort.
  Pricing follows the usage row's model × day, like every cost.
- **Outcome-split rollups (migration 0007).** `daily_rollups` gains `wasted_*` and `unknown_*` token columns, by
  usage model × effort. `daily_skill_mcp_rollups` gains outcome counts. Both get `outcome_split`. The worker (and
  the seed) always write the split. The migration re-queues every day that still has raw turns, by bumping
  `turns.updated_at`. Days whose raw turns are gone keep `outcome_split = false`, and the views say how many days
  are not covered.
- **Skill impact:** each skill's turns are compared with turns without the skill in the same project × primary
  model cell, and the comparison is weighted by where the skill was used, which removes the project mix. Success
  delta in points; cost / tokens / duration as relative median deltas. At least 20 turns on each side, otherwise
  "not enough data". Long ranges compare success only (from the split rollups). Medians are raw-only.
- **Effort advisor:** within project × model, each effort level is compared with the next lower level that has
  enough data: at least 30 decided and 30 priced turns on each side, success at most 5 points lower, median
  ≈ cost at least 20 % lower, and at least $5 saved. Top 5 by estimated saving. Raw ranges only; the effort filter
  is ignored.
- **Honesty:** all three are labelled "observed, not causal / not tested" and show their sample sizes. There are
  no significance tests in v1.
- **Privacy:** new `agg_*` functions (`agg_wasted`, `agg_wasted_rollups`, `agg_skill_impact`,
  `agg_skill_impact_rollups`, `agg_effort_cells`) serve aggregates-only leads and admins without `user_id`.

## Consequences

- Raw and rollup ranges agree exactly for wasted spend and skill-impact success (tested), mixed-model turns
  included.
- Re-queuing touches every turn's `updated_at` once at deploy time. The next rollup pass rewrites every retained
  day.
- Selection bias stays: people may use a skill or a high effort on harder tasks. The UI says so. The numbers are
  prompts for questions, not verdicts.

## Alternatives considered

- **Raw-only wasted spend and skill impact:** no migration, but long ranges and history past retention would
  show nothing.
- **Pooled comparison (all other turns):** simpler, but it shows project-mix effects as skill effects (a unit test
  pins the difference).
- **Significance tests:** more rigorous, but harder to explain; sample sizes plus thresholds are enough for v1.
