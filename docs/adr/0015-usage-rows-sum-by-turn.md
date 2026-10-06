# ADR-0015: Usage rows are summed by `turn_id`; ingest stores the turn's usage as given

- **Status:** Proposed (written during integration; owner to confirm)
- **Date:** 2026-10-06 (amended 2026-10-06: pending patches, rollup fold)
- **Deciders:** Claude (ingest agent, recorded by the integration agent; amended by the data-correctness
  agent); owner confirmation pending
- **Tags:** database, ingest, aggregation

## Context

The `app_ingest` role cannot read token columns (ADR-0014), so when a turn event arrives it cannot
subtract sub-agent usage that earlier `run` events already stored. The collector's turn usage already
includes the sub-agents counted into the turn (protocol fixture). Seed data used a different shape:
`run_id = null` rows are the main agent only and run rows also carry `turn_id`.

The integration pass found two more problems:

1. A `turn_outcome` / `turn_summary` that arrived before its turn created a **placeholder turn**
   (`session_id` null, zero tokens, started at receive time). Every aggregate counted it as a turn until
   the real turn arrived, and rollups kept that count for its day.
2. Rollups and raw reads attributed tokens differently in places (the seed and the dashboard's models
   view put a mixed-model turn's whole token total on its primary model, raw KPIs priced per usage row),
   so ≈ cost from the two sources diverged for turns whose sub-agents used another model.

## Decision

- A `turn` event's `usage` entries are stored as `usage` rows with `turn_id` set and `run_id = null`.
  A re-sent turn replaces them.
- A `run` event's usage entries are stored with `run_id` set and `turn_id = null`.
- Every aggregate (`agg_usage_daily`, worker rollups, budgets, dashboard queries) sums usage by
  `turn_id` only. Turn totals therefore equal the collector's turn usage, whichever shape produced the rows.
- **No placeholder turns.** A patch for a turn that has not arrived is parked in `pending_turn_patches`
  (migration 0002). When the turn arrives, `ingest_apply_pending_patch(turn_id)` (SECURITY DEFINER, so
  `app_ingest` still reads no values and deletes nothing) copies the patch onto it and deletes it. Turn and
  patch handling take a transaction-scoped advisory lock on the turn key, so concurrent batches cannot
  both miss each other. Unclaimed patches are dropped after 30 days. Migration 0002 converts existing
  placeholders into parked patches. (Rejected alternative: keep placeholders and exclude
  `session_id IS NULL` from every read path; it leaves bad rows in the data and every new query must
  remember the filter.)
- **One fold for rollups and raw reads.** In `daily_rollups`, turn counts, runs, durations, phases and
  outcome counts belong to the row of the turn's primary model × effort (`'unknown'` without a model);
  tokens and requests belong to the row of each usage row's model × effort. Raw dashboard reads use the
  same split (tokens and ≈ cost from usage rows, turn counts from `turns.model`), so both sources agree
  exactly, including ≈ cost. The worker, the seed and the dashboard test fixture all use this fold (the
  fixture calls the worker's `recomputeDay`).

## Consequences

- Per-run token numbers come from `usage.run_id`, per-turn numbers from `usage.turn_id`; the two sets
  are disjoint and must never be added together.
- Summing all usage rows of a company is wrong. Code that does must go through `turn_id`.
- A future per-run cost view needs run rows only.
- A turn row always has its session and tokens; nothing is counted before the turn event arrives. A patch
  whose turn never arrives is invisible (and gone after 30 days).
- A model used only by sub-agents appears in rollups and in the models view with tokens and cost but
  `turns = 0`; per-model success rates are per primary model.
- Raw reads bucket usage by the usage row's `started_at` day, rollups by the turn's day. They differ only
  for seed-shape run rows (run usage with `turn_id` set) whose run starts on a later UTC day than its
  turn; ingest never writes that shape.
