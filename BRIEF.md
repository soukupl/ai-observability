# AI Observability — Design Brief

- **Status:** Accepted — amended 2026-10-24 (one deployment = one company, per-user tokens; ADR-0028..0030); owner instructed "start coding the project" on 2026-10-05; §13 open items resolved with the proposed defaults unless noted in docs/adr
- **Date:** 2026-10-05
- **Owner / decider:** Ladislav Soukup
- **Working name:** `ai-obs` (placeholder — see Open items)

Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [ADRs](docs/adr/README.md)

## 1. Goal

A self-hosted tool, one deployment per company, that shows a company's teams and individual developers **how AI coding agents are
used**: which projects, models and effort levels, how many tokens and how much (estimated) money,
where the time goes (thinking / coding / testing / documenting / validating), how sub-agents are
used, and how often work succeeds.

Data is collected by a tiny, zero-dependency **collector** installed into the developer's AI harness
(Claude Code and OpenAI Codex first). It reads exact numbers from harness hooks and local transcripts
— no LLM self-reporting — and pushes batched, idempotent events with a personal token. A repository says which team it reports to in a
committed dot file; a developer logs in from the terminal and may hold one token per server.

The design is now being implemented; see README.md for the build.

## 2. Decisions at a glance

| # | Topic | Decision | ADR |
|---|---|---|---|
| 1 | Capture | Hybrid: hooks + local transcript parsing for all numbers; a cheap LLM only for summaries | [0001](docs/adr/0001-capture-via-hooks-and-transcripts.md) |
| 2 | Harnesses | Harness-neutral ingest format; Claude Code + Codex collectors first, others as adapters | [0005](docs/adr/0005-harness-neutral-ingest-format.md) |
| 3 | Unit of work | **Turn** (user prompt → agent stops). Sessions group turns; sub-agent **runs** nest in turns | [0002](docs/adr/0002-turn-as-primary-unit.md) |
| 4 | Outcome | Derived from **signals only** (no LLM judge, no user rating) | [0003](docs/adr/0003-outcome-from-signals-only.md) |
| 5 | Summaries | **Always on**, generated **locally** by the harness's cheapest model, batched at session end | [0004](docs/adr/0004-local-summaries-by-cheap-model.md) |
| 6 | Project identity | Normalized git remote; the deployment can switch to **hashed** mode | [0008](docs/adr/0008-privacy-modes.md) |
| 7 | Ingest tokens | **Per-user** tokens (`aiobs_u_`), one user's each: made by `ai-obs login` (device code approved in the browser, fixed 90-day expiry) or manually (lifetime 30 / 90 / 365 days or none), and **service-user** tokens made by admins for CI and shared machines. Company tokens are gone. A machine holds one token per server | [0029](docs/adr/0029-per-user-tokens-device-login-expiry.md) (supersedes [0007](docs/adr/0007-ingest-tokens.md)) |
| 8 | Teams | One deployment = one company with many teams; a user may belong to many teams (role `member` or `lead`) and has a primary team; each turn is attributed to at most one team, chosen by admin mapping, then the repository's dot file, then the primary team | [0028](docs/adr/0028-one-deployment-one-company.md), [0030](docs/adr/0030-project-dot-file-and-team-resolution.md) |
| 9 | Individual visibility | Per-deployment mode: **aggregates-only (default)** or full detail; mode visible to all users | [0008](docs/adr/0008-privacy-modes.md) |
| 10 | Dashboard login | Magic link + Google/GitHub OAuth; first admins from `ADMIN_EMAILS`, others by invitation or `ALLOWED_EMAIL_DOMAINS`; SSO (SAML/OIDC) out of scope | [0013](docs/adr/0013-dashboard-authentication.md) |
| 11 | Stack | TypeScript; Next.js (App Router), Postgres, Drizzle, Tailwind, Recharts; Node collector | [0009](docs/adr/0009-tech-stack.md) |
| 12 | Isolation | One company per deployment; Postgres **RLS** around users and teams (own rows, led teams, admin); no platform role, no super admin | [0028](docs/adr/0028-one-deployment-one-company.md) (supersedes [0006](docs/adr/0006-tenant-isolation-with-rls.md) in part) |
| 13 | Cost | Estimated cost at **API list prices** from a dated price table, computed at query time | brief only |
| 14 | Retention | Per-deployment, 30 days – 24 months raw, **default 13 months**; daily rollups kept forever | [0012](docs/adr/0012-retention-and-rollups.md) |
| 15 | Delivery | Local file queue + retry; client-generated event IDs; server de-duplicates | [0011](docs/adr/0011-local-queue-idempotent-delivery.md) |
| 16 | Install | One CLI: `npx ai-obs-cli login --server <url>` (device code, or `--token`), `npx ai-obs-cli init` configures every detected harness, `ai-obs link --team <slug>` writes the repository's dot file `.ai-obs.json` | [0029](docs/adr/0029-per-user-tokens-device-login-expiry.md), [0030](docs/adr/0030-project-dot-file-and-team-resolution.md) |
| 17 | Dashboard | All eight views in v1 (see §8) | brief only |
| 18 | Alerts | Monthly token/cost budgets per team/user, e-mail at 80 % / 100 %, never blocking | brief only |
| 19 | ~~Billing~~ | ~~Plans + limits~~ — dropped 2026-10-24: self-hosted, no plans, no payments | [0028](docs/adr/0028-one-deployment-one-company.md) |
| 20 | Hosting | All backend services **provisioned with Docker** (Compose: web, worker, migrate, postgres); **self-hosted only**, one deployment per company (the ~~official EU SaaS~~ is dropped) | [0010](docs/adr/0010-portable-eu-hosting.md), [0028](docs/adr/0028-one-deployment-one-company.md) |
| 21 | Data access | CSV export of every telemetry table view (RLS-scoped, audit-logged; admin tables are administration data, not telemetry, and have no CSV; the audit log has its own export); no public read API | brief only |
| 22 | Skills & MCP | Skill uses (model-invoked vs typed `/skill`) and MCP calls per server × tool, by name, plus MCP errors, denials and latency; names follow the project-naming mode (hashed on the machine) | [0016](docs/adr/0016-skill-and-mcp-usage.md) |
| 23 | Insights | Wasted spend (≈ cost of failed / abandoned turns), skill impact (vs comparable turns), effort suggestions; rollups keep tokens and skill outcomes split by outcome | [0017](docs/adr/0017-outcome-insights.md) |
| 24 | Runaway alerts | Turns far above the user's normal, over a ≈ cost or duration threshold, flagged by the worker after the turn ends; hourly digest to the user (+ leads in full mode, anonymous to admins otherwise); never blocks | [0018](docs/adr/0018-runaway-alerts.md) |
| 25 | Agent groups & timeline | Sub-agent runs carry an optional `agent_group` and `orchestration_id`; the Agents view groups types by it and draws a git-graph timeline (one lane per session, coloured by project, one UTC day, hour zoom) | [0019](docs/adr/0019-agent-groups-and-timeline.md) |
| 26 | Agent flow | Runs carry an optional `stage_index`, `flow_key` and incoming `links` (`item` / `sequence`); `sequence` links are also derived on read for older Agent-tool runs; an "Agent flow" card (lanes = workflow runs / a turn's spawns, rows = stages, arrows = links) under the timeline on the Agents page and turn detail | [0020](docs/adr/0020-agent-flow-links.md) |
| 27 | Agent flows view | `/flows` lists whole flows of ≥ 2 sub-agent runs of one turn (a workflow run, a turn's legacy workflow runs, or Agent-tool runs joined by links) with steps, stages, duration, tokens, ≈ cost, models and outcome (CSV); a detail page per flow shows its steps, flow chart, skills & MCP calls, time by stage and phases per step | [0020](docs/adr/0020-agent-flow-links.md) (amendment 2026-10-08) |
| 28 | Live sessions | `turn_started` event; working / idle / stale with elapsed time on `/sessions` "Active now" (10 s polling) and the session page; local `ai-obs live` terminal | [0027](docs/adr/0027-live-session-status.md) |
| 29 | One deployment = one company | `companies` and every `company_id` leave the schema; a one-row `deployment` table holds name, slug, settings and project salt; the dev database's four companies are merged into SPECTADO by a one-off script before migration 0018 | [0028](docs/adr/0028-one-deployment-one-company.md) |
| 30 | Device login and token expiry | `ai-obs login` pairs a device code with a browser approval at `/device`; device tokens last a fixed 90 days (collector warns 14 days before); service users for CI | [0029](docs/adr/0029-per-user-tokens-device-login-expiry.md) |
| 31 | Dot file and team resolution | Committed `.ai-obs.json` (`server`, `team`) with git-ignored `.ai-obs.local.json` override; admin mapping wins, else a dot-file team the user belongs to, else the primary team; refusals come back as ingest warnings | [0030](docs/adr/0030-project-dot-file-and-team-resolution.md) |

## 3. Scope

### In scope (v1)

- Collector CLI (`ai-obs`) with Claude Code and Codex adapters, local queue, local summaries.
- Ingest API (`POST /api/v1/ingest`) and collector config API.
- Single-company model: deployment → team → user, roles, invitations, per-user and service-user tokens, device login.
- Dashboard: Overview, Projects, Models & effort, Phases, Agents, Turns explorer, Admin.
- Budgets with e-mail notifications.
- Retention jobs, daily rollups, CSV export, audit log.
- Light / dark mode, responsive Tailwind UI.

### Out of scope (v1)

- Payments, plans, billing; a hosted multi-tenant service (one deployment serves one company).
- SSO (SAML/OIDC), SCIM provisioning; service users that can log in; OAuth / refresh tokens for the CLI (re-run `ai-obs login` after 90 days).
- Public read API, BI connectors.
- Custom alert rules, Slack / webhook delivery.
- LLM judging of outcomes; user ratings (`/obs good|bad`).
- Blocking or rate-limiting the harness (budgets only notify).
- Storing prompts, responses, code, diffs or file paths.
- Real-time streaming beyond 10 s polling of session status (ADR-0027); in-turn progress is a later follow-up.
- Collectors for harnesses other than Claude Code and Codex (format is ready for them).
- Per-person ranking views.

## 4. Tenancy, roles and permissions

```
Deployment (one company; name, slug, settings)
├── Team ── memberships (member | lead)
└── Membership ── user (role: admin | member; primary team)
```

- One deployment serves one company. A **user** (a `person` with a login, or a `service` user made by an admin) holds one
  **membership** (role `admin` or `member`, primary team) and belongs to any number of teams (role per team: `member` or
  `lead`; a team may have several leads). A developer who works for several companies logs in to several servers.
- There is no platform operator: the first admins come from `ADMIN_EMAILS` and everyone else joins by invitation or
  through `ALLOWED_EMAIL_DOMAINS`.

| Capability | Admin | Team lead | Member |
|---|---|---|---|
| See any telemetry | ✅ all* | ✅ own teams* | ✅ own only |
| Manage teams, members, roles, invitations, service users | ✅ | – | – |
| Map projects → teams, name projects | ✅ | – | – |
| Deployment settings (privacy mode, project naming, retention, runaway thresholds), model prices | ✅ | – | – |
| Own tokens (device logins, manual with a lifetime) | ✅ | ✅ | ✅ |
| See and revoke every token, create service-user tokens | ✅ | – | – |
| Budgets | ✅ all | ✅ own teams (view) | own (view) |
| CSV export | ✅ | ✅ | ✅ (own data) |

\* Subject to the deployment's **individual-visibility mode**:

- **Aggregates-only (default):** leads and admins see totals and breakdowns by team / project / model /
  phase / agent, but **no per-user rows, no per-user turn lists, no names on turns**. Turn summaries are
  shown without attribution. Each user always sees their own full detail.
- **Full detail:** leads see every turn of their teams by person; admins everything.
- The active mode is displayed to every user (banner in settings + footer).

**Team attribution of a turn** (first match wins, decided once per session at `session_start`): (1) the admin's project → team
mapping, (2) the team named in the repository's dot file, if the user is a member of it (otherwise the ingest response carries a
`team_not_member` / `team_unknown` warning and resolution continues), (3) the user's primary team, (4) none.

## 5. Data capture (collector)

### 5.1 Install and runtime

- `npx ai-obs-cli login --server <url>` — the device flow: the CLI prints `Open <url>/device and enter the code XXXX-XXXX`,
  opens the browser, the user approves, the CLI stores a 90-day token for that server in `~/.ai-obs/config.json` (mode 0600).
  `login --token <t>` stores a pasted token instead. One token per server; a machine may hold several servers.
- `npx ai-obs-cli init [--project]` — detects installed harnesses and writes hook config (user-level by default, repo-level
  with `--project`; no token is ever written into a repo). `init --token <t> --endpoint <url>` stays as the non-interactive alias.
- `ai-obs link --team <slug> [--server <url>] [--local]` — writes the repository's dot file `.ai-obs.json` (`{ "server", "team" }`,
  committed; `--local` writes the git-ignored `.ai-obs.local.json` that overrides it per key), validating the team against the
  server. The collector sends only to servers it holds a token for, so a committed server URL can never leak a token elsewhere.
  Without a dot file a repository reports to the only registered server (no team: the server applies mapping, then primary team);
  with two or more servers its events are held locally until `ai-obs link`.
