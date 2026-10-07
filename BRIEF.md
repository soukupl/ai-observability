# AI Observability SaaS — Design Brief

- **Status:** Accepted — owner instructed "start coding the project" on 2026-10-05; §13 open items resolved with the proposed defaults unless noted in docs/adr
- **Date:** 2026-10-05
- **Owner / decider:** Ladislav Soukup
- **Working name:** `ai-obs` (placeholder — see Open items)

Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [ADRs](docs/adr/README.md)

## 1. Goal

A multi-tenant SaaS that shows companies, teams and individual developers **how AI coding agents are
used**: which projects, models and effort levels, how many tokens and how much (estimated) money,
where the time goes (thinking / coding / testing / documenting / validating), how sub-agents are
used, and how often work succeeds.

Data is collected by a tiny, zero-dependency **collector** installed into the developer's AI harness
(Claude Code and OpenAI Codex first). It reads exact numbers from harness hooks and local transcripts
— no LLM self-reporting — and pushes batched, idempotent events with a token.

The design is now being implemented; see README.md for the build.

## 2. Decisions at a glance

| # | Topic | Decision | ADR |
|---|---|---|---|
| 1 | Capture | Hybrid: hooks + local transcript parsing for all numbers; a cheap LLM only for summaries | [0001](docs/adr/0001-capture-via-hooks-and-transcripts.md) |
| 2 | Harnesses | Harness-neutral ingest format; Claude Code + Codex collectors first, others as adapters | [0005](docs/adr/0005-harness-neutral-ingest-format.md) |
| 3 | Unit of work | **Turn** (user prompt → agent stops). Sessions group turns; sub-agent **runs** nest in turns | [0002](docs/adr/0002-turn-as-primary-unit.md) |
| 4 | Outcome | Derived from **signals only** (no LLM judge, no user rating) | [0003](docs/adr/0003-outcome-from-signals-only.md) |
| 5 | Summaries | **Always on**, generated **locally** by the harness's cheapest model, batched at session end | [0004](docs/adr/0004-local-summaries-by-cheap-model.md) |
| 6 | Project identity | Normalized git remote; company can switch to **hashed** mode | [0008](docs/adr/0008-privacy-modes.md) |
| 7 | Ingest tokens | **Per-user** tokens by default + **team** tokens for rollout/CI (git-email matching, else "unverified") | [0007](docs/adr/0007-ingest-tokens.md) |
| 8 | Teams | User in one company, may be in many teams; each turn is attributed to exactly one team | [0007](docs/adr/0007-ingest-tokens.md) |
| 9 | Individual visibility | Per-company mode: **aggregates-only (default)** or full detail; mode visible to all users | [0008](docs/adr/0008-privacy-modes.md) |
| 10 | Dashboard login | Magic link + Google/GitHub OAuth; SSO (SAML/OIDC) on roadmap, schema-ready | [0013](docs/adr/0013-dashboard-authentication.md) |
| 11 | Stack | TypeScript; Next.js (App Router), Postgres, Drizzle, Tailwind, Recharts; Node collector | [0009](docs/adr/0009-tech-stack.md) |
| 12 | Isolation | `company_id` on every row + Postgres **RLS**; super admin has no DB access to telemetry | [0006](docs/adr/0006-tenant-isolation-with-rls.md) |
| 13 | Cost | Estimated cost at **API list prices** from a dated price table, computed at query time | brief only |
| 14 | Retention | Per-company, 30 days – 24 months raw, **default 13 months**; daily rollups kept forever | [0012](docs/adr/0012-retention-and-rollups.md) |
| 15 | Delivery | Local file queue + retry; client-generated event IDs; server de-duplicates | [0011](docs/adr/0011-local-queue-idempotent-delivery.md) |
| 16 | Install | One CLI: `npx ai-obs init --token …` configures every detected harness | brief only |
| 17 | Dashboard | All eight views in v1 (see §8) | brief only |
| 18 | Alerts | Monthly token/cost budgets per team/user, e-mail at 80 % / 100 %, never blocking | brief only |
| 19 | Billing | Plans + limits (Free / Team / Business) set by super admin; no payments | brief only |
| 20 | Hosting | All backend services **provisioned with Docker** (Compose: web, worker, migrate, postgres); official SaaS in the **EU**; self-hostable | [0010](docs/adr/0010-portable-eu-hosting.md) |
| 21 | Data access | CSV export of every telemetry table view (RLS-scoped, audit-logged; admin tables are administration data, not telemetry, and have no CSV; the audit log has its own export); no public read API | brief only |
| 22 | Skills & MCP | Skill uses (model-invoked vs typed `/skill`) and MCP calls per server × tool, by name, plus MCP errors, denials and latency; names follow the project-naming mode (hashed on the machine) | [0016](docs/adr/0016-skill-and-mcp-usage.md) |
| 23 | Insights | Wasted spend (≈ cost of failed / abandoned turns), skill impact (vs comparable turns), effort suggestions; rollups keep tokens and skill outcomes split by outcome | [0017](docs/adr/0017-outcome-insights.md) |
| 24 | Runaway alerts | Turns far above the user's normal, over a ≈ cost or duration threshold, flagged by the worker after the turn ends; hourly digest to the user (+ leads in full mode, anonymous to admins otherwise); never blocks | [0018](docs/adr/0018-runaway-alerts.md) |

