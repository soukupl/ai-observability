# ADR-0027: Live session status: `turn_started`, "Active now" and `ai-obs live`

- **Status:** Accepted; amended 2026-10-24
- **Date:** 2026-10-23
- **Deciders:** Ladislav Soukup (owner: asked for a live session monitor and chose the tiers, 2026-10-23; accepted the
  defaults of the brief interview); design by Claude
- **Tags:** dashboard, protocol, collector, ingest, db, privacy
- **Brief:** [live-session-monitor](../briefs/live-session-monitor.md)

## Context

Nothing reaches the server while a turn runs: the `turn` event is built at `Stop` with the whole turn's usage. A
session therefore shows on the dashboard only after its first turn ends, and "open" is a guess (no `session_end`, last
activity under 30 minutes). Summarisation ran inside the hook job under `worker.lock`, so a `Stop` that made summaries
due delayed its own `turn` event by up to 120 s. BRIEF.md §3 listed "Real-time streaming" as out of scope and ADR-0018
deferred "near-live progress events from the collector". The owner asked for a monitor of running sessions, on the
dashboard and in the developer's terminal.

## Decision

- **Wire (protocol v1, additive):** event `turn_started` (`session_id`, `turn_id` or null, `started_at`), sent by the
  main agent's prompt-submit hook (Claude Code `UserPromptSubmit`, Codex `userpromptsubmit`), task-notification prompts
  included, never for sub-agents. `turn_id` is the turn's key when the transcript already holds the prompt (Claude Code:
  the prompt uuid, matched by `prompt_id`, else by time), else null; the server does not store it. `started_at` is the
  hook time on the collector clock. The event id is derived from harness, session and time, not from `turn_id`, so a
  replay that resolves the key differently keeps its id. No new hook: the installed hook list is unchanged; running
  `init` once (no `--token`) refreshes the hook runtime.
- **Server state:** two nullable columns on `agent_sessions` (migration 0017): `current_turn_started_at` (C: null = idle)
  and `last_seen_at`, plus an index `(company_id, last_seen_at) WHERE ended_at IS NULL`. No backfill: rows from before
  0017 have no `last_seen_at` and never show as live.
- **Apply rules** (inside the session lock; `turn_started` sorts right after `session_start`):
  - `turn_started` sets C to the greater of the stored value and `started_at`.
  - A `turn` clears C when its **`ended_at`** is at or after C. Not its `started_at`: Claude Code stamps a turn with the
    prompt entry's time, which comes before the hook time. A turn that ended before C leaves it.
  - `session_end` clears C.
  - `last_seen_at` = the greater of the stored value and the event time, capped at the server clock. It is bumped by
    `session_start`, `turn_started`, `turn` (end time) and `session_end`. `run`, `turn_outcome`, `turn_summary` and
    `session_title` do not bump it: they carry no session id or no time.
  - A `turn_started` for an unknown session **creates** it (as `turn` and `session_end` do) instead of being parked:
    the parked-patch table needs a title.
  - **Resume re-opens a session.** A resumed Claude Code session keeps its id and sends no new `session_start`, so a
    `turn_started` later than `ended_at` sets `ended_at` and `end_reason` back to null. One from before `ended_at`
    leaves the session ended. Effect on `/sessions`: the "open" rule (no `session_end`, last activity under 30 minutes)
    is unchanged, but a resumed session now counts as open while active (its earlier end time and `end_reason` are
    cleared until the next `session_end`).
  - The time window is the turn's, with start = end = `started_at`: before the retention cutoff or more than a day in
    the future is rejected.