- **Status:** collector 0.5.0 (0.4.0 was never published; 0.5.0 also carries the live-session work). Files: `~/.ai-obs/config.json`
  v3 (`servers[]`: endpoint, token, e-mail, deployment, label, expiry, source), `~/.ai-obs/state/` (per-session transcript cursors,
  per-server collector-config cache and delivery state, project-key and dot-file caches, `warnings.json`), `~/.ai-obs/queue/`
  (capped ~50 MB / 30 days: one stream per project, server and team under `queue/p/s-<id>/`). Streams that cannot be sent (no
  server, rejected token, opted out) are exempt from the 30-day age cap, which counts from when a stream became sendable and
  does not run while the token is refused with 401; the size cap applies to all and its drops are counted and shown.
- Commands: `login`, `init`, `link`, `token list|remove <server>`, `doctor`, `status`, `flush`, `live`, `uninstall`. `status` and
  `doctor` show, per server, the token state and expiry, and for this repository its server, team and dot-file validity.
- Each session is pinned once, at its first hook, to its stream (project key, server, team slug); a dot file changed mid-session
  never retargets a running session.
- The `SessionStart` hook (JSON `additionalContext` for Claude Code, plain text for Codex) prints a nudge only in these cases:
  no dot file while two or more servers are registered, the repository's server has no token or an expired / rejected one, a
  token expires within 14 days, events were dropped, or the server ignored the repository's dot-file team (latest ingest warning). Local files and a bounded git call only; no network.
