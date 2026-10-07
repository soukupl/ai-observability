# Brief: does a skill help? (skill impact)

Status: **Accepted 2026-10-07**. Owner: "go, implement", which accepts the recommended defaults below. Builds on [skills-and-mcp-stats.md](skills-and-mcp-stats.md) (ADR-0016).

## Goal

For each skill, show whether turns that use it go better than comparable turns that don't: success rate, tokens,
≈ cost and duration. The question to answer: "is this skill worth having, and is it worth pushing the team to use it?"

## Today

- `turns.skills` / `runs.skills` say which turns used which skill. Turns also carry the outcome, tokens, duration and
  primary model. So on raw ranges the comparison is one query.
- `daily_skill_mcp_rollups` has calls and turn counts per skill but no outcomes, tokens or durations. Long ranges
  (> 35 days, or past retention) can't answer the question today.

## Decisions to confirm (recommended defaults)

1. **Comparison baseline: turns without the skill, in the same project × primary model.** We compute each skill's
   delta per (project, model) cell and weight the deltas by the skill's turns. This removes the biggest confounders:
   a skill used mostly on an easy project shouldn't look good just because of that project. The alternative, all other
   turns in the filter, is simpler but misleading.
2. **Metrics:** success rate (decided turns only, unknown share shown as today), median duration, median tokens and
   median ≈ cost per turn. Each is shown as the skill's value, the baseline value and the delta.
3. **Minimum sample size:** below 20 skill turns or 20 baseline turns in the weighted cells, a skill shows "not enough
   data". No significance test in v1; the sample size is shown next to every delta.
4. **Wording:** "turns that used X" vs "comparable turns". Never "X causes". A footnote explains selection bias:
   people reach for a skill on harder tasks.
5. **Long ranges:** extend `daily_skill_mcp_rollups` skill rows with outcome counts, tokens and duration. Medians stay
   raw-only, as on Models & effort today. The alternative is raw-only (≤ 35 days and inside retention), with no
   migration.
6. **Placement:** new columns in the Skills table on Skills & MCP (success Δ, cost Δ), plus a detail drawer per skill
   with the full comparison.

## In scope

- A query with direct and aggregate paths (a new `agg_skill_impact` function), and the rollup extension if decision 5
  holds.
- Skills & MCP table columns plus the per-skill detail, and the CSV export.
- Tests that raw and rollup paths agree, and that aggregates-only mode exposes no user data.

## Out of scope

- MCP server impact (same machinery, a later step).
- Statistical significance, confidence intervals and A/B experiments.
- Comparing a typed use against a model-invoked use of the same skill (possible later from `user_calls`).

## Open questions

- Should the baseline also match on harness and effort? It's more precise, but cells get smaller.
- Should a turn whose sub-agent used the skill count as "used the skill"? Recommended: yes, as on the Skills & MCP view.

## Done when

- The Skills table shows success and cost deltas with sample sizes, and the detail drawer shows the full comparison.
- Raw, rollup and aggregate paths give the same numbers on the shell fixture (medians raw-only).
- Docs are updated: BRIEF §8, apps/web README, and the db README if the rollup changes.
