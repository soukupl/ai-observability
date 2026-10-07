# Brief: effort advisor

Status: **Accepted 2026-10-07**. Owner: "go, implement", which accepts the recommended defaults below.

## Goal

Point out where a lower effort level (or a cheaper model) gives about the same success at a clearly lower cost. For
example: "billing · claude-opus-5-5: `high` instead of `max` would have cost ~30 % less at a similar success rate
(n = 120 vs 85)."

## Today

- Models & effort shows cost, tokens, success and median duration per model × effort. Turns carry project, model,
  effort and outcome, so the comparison is a query on data we already have.

## Decisions to confirm (recommended defaults)

1. **Scope of a suggestion:** within one project × model, compare each effort level with the next lower one that
   has data. Cross-model suggestions ("use Sonnet instead of Opus") are a separate, later step; they're harder to make
   honest.
2. **When to suggest:** both levels have ≥ 30 decided turns in the range, the lower level's success rate is no more
   than 5 points below, and its median ≈ cost per turn is at least 20 % lower. All thresholds are constants, shown in
   the UI.
3. **Honesty:** each suggestion shows both sample sizes, both success rates and both median costs, plus a fixed note:
   "Observed, not tested: people may pick higher effort for harder tasks." No significance test in v1.
4. **Savings estimate:** (median cost difference per turn) × (turns at the higher level in the range), labelled "≈ if
   these turns had run at the lower level."
5. **Placement:** a "Suggestions" card on Models & effort (top 5 by estimated savings), respecting the filters, plus a
   per-project version on the project page.
6. **Raw only:** medians need raw turns (≤ 35 days and inside retention), like the medians we show today. Long ranges
   show "needs a range within the last 35 days".

## In scope

- A query (direct and aggregate paths; no per-user data), pure suggestion logic with unit tests, the cards, and
  CSV of the suggestions.

## Out of scope

- Cross-model suggestions; automatic effort changes in the harness; per-user advice.
- Codex reasoning effort is included only where its effort values map onto the same scale. If they don't, Codex
  efforts are compared only with each other.

## Open questions

- Should suggestions also consider duration ("max is 2× slower for the same success")? Recommended: show it, but
  don't trigger suggestions on it.
- Should a suggestion need a minimum savings amount (e.g. ≥ $5 in the range) to avoid noise? Recommended: yes,
  configurable later.

## Done when

- The suggestion logic is unit-tested on synthetic cells (thresholds, too small samples, ties).
- The cards render on Models & effort and project pages, and are empty with an explanation when nothing qualifies.
- Docs are updated: BRIEF §8 and the apps/web README.
