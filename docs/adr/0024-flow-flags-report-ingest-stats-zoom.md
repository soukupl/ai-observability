# ADR-0024: Personal flow flags, print-to-PDF flow reports, ingest statistics and client-side chart zoom

- **Status:** Accepted
- **Date:** 2026-10-10
- **Deciders:** Ladislav Soukup (owner: the seven items in the brief, 2026-10-10); shapes and defaults by Claude
- **Tags:** dashboard, schema
- **Brief:** [dashboard-followups-2026-10-10](../briefs/dashboard-followups-2026-10-10.md)

## Context

The Agent flows view (ADR-0020 amendment) lists multi-step flows and shows one in detail. The owner wants to keep a
flow for later, hand it over as a PDF, see skills and MCP calls in that report, find the long or complex flows from the
Overview next to the runaway turns, know whether collectors are still reporting, and zoom into the time-series charts.
The Agents page carried a second "Agent flow" card that duplicated `/flows`.

## Decision

- **Flow flags are personal bookmarks** stored in `flow_flags` (company, user, turn, flow key, a snapshot of the flow
  name, optional note). RLS: a user reads, creates and deletes only their own rows (`app_web`); nothing is shared with
  the team. The flagged list on `/flows` ignores the date range. The flow key is the same URL key the detail page uses
  (ADR-0020 amendment), so a flag survives as long as its turn does (FK cascade on the turn).
- **The PDF report is the browser's print-to-PDF** of a dedicated print-ready page (`/report/flows/<turnId>/<key>`),
  not a server-generated file. No PDF dependency is added; charts are server-rendered HTML bars plus the existing SVG
  flow chart, so the printout matches the screen without a headless browser.
- **Skills & MCP** on the flow detail and in the report are always shown, as two lines: the steps' uses summed and the
  turn's uses (what the turn record carries), with "none recorded" when empty.
- **Complex flows on the Overview** are the flows of the range with ≥ 5 steps, or ≥ 20 minutes, or ≥ 1 M tokens
  (constants in the Overview helpers; not company settings until asked), at most 8, by duration.
- **Ingest statistics** come from the de-duplication ledger `ingest_events` through `agg_ingest_stats()` (SECURITY
  DEFINER, company-wide, no user ids): events of the last 24 h / 7 days by type and the last receipt. The ledger keeps
  30 days, which bounds the statistics; no new table is written on ingest (the hot path stays as it is).
- **Agents page links instead of the flow card**: every drawn sub-agent run links to its flow (or its turn), and every
  agent group / type links to `/flows?group=<group>`, a new list filter.
- **Chart zoom is client-side**: drag on a stacked-area chart selects a day range from the data already loaded; the
  server query and the URL do not change. The agent timeline keeps its URL-driven window (ADR-0019).

## Consequences

- Migration `0015_flow_flags_ingest_stats.sql`: the table, its RLS, the function and an index on
  `ingest_events (company_id, received_at)`.
- Team-visible flags, server-side PDFs, configurable complexity thresholds and ingest stats older than 30 days would
  each be a new decision.
- The report page lives outside the `(dashboard)` layout (no navigation chrome) but behind the same login.
