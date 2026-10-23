# Brief: Live session monitor (running sessions on the dashboard, `ai-obs live` on the machine)

Status: **Agreed 2026-10-23** (owner asked: "can we build some kind of live session monitor dashboard when the
session is running?"; chose "ship the first two tiers together … plus local-only live terminal", then accepted the
defaults of Q2–Q8 below with "yes"). ADR: [0027](../adr/0027-live-session-status.md).

## Goal

See which sessions are running right now, whether each one is working or idle and for how long, and what it has
consumed so far, with seconds-level freshness, both on the dashboard (team or own sessions, per the privacy mode) and
in the developer's own terminal (sub-second, local only).

## What exists (facts from the code, 2026-10-23)

- The collector registers `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SubagentStop`, `SessionEnd`
  (`packages/collector/src/adapters/claude-code/settings.ts:14`). Nothing is sent while a turn runs: the `turn` event
  is built at Stop with the whole turn's usage, phases, tools, skills and MCP (`session.ts:136-170,262-288`).
  `UserPromptSubmit` already runs the worker, but only emits `turn_outcome` patches for earlier turns.
- `session_start` is sent on the first hook of a session and creates `agent_sessions` with `ended_at` null;
  `session_end` sets `ended_at` / `end_reason`; a crash is synthesised only after 24 h of silence.
- Delivery is per hook with no debounce: the detached worker POSTs right after its jobs (`worker.ts:174-181`),
  roughly 0.3–2 s after the hook (estimate, not measured). **Stall:** summarisation runs inside the job before the
  flush (`handlers.ts:150-161`), so a Stop that makes summaries due delays its own `turn` event by up to 120 s.
- The dashboard has no polling, SSE or UI JSON routes; pages are server components with `now` fixed at render.
  `/sessions` inner-joins turns, so a session without a finished turn is not listed. The "open" badge =
  `ended_at` null and last activity < 30 min (`apps/web/src/lib/queries/sessions.ts:40,205`).
- `turn` and `run` require `started_at` and `ended_at` (protocol), so they cannot represent work in progress.
  Additive v1 patch events have a precedent (`session_title`, ADR-0026).
- BRIEF.md §3 lists "Real-time streaming (minutes of latency is acceptable)" as out of scope; ADR-0018 deferred
  "near-live progress events from the collector".

## Decisions (one per question of the brief interview)

| # | Question | Decision |
|---|---|---|
| Q1 | How live is live enough | Tiers 1 + 2: dashboard "Active now" + auto-refreshing session page, plus a cheap `turn_started` event for working / idle / stale with an elapsed timer; the summarisation stall fix rides in the same collector release; **plus** a local-only live terminal. The in-turn heartbeat (PostToolUse, running tokens) is deferred until hook-to-server latency and per-tool-call hook cost are measured. |
| Q2 | Local live terminal | `ai-obs live`: plain terminal view redrawn in place, no new dependencies, every open session on the machine by default, `--cwd` narrows to the current repository; Claude Code first, Codex where the rollout files parse with the existing adapter. |
| Q3 | Who sees running sessions | Exactly the ADR-0026 rule: full mode follows `/turns`; aggregates-only shows only the viewer's own sessions; same RLS helpers, no new aggregate read. |
| Q4 | Placement | An "Active now" strip at the top of `/sessions`, each row linking to the session page; the session page refreshes itself while open (now-line on the graph, current-turn card with a ticking timer). No new nav item. |
| Q5 | Transport | Client polling of a JSON route every 10 s while the tab is visible, under the same user-scoped RLS helper as the pages; the timer ticks locally between polls. SSE is a later upgrade only if needed. |
| Q6 | Status rules | **working** = a turn started and no Stop yet; **idle** = last Stop < 30 min ago; **stale** = no signal for 30 min, or "working" for > 2 h without a Stop. A session leaves the strip at `session_end` or when stale. Constants in one helper, not per-company settings. The existing 30-min "open" badge keeps its constant. |
| Q7 | Codex parity | Both adapters emit `turn_started` from their existing prompt-submit hook, with shared protocol fixtures. |
| Q8 | Brief and ADRs | ADR-0027 (2026-10-23, decider Ladislav Soukup) amends BRIEF.md's out-of-scope line and records mid-turn runaway alerts as a later follow-up the heartbeat could enable. Not built now. |

## Scope of this slice

### Collector (`@soukupl/ai-obs` 0.3.0 → 0.4.0; owner publishes, then re-installs)

1. **`turn_started` event** (additive v1): `session_id`, `started_at` (hook receive time), `harness`, and the turn
   key when the transcript already holds the prompt's uuid, else null (correlation is by session + time on the
   server). Emitted by the Claude Code `UserPromptSubmit` handler and the Codex prompt-submit handler, for main-agent
   prompts only. No new hook, so no `init` is needed for the hook list; the usual re-install picks up the version.
2. **Summarise after the flush**: the worker enqueues and flushes the hook's events first, then runs the due
   summarisation and flushes again (or as its own job). Tests on job ordering.