## 3. Scope

### In scope (v1)

- Collector CLI (`ai-obs`) with Claude Code and Codex adapters, local queue, local summaries.
- Ingest API (`POST /api/v1/ingest`) and collector config API.
- Multi-tenant model: company → team → user, roles, invitations, tokens.
- Dashboard: Overview, Projects, Models & effort, Phases, Agents, Turns explorer, Admin (+ super-admin console).
- Budgets with e-mail notifications.
- Plans and limits (no payment).
- Retention jobs, daily rollups, CSV export, audit log.
- Light / dark mode, responsive Tailwind UI.

### Out of scope (v1)

- Payments / Stripe, invoices.
- SSO (SAML/OIDC), SCIM provisioning — schema-ready only.
- Public read API, BI connectors.
- Custom alert rules, Slack / webhook delivery.
- LLM judging of outcomes; user ratings (`/obs good|bad`).
- Blocking or rate-limiting the harness (budgets only notify).
- Storing prompts, responses, code, diffs or file paths.
- Real-time streaming (minutes of latency is acceptable).
- Collectors for harnesses other than Claude Code and Codex (format is ready for them).
- Per-person ranking views.

## 4. Tenancy, roles and permissions

```
Platform (super admin)
└── Company (plan, settings)
    ├── Team ── memberships (member | lead)
    └── User (company role: admin | member; primary team)
```

- A **user belongs to exactly one company** and to one or more teams (role per team: `member` or `lead`;
  a team may have several leads).
- A **solo developer** = a company with one team and one user, created automatically at sign-up on the Free plan.
- **Super admin** is a platform flag, not a company member.

| Capability | Super admin | Company admin | Team lead | Member |
|---|---|---|---|---|
| Create / suspend companies, set plan | ✅ | – | – | – |
| See any telemetry | ❌ (enforced by DB) | ✅ company-wide* | ✅ own teams* | ✅ own only |
| Manage teams, members, roles, invitations | – | ✅ | – | – |
| Map projects → teams, name projects | – | ✅ | – | – |
| Company settings (privacy mode, project naming, retention) | – | ✅ | – | – |
| Create team tokens | – | ✅ | ✅ own teams | – |
| Create own user tokens | – | ✅ | ✅ | ✅ |
| Budgets | – | ✅ all | ✅ own teams (view) | own (view) |
| CSV export | – | ✅ | ✅ | ✅ (own data) |

\* Subject to the company's **individual-visibility mode**:

