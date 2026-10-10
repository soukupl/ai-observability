# ADR-0023: Turn summaries are generated during the session, not only at its end

- **Status:** Accepted
- **Date:** 2026-10-10
- **Deciders:** Ladislav Soukup (owner: "there are quite often turns without summary… it is back-filled later but it
  took time", 2026-10-10); rule and thresholds by Claude
- **Tags:** collector, cost
- **Brief:** [dashboard-followups-2026-10-10](../briefs/dashboard-followups-2026-10-10.md)
- **Amends:** BRIEF §5.6 ("one batched headless call at `SessionEnd`")

## Context

Summaries (≤ 140 chars per turn) are produced locally by one batched headless call to the harness's cheapest model and
sent as `turn_summary` patches. The Claude Code adapter made that call only at `SessionEnd`, so during a long session
(hours, sometimes days with Claude Code left open) every turn appeared on the dashboard without a summary. The Codex
adapter already summarized every ten digests. One headless call costs a few seconds of a cheap model; the dashboard's
usefulness without summaries is low (the Turns list and the Agents timeline label turns by their summary).

## Decision

- Both adapters summarize the pending digests at any hook when **one** of these holds: the session ended; **10 or
  more** digests are pending (`SUMMARY_BATCH`); the **oldest pending digest has waited 10 minutes or more**
  (`SUMMARY_MAX_WAIT_MS`). The wait is tracked by `digestsSince` on the per-session state (set when the first digest
  of a batch is added, cleared when the batch is handed to the summarizer); state files without the field keep
  working.
- The call still runs in the detached worker, never inside the hook's in-process budget, and still carries the
  recursion guard (`AI_OBS_SUMMARIZING=1`).
- A turn is digested once, when it is first emitted; a turn continued after a Stop keeps its first summary.

## Consequences

- At most one extra headless call per ~10 minutes of an active session; a short session with one turn still makes one
  call at its end, as before. Failed calls are retried exactly as before (pending file, 7 days / attempt cap).
- Summaries now describe the turn as it was when first emitted; a continuation that changes a turn's substance is not
  re-summarized (same as the previous end-of-session behaviour for turns that ended before the session did).