- A token lasts at most 90 days from `login`; the collector keeps the expiry locally, warns 14 days before and then asks for
  `ai-obs login` again. Admins can issue service-user tokens (CI, bots, shared machines) that never use the device flow.
- Node ≥ 20, **zero runtime dependencies**. Hook handlers return in < 100 ms of in-process time from hook entry (Node
  start-up, about 60-85 ms, is not counted; ADR-0030 C27) and spawn a detached worker for parsing, summarizing and
  sending. On a project-key cache miss the SessionStart hook runs git for at most 40 ms; when git is slower, that session
  gets no question (its events are kept) and the next one asks.
- On start, the collector fetches `GET /api/v1/collector-config` (cached per server) to learn the deployment's
  **project-naming mode** (and its `project_salt`, which keys the hash), so hashing happens on the machine; the response also lists the
  user's teams (for `link`) and the token's expiry.

### 5.2 Hooks used

| Harness | Hooks | Source of numbers |
|---|---|---|
| Claude Code | `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SubagentStop`, `SessionEnd` | Session transcript JSONL + sub-agent transcripts (`subagents/agent-<id>.jsonl` + `.meta.json` with parent `toolUseId`) |
| Codex | `session_start`, `user_prompt_submit`, `stop`, `subagent_stop` (+ `SessionEnd` if available) | Rollout JSONL in `~/.codex/sessions/…` (`turn_context`, `token_count`, `task_complete`) |

