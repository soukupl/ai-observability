# Brief: wasted spend

Status: **Accepted 2026-10-07**. Owner: "go, implement", which accepts the recommended defaults below.

## Goal

One number a manager can watch: the ≈ cost of AI work that didn't pay off, by project, model, team and over time.

## Today

- Every turn has an outcome (success / failed / abandoned / unknown, ADR-0003) and its token usage. ≈ Cost is
  computed at query time from `model_prices`.
- `daily_rollups` keeps outcome **counts** and **tokens** per day × … × model × effort. The tokens are not split by
  outcome, so long ranges can't price failed work today.

## Decisions to confirm (recommended defaults)

1. **Definition:** wasted = ≈ cost of turns whose final outcome is `failed` or `abandoned`. That includes turns marked
   failed afterwards because the next prompt was a correction or the next turn reverted them. `unknown` turns are not
   waste and are shown separately as "unclassified spend". Provisional outcomes count as they are, and the share
   updates as patches arrive.
2. **Shown as:** an absolute ≈ amount and a share of total ≈ cost, always labelled "≈ at API list prices".
3. **Placement:** an Overview KPI tile (wasted ≈ cost and share, with a 7-day trend), plus a "wasted" column on
   Projects and Models & effort. No new view in v1.
4. **Long ranges:** extend `daily_rollups` with failed and abandoned token columns, priced per usage model like the
   existing tokens. That is a migration plus a worker fold change. Rollups written before it have no split, so their
   days show "n/a" for wasted. The alternative is raw-only.
5. **Visibility:** the same rules as cost today. In aggregates-only mode leads and admins see team and company
   totals, never per user.

## In scope

- Query layer (direct and aggregate paths), the rollup extension, the worker fold, and an update to the seed fold.
- The Overview tile, the two table columns and the CSV columns.
- Tests: raw, rollup and aggregate paths agree; mixed-model turns are priced per usage model.

## Out of scope

- Partial waste inside a successful turn (e.g. a sub-agent that failed while the turn succeeded).
- Budgets on wasted spend.
- Re-folding history from before the migration.

## Open questions

- Should a failed sub-agent run inside a successful turn count as waste? Recommended: not in v1 (see out of scope).
- Should `abandoned` (user interrupted) count as waste? Recommended: yes. The tokens were spent and the work was
  thrown away. Some teams interrupt on purpose to redirect, though, so the tile could show failed and abandoned
  separately.

## Done when

- The Overview tile and the Projects / Models columns show wasted ≈ cost and its share for raw and long ranges.
- Raw and rollup paths agree exactly on the shell fixture, mixed-model included.
- Docs are updated: BRIEF §8, apps/web README, and the db README fold notes.
