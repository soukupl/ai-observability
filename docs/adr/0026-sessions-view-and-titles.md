# ADR-0026: Sessions view over harness sessions; session titles as a patch event

- **Status:** Accepted
- **Date:** 2026-10-13
- **Deciders:** Ladislav Soukup (owner: group dashboard work by Claude Code session, 2026-10-12; accepted Claude's
  defaults with "continue with your suggestions", 2026-10-13); view shape, privacy default and title event by Claude
- **Tags:** dashboard, privacy, protocol, collector
- **Brief:** [sessions-view](../briefs/sessions-view.md)

## Context

ADR-0002 made the turn the primary unit. Developers think in harness sessions (what `claude --resume` lists), and a
session's Workflow agents and flows span several turns and outlive them (ADR-0019). Sessions are stored
(`agent_sessions`, `turns.session_id`) but only appear as per-day timeline lanes. Claude Code records a session title
(`custom-title` from `/rename`, `ai-title` generated) in the transcript; the collector does not send it.

## Decision

- **A session is the `agent_sessions` row** (harness-neutral; Codex sessions included). Its span runs from the first
  turn start to the latest of the last turn end, last run end and `ended_at`.
- **New views `/sessions` and `/sessions/<id>`** read raw rows under RLS, computed in the query layer; no new table.
  Turn page, timeline lanes and `?session=` filters on `/turns` and `/flows` link into them.
- **Privacy:** in `aggregates-only` mode leads and admins see only their own sessions; no aggregate session read is
  added. In `full` mode visibility follows `/turns`.
- **Titles (phase 2):** additive v1 patch event `session_title` (`session_id`, `title` ≤ 140, `source`); custom title
  wins over the AI title, latest wins. A patch for an unknown session is parked and applied when the session
  arrives; it never creates a session. Stored on `agent_sessions`, handled like turn summaries (ADR-0004): visible
  wherever the session is, never in aggregate reads. Until then the title is the first turn's summary.

## Consequences

- No collector change for phase 1; phase 2 needs a collector release, protocol fixtures and a migration.
- Sessions follow raw retention (ADR-0012) and have no rollups; long-range session history is not available.
- A resumed or forked conversation that gets a new harness session id shows as separate sessions.

## Alternatives considered

- **Aggregate session list for leads in aggregates-only mode** (`agg_sessions`, pseudonymised): rejected
  because a session is one person's work stream (the ADR-0019 trade-off).
- **Title on `session_start` / `session_end`**: titles change mid-session (AI title early, `/rename` any time), so a
  patch event fits better.