- **Aggregates-only (default):** leads and admins see totals and breakdowns by team / project / model /
  phase / agent, but **no per-user rows, no per-user turn lists, no names on turns**. Turn summaries are
  shown without attribution. Each user always sees their own full detail.
- **Full detail:** leads see every turn of their teams by person; admins company-wide.
- The active mode is displayed to every user (banner in settings + footer).

**Team attribution of a turn** (first match wins): (1) company's project → team mapping, (2) the
token's team, (3) the user's primary team.

## 5. Data capture (collector)

### 5.1 Install and runtime

- `npx ai-obs init --token <token> [--project]` — detects installed harnesses, writes hook config
  (user-level by default, repo-level with `--project`; the token is never written into a repo).
- Files: `~/.ai-obs/config.json` (endpoint, token, random `machine_id`), `~/.ai-obs/state/`
  (per-session transcript cursors), `~/.ai-obs/queue/*.ndjson` (capped ~50 MB / 30 days).
- Commands: `init`, `doctor`, `status`, `flush`, `uninstall`.
- Admin UI offers a downloadable config (with team token) for MDM / dotfiles rollout.
- Node ≥ 20, **zero runtime dependencies**. Hook handlers return in < 100 ms and spawn a detached
  worker for parsing, summarizing and sending.
- On start, the collector fetches `GET /api/v1/collector-config` (cached) to learn the company's
  **project-naming mode** (and the company's `project_salt`, which keys the hash), so hashing happens on the machine.

### 5.2 Hooks used

| Harness | Hooks | Source of numbers |
|---|---|---|
| Claude Code | `SessionStart`, `Stop`, `StopFailure`, `SubagentStop`, `SessionEnd` | Session transcript JSONL + sub-agent transcripts (`subagents/agent-<id>.jsonl` + `.meta.json` with parent `toolUseId`) |
| Codex | `session_start`, `stop`, `subagent_stop` (+ `SessionEnd` if available) | Rollout JSONL in `~/.codex/sessions/…` (`turn_context`, `token_count`, `task_complete`) |

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

- At `SessionEnd` (or when the queue flushes), the collector builds a condensed local digest per turn
  (truncated prompt, tool names, last assistant message) and makes **one batched headless call** to
  the harness's cheapest model: `claude -p --model haiku …` / `codex exec -m <mini model> …`.
- Output: ≤ 140-char summary per turn, sent as `turn_summary` patch events. Only the summary leaves
  the machine.
- Recursion guard: the child process gets `AI_OBS_SUMMARIZING=1`; all hook handlers exit immediately
  when it is set (works for subscription logins; `--bare` would require an API key). Codex also gets
  `-c features.hooks=false`.
- On failure, turns are sent without summaries and the summary is retried on the next run.

## 6. Ingest API

`POST /api/v1/ingest` — `Authorization: Bearer aiobs_u_…` (user) or `aiobs_t_…` (team); gzip JSON;
≤ 500 events or 1 MB per batch; per-token rate limit.

```jsonc
{
  "schema": 1,
  "collector": { "name": "ai-obs", "version": "1.0.0" },
  "machine":   { "id": "uuid", "os": "darwin" },
  "identity":  { "git_email": "dev@acme.com" },          // used only for team-token matching
  "events": [
    { "event_id": "ulid", "type": "session_start", "harness": "claude-code", "harness_version": "2.x",
      "session_id": "…", "project": { "key": "github.com/acme/billing" /* or "sha256:…" */, "name": "billing" },
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
      "usage": [ … ], "phases_ms": { … }, "outcome": { … } },
    { "event_id": "ulid", "type": "turn_outcome", "turn_id": "…", "outcome": { "status": "failed", "signals": ["next_prompt_correction"] } },
    { "event_id": "ulid", "type": "turn_summary", "turn_id": "…", "summary": "Added JWT refresh to auth middleware" },
    { "event_id": "ulid", "type": "session_end", "session_id": "…", "reason": "exit", "at": "…" }
  ]
}
```

- Response: `{ accepted, duplicates, rejected: [{event_id, reason}] }`. Duplicate `event_id`s are ignored,
  so retries are always safe.
- Unknown `harness` values are accepted; harness-specific extras go into an `ext` object.
- `GET /api/v1/collector-config` → `{ project_naming: "plain" | "hashed", min_collector_version, project_salt }`.

## 7. Data model (Postgres)

All tenant tables carry `company_id` and are protected by RLS.

| Table | Purpose / key columns |
|---|---|
| `companies` | name, slug, `plan`, `settings` (visibility mode, project naming, retention days), status |
| `teams` | company_id, name |
| `users` | company_id (null for super admin), email, name, `company_role` (admin/member), `primary_team_id`, `is_super_admin` |
| `team_memberships` | team_id, user_id, role (member/lead) |
| `invitations` | company_id, email, team_id, role, expires_at |
| `auth_accounts`, `auth_sessions`, `magic_links` | Dashboard login (OAuth accounts, sessions); `identity_providers` reserved for SSO |
| `ingest_tokens` | company_id, team_id, user_id (null = team token), kind, name, prefix, `hash`, last_used_at, revoked_at |
| `machines` | company_id, user_id, machine_id, os, first/last seen |
| `projects` | company_id, `key` (normalized remote or hash), display_name, mapped team_id |
| `agent_sessions` | company_id, user_id, machine_id, project_id, harness, harness_version, started/ended, end_reason |
| `turns` | company_id, team_id, user_id, `attribution` (verified/matched/unverified), session_id, project_id, harness, primary model, effort, timings, token totals, `phases_ms`, tool counts, `skills`, `mcp`, `mcp_stats`, files/lines, outcome + signals, summary, phase_rules_version |
| `runs` | turn_id, parent_run_id, agent_type, depth, model, effort, timings, tokens, phases, `skills`, `mcp`, `mcp_stats`, outcome |
| `runaway_alerts` | company, turn, team, user, project, reasons (tokens / cost / duration), tokens, ≈ cost, duration, notified_at (ADR-0018) |
| `usage` | per run × model × effort token counts (handles mixed-model turns) |
| `ingest_events` | event_id (unique, for de-duplication), received_at — pruned after 30 days |
| `model_prices` | model, effective_from, input / output / cache-read / cache-write price per MTok |
| `daily_rollups` | company, team, user (nullable after anonymization), project, harness, model, effort, day → counts, tokens, duration, phase ms, outcome counts |
| `daily_skill_mcp_rollups` | company, team, user (nullable after anonymization), project, harness, primary model, day, kind (skill / mcp), name, tool (`''` = skill or server total) → calls, model / user calls, turns, their outcome counts, MCP errors / denied / latency (ADR-0016, 0017) |
| `budgets` | company_id, team_id / user_id, period (month), kind (tokens / cost), limit, notified_80_at, notified_100_at |
| `audit_log` | company_id, actor, action, target, meta, at (logins, token changes, settings, exports) |

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
| **Agents** | Sub-agent types: spawn count, token share, success rate; depth | Bars + parent → child tree on turn detail |
| **Skills & MCP** | Skills: uses, by the model vs typed by the user, turns, distinct users (leads / admins), success and cost Δ vs comparable turns (skill impact detail table); MCP servers that expand into their tools: calls, error rate, denied, median / p95 latency bucket, turns, distinct users. Turn detail lists a turn's skills and MCP calls | Stacked area: uses / calls per day |
| **Turns explorer** | Filterable table (user*, project, model, effort, outcome, date); turn detail with run timeline and tree | Timeline (Gantt-style) |
| **Admin** | Company: teams, members, roles, invitations, tokens, project mapping, settings, budgets, audit log. Super admin console: companies, plans, status, admin contacts only | – |

\* user column only in full-detail mode or for the user's own data. Every table view has **CSV export**
(scoped by RLS, written to the audit log). Admin tables (members, teams, tokens, projects) are not telemetry and are not exported.

## 9. Budgets

Monthly token or ≈cost limit per team and optionally per user. Evaluated hourly from rollups + today's
turns. E-mail at 80 % and 100 % to company admins and the team's leads (user budgets: also the user).
Never blocks the harness.

**Runaway alerts** ([ADR-0018](docs/adr/0018-runaway-alerts.md)): after a turn ends, the worker flags it when its tokens
exceed 3 × the user's own p99 (30 days; 20 M without enough history), its ≈ cost reaches the company threshold
(default $20), or it ran for the company's hours (default 2) with above-normal tokens. One alert per turn; at most one
digest per company per hour to the user, the team's leads in full mode, or an anonymous digest to admins in
aggregates-only mode. Thresholds in Admin → Settings. Never blocks.

## 10. Plans (no payments)

Set by the super admin; new sign-ups land on **Free**. Values are placeholders. Limits apply to growth: a downgrade keeps existing users, teams and invitations (the console warns), refuses new ones, and caps retention.

| | Free | Team | Business |
|---|---|---|---|
| Users | 3 | 50 | unlimited |
| Teams | 1 | 10 | unlimited |
| Max raw retention | 30 days | 13 months | 24 months |
| Budgets | – | ✅ | ✅ |
| SSO (when built) | – | – | ✅ |

## 11. Hosting and operations

- **All backend services are provisioned with Docker**, defined in a Docker Compose file that is the
  reference deployment for local development, the SaaS and self-hosting:
  - `web`: the app image (Next.js standalone), serving dashboard and API
  - `worker`: same image, different entry point. Runs rollups every few minutes, hourly budgets, nightly retention and e-mail.
  - `migrate`: same image, one-shot. Runs Drizzle migrations and creates the DB roles before `web` and `worker` start.
  - `postgres`: official Postgres 16+ image with a named volume
  - `mailpit`: dev profile only, catches e-mail locally
- Plain Postgres (no vendor data APIs — RLS requires direct connections). SMTP for e-mail.
- Configuration via environment variables / `.env`; secrets never baked into images.
- Official SaaS in an **EU region**. The same image is self-hostable by companies.
- Retention: nightly job deletes expired raw rows; deleting a user removes raw rows and nulls `user_id`
  in rollups.

## 12. Definition of done

**This design phase** is done when the owner confirms this brief (status → Accepted).

**The future MVP build** is done when:

1. `npx ai-obs init` on a machine with Claude Code and Codex configures both; `ai-obs doctor` is green.
2. A real Claude Code session with a sub-agent and a Codex session appear in the dashboard within
   minutes, with correct tokens (matching transcript totals), model, effort, phases, outcome, summary,
   and the parent → child run tree.
3. Killing the network during a session loses no data and creates no duplicates after reconnect.
4. RLS tests prove: no cross-company reads; members see only their own rows; leads only their teams;
   aggregates-only mode exposes no per-user data to leads/admins; the super-admin role cannot read telemetry.
5. All dashboard views (§8) render with real data in light and dark mode and on a phone-width screen.
6. A budget crossing 80 % sends an e-mail exactly once.
7. Retention job removes expired raw data while long-range charts keep working from rollups.

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
4. **RLS proofs — done.** Cross-company, member / lead / admin visibility, aggregates-only and the super-admin role are tested
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
3. **Aggregates-only mode applies to company admins too?** Proposed: yes (one rule, easier to explain to HR).
4. **Summaries in aggregates-only mode** — proposed: shown without attribution. Summaries can still
   reveal who did what in small teams; consider hiding them below N team members.
5. **Summary calls use the developer's own plan / rate limit** — acceptable? (cost is tiny but non-zero).
6. **Plan limits** in §10 are placeholders.
7. **Product name** and domain.
8. **Auth library** (Auth.js vs Better Auth) — choose at build time; not architecturally significant.
9. Correction-detection heuristics beyond EN + CZ.