3. **`ai-obs live`**: reads the open sessions' transcript / rollout files from a byte offset (read-only; never touches
   the hook state files or offsets), reuses `readTranscript` / `analyzeEntries`, redraws about once per second, `q`
   quits. Per session: title, project, harness, working / idle + elapsed, running tokens and ≈ cost (local price
   table as the dashboard's), tool and sub-agent counts, last tool name. `--cwd` filter. Shown in `ai-obs --help`.

### Protocol (`packages/protocol`)

- `turn_started` zod schema and union entry, fixtures (accepted + duplicate), limits.

### Ingest and DB (migration 0017)

- `agent_sessions.current_turn_started_at` (set by `turn_started`, cleared by a `turn` whose `started_at` ≥ it or
  by `session_end`) and `agent_sessions.last_seen_at` (greatest of existing and the event time, bumped by every
  session-bound event). `app_ingest` column GRANTs; an index for the live query (`company_id`, `ended_at`,
  `last_seen_at`) if the plan needs it. `turn_started` for an unknown session is parked like `session_title`.
- `TYPE_ORDER`, `applyEvent`, `batchSessionKeys` updated. Every event still writes one ledger row (idempotent).

### Web (`apps/web`)

- `lib/live/status.ts`: pure helper computing working / idle / stale and elapsed from the session columns and `now`
  (unit-tested; the thresholds live here).
- `lib/queries/sessions.ts`: `listActiveSessions(ctx, now)` over `agent_sessions` **left-joined** to turns and runs
  (turnless sessions appear), ADR-0026 visibility, returning status, since, turns, runs, tokens, ≈ cost, title.
- JSON route (e.g. `app/api/live/sessions/route.ts`, and `…/sessions/<id>`) under `withUserDb`, no-store.
- "Active now" strip on `/sessions` (client component: polls every 10 s while visible, local ticking timer; shows a
  one-line "No sessions running" when empty). Session detail: live mode while the session is not ended (same poll,
  now-line on `SessionGraph`, current-turn card: status, elapsed, totals so far). No in-turn tokens in this slice.
- CSV exports unchanged.

### Docs and records

- ADR-0027 + `docs/adr/README.md` entry; BRIEF.md §2 row 28 and the §3 out-of-scope line amended; ARCHITECTURE.md
  (data flow, domain model: session status), README / collector README / web README (`ai-obs live`, Active now).

## Out of scope (explicitly)

- In-turn heartbeat (`PostToolUse`, `turn_progress`, live-state table), mid-turn runaway alerts, SSE / LISTEN/NOTIFY,
  a `/live` nav item or wall display, a localhost web page for the local monitor, any change to privacy modes.

## Definition of done

- Collector, protocol, ingest and web tests green (existing 1481 + new: job ordering, `turn_started` fixtures,
  status helper, active-sessions query, live command parser/renderer).
- Ship check passed; docs and ADR updated; Docker rebuilt (`docker compose up -d --build`).
- Owner publishes 0.4.0 and re-installs; a real Claude Code session shows **working** in the strip within seconds of
  a prompt and **idle** after Stop; `ai-obs live` shows the same session locally.

## Built (2026-10-23)

Built as agreed, with these deviations (recorded in ADR-0027):

- A `turn` clears `current_turn_started_at` when its `ended_at` is at or after it, not when its `started_at` is (Claude
  Code stamps a turn with the prompt entry's time, before the hook time). The turn key is not stored server-side.
- A `turn_started` for an unknown session creates the session instead of being parked (the parked-patch table needs a
  title).
- A resumed session is re-opened: a `turn_started` later than `ended_at` sets `ended_at` and `end_reason` back to null.
  This runs as a separate `UPDATE`, because `app_ingest` cannot read `end_reason`; its grants are only
  `SELECT (current_turn_started_at, last_seen_at, ended_at)` and `UPDATE (current_turn_started_at, last_seen_at)`.
- `last_seen_at` is nullable with no backfill, and the index is `(company_id, last_seen_at) WHERE ended_at IS NULL`
  instead of `(company_id, ended_at, last_seen_at)`. Only `session_start`, `turn_started`, `turn` and `session_end` bump
  it, capped at the server clock. Sessions from before migration 0017 never show as live.
- A working session is never staled by the 30-minute rule (no heartbeat); only the 2 h rule applies.
- Summaries run under their own `summaries.lock` from a staged spool of digests, not as a job after the flush, and a
  `UserPromptSubmit` never ends its own prompt's turn.
- `turn_started.event_id` leaves `turn_id` out of its seed so a replay keeps its id.
- The session detail page works for a session with no finished turn (`sessionSql` left-joins turns), so strip links do
  not 404; the `/sessions` list still finds sessions only through turns.
- `ai-obs live` drops its least important columns on a narrow terminal, and a non-terminal `--once` frame is cut at 200
  columns. The collector keeps a local copy of the default price table, tested against `@ai-obs/db`'s.
- The Overview ingest card counts `turn_started` under "sessions". BRIEF.md got a new row 28, not an amended row.
