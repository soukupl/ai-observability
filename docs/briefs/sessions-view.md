# Brief: Sessions view (group turns, workflows and flows by harness session)

Status: **Agreed 2026-10-13** (owner asked: "can we somehow group the work in the console to the same sessions as we
have in claude code?", "yes, our dashboard — write the brief", then "continue with your suggestions", which accepted
every default below, phases 1 and 2 in one batch). ADR: [0026](../adr/0026-sessions-view-and-titles.md).

## Goal

See the work of one Claude Code (or Codex) session as one thing: its turns in order, the workflows and agent flows
they launched, totals, and the id needed to `claude --resume` it. Today a session appears only as a lane on the Agents
timeline, one day at a time.

## What exists (no collector change needed for phase 1)

- `agent_sessions` (one row per harness session; `external_id` = `<harness>:<session id>`, `started_at`, `ended_at`,
  `end_reason`, project, machine, user, team). Created on `session_start`, or on the fly when a turn arrives first.
  The dashboard never reads it today.
- `turns.session_id` (indexed, `turns_session_idx`); runs belong to turns, Workflow agents included (ADR-0019), so
  workflows (`orchestration_id`) and flows (ADR-0020, ADR-0025) group by session through their turn.
- Workflow agents outlive their turn; a session's span therefore ends at its last run, not its last turn.

## Phase 1 — Sessions view (dashboard only)

**`/sessions` list** (nav entry "Sessions", right before "Turns"):

- One row per session that overlaps the filter range (span = first turn start … max(last turn end, last run end,
  `ended_at`)). Built: candidates are sessions with a filter-matching turn started in the range or up to a day before
  it; a session whose only in-range activity is runs more than a day after its last turn is missed. Uses the existing FilterBar (range, team, project, harness, user when allowed); sort by start, newest
  first; paged like `/turns`; CSV export.
- Columns: title (phase 1: the first turn's summary, else "Session <first 8 chars of id>"), project, harness, user
  (only when `canSeeUsers`), started, active span, turns, sub-agent runs, workflows (distinct `orchestration_id`),
  flows, tokens, ≈ cost, outcome mix (success / failed / abandoned / unknown counts), "open" badge when no
  `session_end` arrived and the last activity is under 30 minutes old.

**`/sessions/<id>` detail:**

- Header: title, project, harness, user (when allowed), start, end / end reason, the harness session id with copy
  buttons for the id and the resume command (`claude --resume <id>`; `codex resume <id>` for Codex).
- KPI tiles: turns, runs, workflows, flows, tokens, ≈ cost, active time, outcome mix.
- Agent graph (the ADR-0019 component) with one lane over the whole session span, not clipped to a UTC day, with the
  timeline's drag-to-zoom.
- Turns table in order: time, summary, outcome, duration, tokens, ≈ cost, runs; each turn row expands to its flows
  (link `/turns/<id>#flow-<key>`) and its workflows (by `orchestration_id`, with step count and time span).
- Skills & MCP card for the session (merged uses of its turns and runs, `mergeUses`).

**Links into it:**

- Turn page: "Session: <title> →" in the header facts.
- Agents timeline: session lane labels link to `/sessions/<id>` (only where the viewer reads raw rows; pseudonymised
  aggregate lanes stay unlinked).
- `/turns?session=<uuid>` and `/flows?session=<uuid>` filters (and their CSV exports), shown as a removable chip; the
  session page links to both. Built: the session filter ignores the date range and the filter bar (a note says so).

**Query layer:** `apps/web/src/lib/queries/sessions.ts` (`listSessions`, `getSessionDetail`) over raw `agent_sessions`
/ `turns` / `runs` under RLS, reusing the flow computation of `flows.ts` and the cost helpers. No new table. One
migration only if a missing index or grant shows up in the query plans (likely an index on `agent_sessions
(company_id, started_at)`).

**Privacy default:** a session is one developer's stream of work, so in `aggregates-only` mode leads and admins see
**only their own sessions** on `/sessions` (with the existing visibility banner explaining why); in `full` mode they see
their teams' sessions by person, as on `/turns`. No `agg_sessions` function in phase 1. Members always see their own.

**Retention:** sessions follow raw retention (ADR-0012); there are no session rollups. A session partly cut by
retention shows the turns still kept and says so.

## Phase 2 — session titles from the harness (collector + protocol)

- Claude Code writes `{"type":"custom-title","customTitle":…}` (from `/rename`) and `{"type":"ai-title","aiTitle":…}`
  entries into the session transcript (verified on the owner's machine: both present). Those are the names in the
  `/resume` picker.
- The collector adapter reads the latest title (custom wins over AI) while parsing the transcript and sends a new
  additive v1 patch event `session_title` (`session_id`, `title` ≤ 140 chars, `source: 'custom' | 'ai'`) when it
  changes. Ingest stores `agent_sessions.title` / `title_source` (migration); a patch for a session not yet known
  creates nothing; it is parked like turn patches and applied when the session arrives.
- Titles are model- or user-written text derived from the conversation, like turn summaries (ADR-0004), so they get
  the same handling: shown to whoever may see the session, never in aggregate reads.
- Codex: no title source known; keeps the phase-1 fallback.
- Ships as a new collector npm version (`npm i -g ai-obs@latest`, no re-init, tokens unchanged).

## Out of scope

- Grouping several sessions into one "task" (e.g. by branch or by resume chain); editing titles in the dashboard;
  session-level outcome scoring beyond the turn outcome mix; anything in the Anthropic Console (it sees API keys only).

## Done when

- `/sessions` list and detail, links from turn page / timeline, `?session=` filters on `/turns` and `/flows`.
- Unit tests for the query layer (span with runs outliving turns, open sessions, retention-cut sessions, outcome mix,
  workflow and flow counts); RLS tests: member sees own, lead sees team in `full`, lead sees only own in
  `aggregates-only`.
- Phase 2: protocol fixtures + conformance tests, collector tests for title parsing (custom over AI, last wins),
  ingest test for the patch and the ownership rule.
- README dashboard section, `ARCHITECTURE.md` (Sessions view, `session_title` event), ADR-0026 accepted, Docker
  rebuilt; ship check before commit.

## Owner decisions (2026-10-13: Claude's defaults accepted)

1. **Aggregates-only visibility**: leads / admins see only their own sessions (no per-project anonymous list).
2. **Resume behaviour**: a resumed conversation that gets a new session id shows as two sessions; linking them is out
   of scope.
3. **Phase 2 now**: titles are built in the same batch (needs a collector release).
4. **Title patch before its session**: parked like turn patches and applied when the session arrives.