Crashed sessions (no `SessionEnd`) are swept on the next `SessionStart`.

### 5.3 What is measured

Per turn and per run: model(s), effort level, input / output / cache-read / cache-write / reasoning
(thinking) tokens (de-duplicated per API response), start, end, duration, tool-call counts, files
touched (count only), lines added / removed, phase durations, outcome, summary. Also skill uses by skill
name (split into started by the model and typed by the user as `/name`) and MCP calls by server × tool; in
`hashed` project-naming mode these names are hashed on the machine
([ADR-0016](docs/adr/0016-skill-and-mcp-usage.md), [brief](docs/briefs/skills-and-mcp-stats.md)). Per MCP tool also
errors, calls the user refused, and latency (total and a 5-bucket histogram); never error texts
([brief](docs/briefs/mcp-reliability.md)).

### 5.4 Phase classification (no LLM)

Time between transcript entries is assigned to a phase by the activity occupying it. Rules are
versioned (`phase_rules_version` stored per turn) so they can be improved later.

| Phase | Rule |
|---|---|
| `thinking` | Model generation time not followed by a tool call of another phase (incl. thinking blocks, final answer) |
| `exploring` | Read / Grep / Glob / LS, `cat`/`rg`/`find`-type shell commands, web search / fetch |
| `coding` | Edit / Write / patch tools on non-documentation files |
| `documenting` | Same tools on `*.md`, `*.rst`, `*.txt`, `docs/**`, `README*`, `CHANGELOG*` |
| `testing` | Shell commands matching test runners (`npm test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `xcodebuild test`, …) |
| `validating` | Lint / type-check / build commands (`eslint`, `tsc`, `cargo check`, `swift build`, `npm run build`, …) |
| `delegating` | Waiting for sub-agents — **excluded** from the parent run's totals (counted in the child run) to avoid double counting |
| `other` | Everything else (git, package installs, MCP tools, …) |

### 5.5 Outcome (signals only)

Statuses: `success`, `failed`, `abandoned`, `unknown`. Signals that set them, stored as `outcome_signals[]`:

- `failed` — turn ended with an API / harness error (`StopFailure`), or the **last** test / validate
  command in the turn exited non-zero.
- `abandoned` — user interrupted the turn.
- `failed` (retroactive) — the next prompt in the session looks like a correction
  (heuristics, EN + CZ initially: "no", "wrong", "revert", "undo", "that's not", "špatně", …), or the
  next turn reverts this turn's edits. Detection runs **locally**; the prompt is never sent.
- `success` — last test / validate passed, or no failure signal and the next prompt is not a correction.
- `unknown` — none of the above (e.g. last turn of a session with no tests).

Because correction signals arrive with the next turn, the collector sends the turn at `Stop` with a
provisional outcome and later sends a `turn_outcome` patch event.

### 5.6 Summaries (always on, local)

- The collector builds a condensed local digest per finished turn (truncated prompt, tool names, last
  assistant message) and makes **one batched headless call** to the harness's cheapest model
  (`claude -p --model haiku …` / `codex exec -m <mini model> …`) at `SessionEnd`, or earlier once
  10 turns are waiting or the first waiting turn is 10 minutes old (ADR-0023), so a long session does
  not leave its turns without summaries for hours. The call runs after the hook's events are flushed, in the
  background worker under its own lock, so a finished turn is never delayed by it (ADR-0027).
- Output: ≤ 140-char summary per turn, sent as `turn_summary` patch events. Only the summary leaves
  the machine.
- Recursion guard: the child process gets `AI_OBS_SUMMARIZING=1`; all hook handlers exit immediately
  when it is set (works for subscription logins; `--bare` would require an API key). Codex also gets
  `-c features.hooks=false`.
- On failure, turns are sent without summaries and the summary is retried on the next run.

## 6. Ingest API

`POST /api/v1/ingest` — `Authorization: Bearer aiobs_u_…` (a person's or service user's token; `aiobs_c_…` is rejected); gzip JSON;
≤ 500 events or 1 MB per batch; per-token rate limit.

```jsonc
{
  "schema": 1,
  "collector": { "name": "ai-obs", "version": "1.0.0" },
  "machine":   { "id": "uuid", "os": "darwin" },
  "identity":  { "git_email": "dev@acme.com" },          // optional, ignored by the server (attribution is the token's user)
  "events": [
    { "event_id": "ulid", "type": "session_start", "harness": "claude-code", "harness_version": "2.x",
      "session_id": "…", "project": { "key": "github.com/acme/billing" /* or "sha256:…" */, "name": "billing", "team": "platform" /* dot-file team slug, optional */ },
      "at": "2026-10-05T10:00:00Z" },
    { "event_id": "ulid", "type": "turn", "session_id": "…", "turn_id": "…",
      "started_at": "…", "ended_at": "…", "model": "claude-opus-5-5", "effort": "high",
      "usage": [ { "model": "claude-opus-5-5", "effort": "high", "input": 0, "output": 0,
                   "cache_read": 0, "cache_write": 0, "reasoning": 0, "requests": 0 } ],
      "phases_ms": { "thinking": 0, "exploring": 0, "coding": 0, "documenting": 0,
                     "testing": 0, "validating": 0, "other": 0 },
      "tools": { "edit": 0, "bash": 0, "read": 0 }, "files_touched": 0, "lines_added": 0, "lines_removed": 0,
      "skills": { "code-review": { "model": 1, "user": 0 } },            // optional (ADR-0016)
      "mcp": { "github": { "search_code": 3 } },                         // optional (ADR-0016)
      "mcp_stats": { "github": { "search_code": { "errors": 1, "denied": 0, "ms": 1500, "buckets": [3, 0, 0, 0, 0] } } },
      "outcome": { "status": "success", "signals": ["tests_passed"], "provisional": true },
      "phase_rules_version": 1 },
    { "event_id": "ulid", "type": "run", "turn_id": "…", "run_id": "agent-id", "parent_run_id": null,
      "agent_type": "Explore", "depth": 1, "started_at": "…", "ended_at": "…",
      "agent_group": "Explore", "orchestration_id": "wf_…",              // optional (ADR-0019)
      "stage_index": 1, "flow_key": "data",                             // optional (ADR-0020)
      "links": [{ "from_run_id": "agent-id-0", "kind": "item" }],       // optional, ≤ 32 incoming (ADR-0020)
      "usage": [ … ], "phases_ms": { … }, "outcome": { … } },
    { "event_id": "ulid", "type": "turn_started", "session_id": "…", "turn_id": "… or null", "started_at": "…" },   // ADR-0027
    { "event_id": "ulid", "type": "turn_outcome", "turn_id": "…", "outcome": { "status": "failed", "signals": ["next_prompt_correction"] } },
    { "event_id": "ulid", "type": "turn_summary", "turn_id": "…", "summary": "Added JWT refresh to auth middleware" },
    { "event_id": "ulid", "type": "session_end", "session_id": "…", "reason": "exit", "at": "…" }
  ]
}
```

- Response: `{ accepted, duplicates, rejected: [{event_id, reason}], warnings? }`. Duplicate `event_id`s are ignored,
  so retries are always safe. `warnings` (at most one per session per batch) is `[{ code: "team_not_member" | "team_unknown", team, session_id }]`
  and tells the collector that the dot-file team of a session was not used; old collectors ignore it.
- The team of a session is resolved once, at `session_start` (§4); later events of the session reuse it.
- Unknown `harness` values are accepted; harness-specific extras go into an `ext` object.
- `GET /api/v1/collector-config` → `{ project_naming, min_collector_version, project_salt, deployment: { name, slug }, user: { email, name, kind },
  teams: [{ slug, name }], primary_team, token: { expires_at, label, source } }` (`user.email` is null for a service user).
- Device login (public, rate-limited per IP): `POST /api/v1/device/code` `{ client_name, client_version }` → `{ device_code, user_code, verification_uri, expires_in: 600, interval: 5 }`;
  `POST /api/v1/device/token` `{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code }` → `{ token, expires_at, label }`, or
  `400 { error: authorization_pending | slow_down | access_denied | expired_token | invalid_grant }`.

## 7. Data model (Postgres)

One deployment is one company, so no table carries a company column. User-owned and team-owned tables are protected by RLS.

| Table | Purpose / key columns |
|---|---|
| `deployment` | exactly one row: name, slug, `settings` (visibility mode, project naming, retention days, runaway thresholds), `project_salt` |
| `teams` | name (unique), immutable `slug` |
| `users` | email (null for service users), name, `kind` (person / service) |
| `memberships` | user_id (unique), `role` (admin/member), `primary_team_id` |
| `team_memberships` | team_id, user_id, role (member/lead); the user must have a membership |
| `invitations` | email, team_id, `role`, expires_at |
| `auth_accounts`, `auth_sessions`, `magic_links` | Dashboard login (OAuth accounts, sessions) |
| `ingest_tokens` | user_id, name, `source` (device/manual), `label` (client name), prefix, `hash`, created_by, `expires_at` (null = none), last_used_at, revoked_at |
| `device_codes` | hashed device code, 8-letter user code, client name / version, requester IP, `status`, approved_by, token_id, expires_at (10 min) |
| `machines` | user_id, machine_id, os, first/last seen |
| `projects` | `key` (normalized remote or hash), display_name, mapped team_id |
| `agent_sessions` | user_id, machine_id, project_id, harness, harness_version, started/ended, end_reason |
| `turns` | team_id (nullable), user_id, `attribution` (verified/matched/unverified), session_id, project_id, harness, primary model, effort, timings, token totals, `phases_ms`, tool counts, `skills`, `mcp`, `mcp_stats`, files/lines, outcome + signals, summary, phase_rules_version |
| `runs` | turn_id, parent_run_id, agent_type, `agent_group`, `orchestration_id`, `stage_index`, `flow_key`, depth, model, effort, timings, tokens, phases, `skills`, `mcp`, `mcp_stats`, outcome |
| `run_links` | turn, from run, to run (ids resolved late, external ids kept), kind (`item` / `sequence`); visible when the target run is (ADR-0020) |
| `runaway_alerts` | turn, team, user, project, reasons (tokens / cost / duration), tokens, ≈ cost, duration, notified_at (ADR-0018) |
| `usage` | per run × model × effort token counts (handles mixed-model turns) |
| `ingest_events` | event_id (unique, for de-duplication), received_at — pruned after 30 days |
| `model_prices` | model, effective_from, input / output / cache-read / cache-write price per MTok |
| `daily_rollups` | team, user (nullable after anonymization), project, harness, model, effort, day → counts, tokens, duration, phase ms, outcome counts |
| `daily_skill_mcp_rollups` | team, user (nullable after anonymization), project, harness, primary model, day, kind (skill / mcp), name, tool (`''` = skill or server total) → calls, model / user calls, turns, their outcome counts, MCP errors / denied / latency (ADR-0016, 0017) |
| `budgets` | team_id / user_id, period (month), kind (tokens / cost), limit, notified_80_at, notified_100_at |
| `audit_log` | actor, action, target, meta, at (logins, token changes, settings, exports) |

**Cost** = token counts × the `model_prices` row effective on the turn's date (for a date before the model's earliest row, that earliest row), computed at query time
and always labelled "≈ at API list prices".

## 8. Dashboard (all eight views in v1)

Global filter bar: date range · team · project · user (when allowed) · harness · model. Tailwind,
light / dark, responsive. Charts via Recharts, one clear chart per question.

| View | Content | Chart |
|---|---|---|
| **Overview** | KPI tiles: turns, tokens, ≈ cost, success rate, median turn duration, wasted ≈ cost (share, 7-day line); budget progress bars; runaway turns | Stacked area: tokens over time by model |
| **Projects** | Table: turns, tokens, ≈ cost, success rate, wasted ≈ cost and share, sparkline; drill into project page (with effort suggestions) | Sparklines in table |
| **Models & effort** | Cost, tokens, success rate, median duration, wasted ≈ cost per model × effort; effort suggestions (lower effort, similar success, ≥ 20 % cheaper) | Horizontal bars |
| **Phases** | Time split per team / project / model | 100 % stacked bars |
| **Agents** | Sub-agent groups (expand to their types): spawn count, token share, success rate; depth; agent timeline of one UTC day — one lane per session, coloured by project, sub-agents branch off their parent (ADR-0019); agent flow of the same window — lanes per workflow run / turn, rows = stages, arrows = links (ADR-0020) | Bars + git-graph timeline + flow; parent → child tree on turn detail |
| **Agent flows** | Whole multi-step sub-agent flows (≥ 2 steps): steps, stages, duration, tokens, ≈ cost, models, outcome; detail per flow with its steps (model, effort, offset, tokens, ≈ cost, skills, MCP calls), skills & MCP totals, time by stage and phases per step (ADR-0020 amendment) | Table + flow chart + 100 % stacked bars |
| **Skills & MCP** | Skills: uses, by the model vs typed by the user, turns, distinct users (leads / admins), success and cost Δ vs comparable turns (skill impact detail table); MCP servers that expand into their tools: calls, error rate, denied, median / p95 latency bucket, turns, distinct users. Turn detail lists a turn's skills and MCP calls | Stacked area: uses / calls per day |
| **Turns explorer** | Filterable table (user*, project, model, effort, outcome, date); turn detail with run timeline, flow and tree | Git-graph timeline and flow of the turn (ADR-0019, ADR-0020) |
| **Admin** | Settings, teams, members, roles, invitations, service users, tokens (every token, with revoke), projects (mapping overrides the dot file), budgets, model prices, audit log. Everyone has "My tokens" and the `/device` approval page | – |

\* user column only in full-detail mode or for the user's own data. Every table view has **CSV export**
(scoped by RLS, written to the audit log). Admin tables (members, teams, tokens, projects) are not telemetry and are not exported.

## 9. Budgets

Monthly token or ≈cost limit per team and optionally per user. Evaluated hourly from rollups + today's
turns. E-mail at 80 % and 100 % to admins and the team's leads (user budgets: also the user).
Never blocks the harness.

**Runaway alerts** ([ADR-0018](docs/adr/0018-runaway-alerts.md)): after a turn ends, the worker flags it when its tokens
(input + output + cache writes; cache reads excluded) exceed 3 × the user's own p99 (30 days; 20 M without enough history), its ≈ cost reaches the deployment's threshold
(default $20), or it ran for the deployment's hours (default 2) with above-normal tokens. One alert per turn; at most one
digest per hour to the user, the team's leads in full mode, or an anonymous digest to admins in
aggregates-only mode. Thresholds in Admin → Settings. Never blocks.

## 10. Plans

Not applicable: self-hosted, no plans, no limits on users or teams, no payments. Retention is the only limit (30 days – 24 months, default 13 months).

## 11. Hosting and operations

- **All backend services are provisioned with Docker**, defined in a Docker Compose file that is the
  reference deployment for local development and self-hosting, one deployment per company:
  - `web`: the app image (Next.js standalone), serving dashboard and API
  - `worker`: same image, different entry point. Runs rollups every few minutes, hourly budgets, nightly retention and e-mail.
  - `migrate`: same image, one-shot. Runs Drizzle migrations and creates the DB roles before `web` and `worker` start.
  - `postgres`: official Postgres 16+ image with a named volume
  - `mailpit`: dev profile only, catches e-mail locally
- Plain Postgres (no vendor data APIs — RLS requires direct connections). SMTP for e-mail.
- Configuration via environment variables / `.env`; secrets never baked into images.
- **Self-hosted only**: each company runs its own deployment (the same image everywhere), in the region it chooses. There is no hosted multi-tenant service.
- Configuration highlights: `ADMIN_EMAILS` (first admins), `ALLOWED_EMAIL_DOMAINS` (auto-join, empty by default), `MIN_COLLECTOR_VERSION` (raise it to `0.5.0` only after every collector is on 0.5.0: server first, then collectors, then this value).
- Retention: nightly job deletes expired raw rows; deleting a user identity (an operator action) removes raw rows and nulls `user_id`
  in rollups. Removing a member keeps their recorded activity (shown as "former member") and revokes their tokens (ADR-0028).

## 12. Definition of done

**This design phase** is done when the owner confirms this brief (status → Accepted).

**The future MVP build** is done when:

1. `npx ai-obs-cli init` on a machine with Claude Code and Codex configures both; `ai-obs doctor` is green.
2. A real Claude Code session with a sub-agent and a Codex session appear in the dashboard within
   minutes, with correct tokens (matching transcript totals), model, effort, phases, outcome, summary,
   and the parent → child run tree.
3. Killing the network during a session loses no data and creates no duplicates after reconnect.
4. RLS tests prove: members see only their own rows; leads only their teams;
   aggregates-only mode exposes no per-user data to leads/admins; a token holder cannot write another user's rows or feed a team they do not belong to.
5. All dashboard views (§8) render with real data in light and dark mode and on a phone-width screen.
6. A budget crossing 80 % sends an e-mail exactly once.
7. Retention job removes expired raw data while long-range charts keep working from rollups.

### Status (2026-10-24)

The single-deployment rework (ADR-0028..0030) is built, reviewed (71 findings, the confirmed ones fixed), green (whole-repo
typecheck, 1627 tests) and committed: schema and migration 0018 (one `deployment` row, `memberships`, token expiry,
`teams.slug`, `device_codes`, RLS around users and teams, `app_platform` stripped of every privilege), the dev merge script
`db:merge-companies`, the web app and worker without companies, plans or super admin, and collector 0.5.0 (0.4.0 was never
published). The dev database was merged into the SPECTADO deployment (four companies, six teams, all 1820 turns kept; dump
before the merge in `~/ai-obs-backups/`) and migrated; the dev containers run the new image. Still with the owner: publish
collector 0.5.0 to npm, upgrade the collectors (`init`, then `ai-obs link --team <slug>` per repository), check `ai-obs login`
in the browser and a new turn landing under the linked team, then raise `MIN_COLLECTOR_VERSION` to 0.5.0. Item 4 below now
reads "own rows, led teams, admin, aggregates-only"; the cross-company and super-admin proofs went with the concepts.

### Status (2026-10-06)

State of the MVP build against the seven items above. Honest, not aspirational: "done" means demonstrated by an
automated test or a run in this session; "not verified" means nobody has seen it with real traffic.

1. **`init` / `doctor` — done, one manual step.** `init` in a scratch `HOME` installed the hooks for Claude Code and Codex and
   `doctor` was green; Codex only records after the user trusts the hooks once (`/hooks` in Codex), which `doctor` flags.
2. **Real sessions in the dashboard — not verified.** Parsing, token de-duplication, phases, outcomes and the run tree are tested
   against recorded transcripts and fixtures, and the protocol fixture ingests end to end (accepted, then duplicates). No live Claude
   Code session with a sub-agent and no live Codex session has been run against the built app; Codex sub-agent linkage is still
   open item 1 and the Codex multi-agent V2 output shape is unverified.
3. **No loss and no duplicates across a network outage — done at test level.** Local queue, retry and server-side idempotency are
   covered by collector and ingest tests; a live "pull the cable" drill has not been done.
4. **RLS proofs — done.** Member / lead / admin visibility and aggregates-only are tested (the 2026-10-06 cross-company and super-admin proofs were retired in 2026-10-24)
   against real Postgres (packages/db and apps/web integration suites).
5. **Seven views, light / dark / phone — partial.** All seven routes return 200 for admin, lead and member on the built server and
   unknown ids return 404. The visual review's findings V1, V2, V5, V6 are fixed, but the layouts were not re-screenshotted after
   the fixes in this pass (`scripts/screenshot.ts` exists for it).
6. **Budget 80 % mail sent exactly once — done at test level.** Threshold, once-only marks and recipients (including aggregates-only
   mode) are tested with a mail stub; a real SMTP / Mailpit delivery was not exercised in this pass.
7. **Retention with rollups — done, with one known limit.** The retention job, the rollup fold and the retention-aware read path are
   tested against real Postgres. A day whose raw turns were partly deleted only gets late turns added, so a later change to an
   already-counted turn (outcome patch, late run) on such a day is not picked up (ADR-0012).

## 13. Open items

1. **Codex sub-agent linkage** — no explicit parent field found in rollouts; verify with a session that
   spawns a sub-agent (likely in `source` / `thread_source`).
2. **Exact hook payload fields** (Claude Code and Codex) — confirm against live payloads before building
   adapters; confirm whether Codex fires a session-end event.
3. **Aggregates-only mode applies to admins too?** Proposed: yes (one rule, easier to explain to HR).
4. **Summaries in aggregates-only mode** — proposed: shown without attribution. Summaries can still
   reveal who did what in small teams; consider hiding them below N team members.
5. **Summary calls use the developer's own plan / rate limit** — acceptable? (cost is tiny but non-zero).
6. ~~No-dot-file nudge.~~ Resolved 2026-10-24: with one registered server and no dot file the collector sends without a team and says nothing (ADR-0030 R3).
7. **Product name** and domain.
8. **Auth library** (Auth.js vs Better Auth) — choose at build time; not architecturally significant.
9. Correction-detection heuristics beyond EN + CZ.
