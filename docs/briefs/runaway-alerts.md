# Brief: runaway detection

Status: **Draft 2026-10-07**, waiting for the owner.

## Goal

Notice when an agent burns tokens far beyond normal, for example a loop, a stuck retry or an autonomous session
left running, and tell someone quickly. It notifies only and never blocks (same principle as budgets, BRIEF §9).

## Today

- The collector sends a turn when it ends (`Stop`). A turn that runs away **inside** one long turn is invisible until
  it stops, which can be hours later. Budgets are checked hourly against month-to-date totals and e-mailed at
  80 % / 100 %.
- The worker, the e-mail path and the budget recipient rules (SEC-2: in aggregates-only mode, a person's
  consumption is mailed only to that person) already exist.

## Decisions to confirm (recommended defaults)

1. **Detection timing: near-live.** While a turn is running, the collector also sends a small progress event every
   N minutes (tokens so far, elapsed time, tool calls). Without it the feature only catches runaways after they end.
   This needs a periodic trigger in the collector: the hooks we use fire only at turn boundaries, so the detached
   worker would keep watching the transcript. That's the biggest piece of work here.
2. **What "runaway" means**, any of these (per turn, in progress or finished):
   - tokens per turn above the user's own p99 of the last 30 days × 3 (with a fallback absolute floor while there's
     too little history);
   - ≈ cost of a single turn above a company threshold (default $20);
   - a turn running longer than 2 h with steady token growth.
3. **Who is notified:** the user, always. In `full` visibility mode, also the team's leads. In aggregates-only mode,
   only the user (consistent with SEC-2). At most one alert per turn, and one digest per user per hour.
4. **Channel:** e-mail in v1, plus a "Runaways" list on Overview (own turns for members; team / company for
   leads / admins under the visibility rules).
5. **Where it runs:** at ingest, for finished turns and progress events, so it is near real-time. The worker only
   sends the mail.

## In scope

- Protocol: a new optional `turn_progress` event type (additive to schema v1). Collector: periodic progress while a
  turn is open, for Claude Code first. Ingest: evaluation and an alert record. Worker: mail. Dashboard: list,
  thresholds in Admin → Settings, and an ADR.

## Out of scope

- Stopping or throttling the harness; Slack / webhooks (separate idea); per-project thresholds.
- Codex progress events in v1, if its rollout can't be watched the same way (to be checked).

## Open questions

- Is post-hoc detection (at turn end, no collector change) enough for v1? It's much cheaper, but a 6-hour loop is
  reported only after 6 hours.
- Should company admins in aggregates-only mode get an anonymous alert ("a turn in team X exceeded $20")?
  Recommended: yes. It names no person.

## Done when

- A synthetic runaway in a fixture triggers exactly one alert per turn, with the right recipients for both
  visibility modes.
- A live long-running session (scripted) produces progress events, and an alert arrives in Mailpit within one progress
  interval.
- Docs and the ADR are updated: BRIEF §9, the collector README and the apps/web README.
