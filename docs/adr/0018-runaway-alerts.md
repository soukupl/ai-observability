# ADR-0018: Runaway alerts after a turn ends, evaluated by the worker

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** Ladislav Soukup (owner: v1 detection after the turn ends, "go, implement", 2026-10-07); rules and recipients by Claude from the brief's recommended defaults
- **Tags:** alerts, worker, privacy
- **Brief:** [runaway-alerts](../briefs/runaway-alerts.md)

## Context

A loop, a stuck retry or a forgotten autonomous session can burn a large budget in one turn. Budgets (BRIEF §9) only
look at monthly totals. The collector sends a turn when it ends, so live detection would need new periodic progress
events from the collector.

## Decision

- **v1 detects after the turn ends; no collector change.** Live progress events are a follow-up.
- **The worker evaluates, not ingest.** The ingest role cannot read token columns (ADR-0014). A `runaways` job (every
  5 min, watermark like rollups) looks at turns written since the last pass, started within 7 days, with no alert
  yet. A cold start looks back one day.
- **Rules** (any fires; `apps/worker/src/runaways/decide.ts`):
  - tokens > 3 × the user's own p99 of the 30 days before the turn (with ≥ 50 turns of history), else > 20 M tokens;
  - ≈ cost ≥ the company threshold (default $20);
  - duration ≥ the company's hours (default 2) and tokens > the user's p95 (else > 5 M).
  The thresholds live in company settings (`runawayCostUsd` 1–100,000, `runawayHours` 0.5–72; Admin → Settings,
  CHECK-constrained).
- **One alert per turn** (`runaway_alerts`, unique per company × turn; deleted with the turn or the user).
- **Recipients** follow the budget rules (SEC-2): the turn's user always; in `full` visibility mode also the leads
  of the turn's team, with the person named; in aggregates-only mode the company admins get an **anonymous** digest
  (team, project, numbers, no person, no links).
- **At most one digest per company per hour.** Alerts are claimed (`notified_at`) before sending and released when
  every mail of the company failed.
- **Dashboard:** a "Runaway turns" card on Overview under the usual visibility rules (`agg_runaways` in
  aggregates-only mode).
- Alerts only notify. Nothing is ever blocked.

## Consequences

- A runaway inside one long turn is reported only after it ends. That is the accepted v1 limitation.
- Per-user baselines avoid flagging heavy-but-normal users, but new users fall back to absolute floors.
- The hourly digest is per company, so a burst of runaways produces one mail per recipient.

## Alternatives considered

- **Near-live progress events from the collector:** catches loops while they run, but the collector needs a
  periodic trigger. Deferred.
- **Detection at ingest:** near real-time, but `app_ingest` cannot read tokens by design.
- **Mailing leads in aggregates-only mode:** would reveal individual consumption that the mode hides (SEC-2).