- **Grants (relaxes migration 0001's rule):** `app_ingest` gets `SELECT (current_turn_started_at, last_seen_at, ended_at)` and
  `UPDATE (current_turn_started_at, last_seen_at)` on `agent_sessions`. The `greatest()` / `case` expressions of the
  upsert read the stored row, and Postgres needs SELECT on every column it reads. Migration 0001's "identity columns only" rule
  for `app_ingest` is thereby relaxed to liveness timestamps; `started_at`, `title` and `end_reason` stay unreadable. The
  re-open runs as a separate `UPDATE ... WHERE ended_at < started_at`, so `end_reason` need not be readable either.
- **Status rules** (one pure helper, `apps/web/src/lib/live/status.ts`; the same literals in the collector):
  **working** = C set and later than the last turn end; **idle** = otherwise; **ended** = `ended_at` set. Working
  becomes **stale** when C is more than 2 h old; idle becomes stale after 30 min without a signal. There is no heartbeat,
  so the 30-minute rule never stales a working session. Stale sessions leave "Active now".
- **Dashboard:** an "Active now" strip at the top of `/sessions` and a live mode on the session page (a "Now" card, a
  "now" line on the agent graph, a refresh when the polled revision changes). Visibility is ADR-0026's: aggregates-only
  mode shows only the viewer's own sessions, user names only to full-mode leads and admins. A session without a finished
  turn now has a detail page (`sessionSql` left-joins turns), so strip links do not 404; the `/sessions` list still
  finds sessions only through turns.
- **Transport:** client polling every 10 s while the tab is visible of read-only JSON routes
  `GET /api/live/sessions` and `GET /api/live/sessions/<id>`, under the same RLS context as the pages, `no-store`, with
  `?company=` bound to the active company (409 on mismatch; removed by ADR-0028, see the amendment). Elapsed timers tick on the client between polls. Polling
  keeps the login session sliding (`touchSession`, `lib/auth/login.ts:245`), so a tab left open does not time out
  while the tab is visible.
- **Summaries after the flush (summaries.lock):** the hook job only stages due digests to
  `state/summaries/staged/<harness>/<ulid>.json`; after its flush, the worker summarises them under a new
  `~/.ai-obs/summaries.lock` (outside `worker.lock`), then takes `worker.lock` briefly to queue the `turn_summary` events and
  send them in a second flush. A `Stop` is no longer delayed by the model call, and the next prompt's `turn_started` is
  not held back. A timed-out batch or one whose commit is refused changes nothing and is retried by the next run; a
  failed model call moves the digests to the pending file with one more attempt; the summary keeps a stable
  event id because its time is the digest's first staging or failure time. A `UserPromptSubmit` never ends its own
  prompt's turn, so a late worker cannot emit a `turn` for a running turn.
- **`ai-obs live`:** a local-only terminal view of the Claude Code and Codex sessions on the machine (status, elapsed,
  tokens, ≈ cost at default list prices, tools, sub-agents, last tool). It reads hook state files and transcripts or
  rollouts read-only from its own in-memory cursor, sends nothing and writes nothing. The collector keeps a copy of the
  default price table (a test keeps it equal to `@ai-obs/db`'s; the runtime stays dependency-free).
- Collector 0.4.0. Older collectors send no `turn_started`, so their sessions never show as working.
- BRIEF.md §3's "Real-time streaming" becomes "beyond 10 s polling of session status".

## Consequences

- A migration (0017) and a collector release. Rebuild the server first: an older server rejects `turn_started` per
  event and accepts the rest of the batch (`validateBatch`), so a 0.4 collector against it only loses its live status
  until the server is upgraded; nothing is dead-lettered.
- A running turn's tokens arrive only when it ends; the strip shows elapsed time and the totals of finished turns.
- A crashed harness shows as working for up to 2 h; a stale row then drops out.
- The Overview ingest card counts `turn_started` under "sessions".
- Follow-ups, not built: an in-turn heartbeat (`PostToolUse`, running tokens), mid-turn runaway alerts that the heartbeat
  would enable (follows up ADR-0018's deferral), and SSE or LISTEN/NOTIFY instead of polling.

## Alternatives considered

- **A SECURITY DEFINER touch function** instead of column grants: keeps `app_ingest` unable to read the table, but adds
  a function per liveness write; the column grants expose only timestamps.
- **Parking `turn_started` for an unknown session** like a title: rejected, the parked table requires a title and the
  session would not show until `session_start`.
- **SSE or LISTEN/NOTIFY:** later, only if 10 s polling proves too slow or too costly.
- **Summarising inside `worker.lock`** (as before): delays the next prompt's `turn_started` by up to 120 s per chunk.
- **Clearing C by `turn.started_at`** (the brief's first draft): wrong for Claude Code, whose turn starts at the prompt
  entry, before the hook time.

## Amendment 2026-10-24 (ADR-0028)

- The live routes no longer take `?company=` and have no 409: they authenticate by session only (401 `unauthorized`,
  and 404 `not_found` on the detail route). The client poll halts on 401, 403 and 404.
- The index is now `agent_sessions_last_seen_idx` on `(last_seen_at) WHERE ended_at IS NULL` (migration 0018).
- The collector release that carries `turn_started` is 0.5.0; 0.4.0 was never published.
