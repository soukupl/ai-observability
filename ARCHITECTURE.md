# Architecture

Architecture of the AI observability SaaS. Requirements and scope: [BRIEF.md](BRIEF.md).
Reasons behind each choice: [docs/adr/](docs/adr/README.md).

## Components

```mermaid
flowchart LR
  subgraph Dev["Developer machine"]
    H1[Claude Code] -- hooks --> C
    H2[Codex] -- hooks --> C
    T1[(transcripts / rollouts)] -. read .-> C
    C[ai-obs collector<br/>zero-dep Node] --> Q[(~/.ai-obs/queue)]
    C -- batched digest --> S[headless cheap model<br/>haiku / mini]
    S -- summaries --> Q
  end
  Q -- "HTTPS batch, Bearer token of the company the session was recorded for" --> I
  subgraph SaaS["SaaS (one Docker image, EU)"]
    I[Ingest API<br/>/api/v1/ingest] --> DB[(Postgres + RLS)]
    W[Worker<br/>rollups · budgets · retention · e-mail] <--> DB
    UI[Next.js dashboard<br/>Tailwind + Recharts] <--> DB
  end
  W -- SMTP --> M[E-mail]
  U[Users / leads / admins] --> UI
  SA[Super admin] --> UI
```

| Component | Path | Responsibility | Notes |
|---|---|---|---|
| **Collector** (`ai-obs`) | `packages/collector` (npm `ai-obs`) | Hook handlers per harness; parse transcripts incrementally; classify phases and outcomes; build events; local queue; send; local summaries | Hook handlers write a job and spawn a detached worker (in-process budget under 100 ms from hook entry). The worker binds each session once to a queue stream (project key + the token in force at that moment, or open when there is no choice); the sender routes each stream to its token, hashes names with that company's settings and skips held streams. SessionStart can print the token question from local files. Token registry, per-repo assignment (`ai-obs use`). Zero runtime deps. Adapter per harness. |
| **Harness adapter** | `packages/collector` (one module per harness) | Maps a harness's hooks + transcript format into the neutral event format; returns the SessionStart context (the token question: JSON for Claude Code, plain text for Codex) | `claude-code`, `codex` in v1. New harness = new adapter only. |
| **Ingest API** | `apps/web/src/app/api/v1/ingest`, `…/collector-config`, logic in `apps/web/src/lib/ingest`; format in `packages/protocol` | Authenticate token (negative cache + failed-auth IP budget before any DB call), validate (wire schema, then server-side value limits, retention-window and normalisation), de-duplicate by `event_id` (keys namespaced by sender), resolve user / team / project / machine (company token: git e-mail of a company member), upsert sessions, turns, runs under an ownership rule, apply patch events | Runs under a dedicated insert-only DB role. A patch (`turn_outcome` / `turn_summary`) that arrives before its turn is parked in `pending_turn_patches` (with its sender) and applied when the turn arrives, only onto an ownerless or same-owner turn; a patch never creates a turn. A `session_title` patch before its session is parked the same way in `pending_session_patches` (ADR-0026). An existing turn / run / session can be overwritten only by its owner. |
| **Dashboard (web)** | `apps/web` (`@ai-obs/web`): header company switcher, views `src/app/(dashboard)/{overview,projects,models,phases,agents,flows,skills-mcp,sessions,turns,tokens}`, print-ready flow report `src/app/report/flows`, queries `src/lib/queries`, components `src/components`, CSV `src/app/api/export`, auth `src/lib/auth` | Server-rendered pages + route handlers for charts and CSV export; the Agents page groups agent types and draws the git-graph timeline (`components/charts/AgentGraph.tsx`, also on the turn page) whose runs link to their flow's section on its turn page; the Overview lists runaway turns, long / complex flows and the ingest statistics; stacked-area charts zoom client-side (drag) | Every request runs in a transaction that sets the RLS context (`withDashboardContext`). Short ranges read raw turns, long ranges (and ranges starting before the retention cutoff) `daily_rollups`; medians on long ranges come from raw turns while they still exist. Sends anti-framing headers (`frame-ancestors 'none'`). |
| **Admin console** | `apps/web/src/app/admin`, `src/lib/admin` | Teams, members, invitations, tokens, projects, settings, budgets, audit log | Company admins (leads: company tokens and budgets only); everything acts on the active company. Every write runs in `withUserDb` and appends an `audit_log` row, and every form is bound to the company it was rendered for. Removing a member from the company deletes their team memberships and revokes their user tokens and the company tokens they created, but keeps their recorded activity ("former member"); a plan downgrade grandfathers existing usage and only refuses growth; plan limits count memberships. |
| **Super-admin console** | `apps/web/src/app/super`, `src/lib/platform` | Companies, plans, suspension, admin invitations | Uses the `app_platform` role only; no access to telemetry, and its audit access is limited to `platform.*` rows (`platform_invitee_status()` answers invitee checks). Super-admin rights need the DB flag **and** the e-mail in `SUPER_ADMIN_EMAILS`, checked on every request. Non-super-admins get 404. |
| **Worker** | `apps/worker` (`@ai-obs/worker`, jobs in `src/jobs`) | Rollups (every few minutes; `daily_rollups` and `daily_skill_mcp_rollups` in one slice transaction, split by outcome), runaway detection + hourly digests (every 5 min, ADR-0018), budget checks (hourly), retention + anonymization (nightly), e-mail | Same image, different entry point. |
| **Postgres** | `docker-compose.yml` service `postgres`; schema in `packages/db` | Single source of truth; RLS for tenant and role isolation | Plain Postgres 16+, no vendor data APIs. |
| **Migrate** | `packages/db` (`src/migrate.ts`, `migrations/`) | One-shot: Drizzle migrations incl. DB roles / RLS policies (`0001_roles_rls.sql`), the pending-patch table + indexes (`0002_pending_patches.sql`), price fallback and stable turn-list order (`0003_price_fallback_turn_list_order.sql`), and the review hardening: invitation consent, token membership, team-bound attribution, project salt, platform scope (`0004_auth_invites_salt_hardening.sql`), skill / MCP usage columns, rollup table and aggregate functions (`0005_skills_mcp.sql`), effort advisor (`0006`), outcome-split rollups + wasted-spend functions (`0007`), skill impact (`0008`), MCP reliability (`0009`), runaway alerts (`0010`), agent groups + timeline functions (`0011`), run stages / flow keys, `run_links` + link functions (`0012`), flow list functions `agg_flow_runs` / `agg_flow_links` and skills / MCP on `agg_turn_runs` (`0013`), company memberships, user / company token kinds and the clean-break revocation of every earlier token (`0014`), personal flow flags + `agg_ingest_stats()` (`0015`) | Runs before `web` and `worker` start. |

Shared code: `packages/protocol` (`@ai-obs/protocol`) holds the ingest schema v1 (types, zod schemas,
constants, fixtures) used by the ingest API and, type-only, by the collector; `packages/db` (`@ai-obs/db`)
holds the Drizzle schema, migrations, roles + RLS SQL and the `withRlsContext()` helper.

All backend services run as Docker containers defined in one Compose file (`web`, `worker`, `migrate`,
`postgres`, plus `mailpit` in the dev profile). The collector is not containerized; it runs on the
developer's machine inside the harness.

## Data flow

1. Harness fires a hook (`Stop`, `SubagentStop`, `SessionEnd`, …) → collector handler records the
   event and spawns the worker. On `SessionStart` it may also print the token question (from local files only)
   when the project has no token chosen.
2. Worker reads the transcript from the stored cursor, builds `turn` / `run` events (tokens de-duplicated
   per API response, phases, provisional outcome), appends them to the queue.
3. Next turn or session end → `turn_outcome` patches (correction signals); a batched headless call produces
   `turn_summary` patches once ten turns wait, the oldest has waited ten minutes, or the session ends (ADR-0023). Each session is bound once to a queue stream (project + token, or open).
4. Queue is flushed per stream in batches (≤ 500 events / 1 MB) with the stream's token; held streams (unassigned,
   rejected, unconfirmed) are skipped and names are hashed per token. Failures stay queued and are retried on the next
   flush; the server ignores already-seen `event_id`s.
5. Ingest stores events (a patch that is ahead of its turn waits in `pending_turn_patches`) and resolves the **team** (project mapping → primary team of the resolved user in that company → none) and **attribution**
   (user token = verified; company token + git e-mail of a member of the token's company = matched; otherwise unverified).
6. Worker folds new turns into `daily_rollups` (keeping a deleted user's rows and never rebuilding a day whose raw turns are partly gone); long-range charts read rollups, short-range and
   detail views read `turns` / `runs`.

## Isolation and access

- Every tenant row has `company_id`; RLS is enabled **and forced** on every tenant table. The web app sets
  `app.company_id`, `app.user_id` and `app.role` (company role) with `SET LOCAL` inside each transaction
  (`withRlsContext()`); RLS policies filter on them. The active company lives on the login session
  (`auth_sessions.active_company_id`, validated per request, changed with the header switcher). The DB re-checks the
  claims: a user with no membership in `app.company_id` sees nothing, and `app.role = 'admin'` only counts if
  `company_memberships.company_role` of (`app.user_id`, `app.company_id`) agrees.
  Team-lead rights are derived from `team_memberships`, never passed in.
- Policies: member → own rows; lead → rows of teams they lead (full-detail mode) or aggregates
  without `user_id` (aggregates-only mode); company admin → company rows under the same mode rule.
- Aggregate access goes through `SECURITY DEFINER` functions (`agg_*`, owned by the NOLOGIN role
  `app_definer`) that never return `user_id` or names.
- DB roles: `app_web` (RLS-bound), `app_ingest` (insert / patch telemetry of the token's company,
  identity-column reads only, token lookup function), `app_worker` (cross-company: rollups, budgets,
  retention), `app_platform` (super admin: companies, plans, admin contacts, audit log — **no grants** on
  telemetry tables). Services connect via `dbFor()` (ADR-0014); details in `packages/db/README.md`.

## Domain model

| Term | Meaning |
|---|---|
| **Company** | Tenant. Has a plan, settings (individual-visibility mode, project-naming mode, retention), teams and members. |
| **Team** | Group of members within a company. A turn is attributed to at most one team. |
| **User** | One identity (one login, e-mail, name). It belongs to one or more companies through memberships and is never tied to a single company. |
| **Company membership** | A user's place in one company: company role `admin` or `member`, primary team, last active time. Team memberships and per-user budgets hang off it. Removing it revokes the person's tokens there and keeps their recorded activity. |
| **Super admin** | Platform operator (flag plus `SUPER_ADMIN_EMAILS`); manages companies and plans, cannot read telemetry. |
| **Ingest token** | Secret used by the collector. *User token* (`aiobs_u_`) identifies one user in one company; *company token* (`aiobs_c_`, made by admins and leads) writes into a company and matches users by git e-mail against its members. A machine may hold several; the repo-to-token choice is local (`~/.ai-obs/projects.json`). Revoking is one-way. |
| **Machine** | A developer computer, identified by a random ID generated at install. |
| **Harness** | The AI coding tool (Claude Code, Codex, …). |
| **Project** | A codebase, keyed by normalized git remote (or its hash). Optionally mapped to a team. |
| **Project assignment** | The local choice of which registered token a project reports with (`~/.ai-obs/projects.json`, written by `ai-obs use`). Same key as the project, never sent. `none` means the repository reports to no company. |
| **Binding** | The token identity a queued session belongs to, fixed by the routing in force at the session's first hook (or open, when the project had no usable choice; an open session joins the project's choice from its next event on). Queued data is sent only to its binding. |
| **Session** | One harness session from start to exit (`agent_sessions`, the id `claude --resume` takes); groups turns and, through them, their runs, workflows and flows. Its span ends at its last run, since workflow agents outlive their turn. Listed at `/sessions`, detail `/sessions/<id>`; titled by the harness title (`session_title`, custom over AI) else the first turn summary (ADR-0026). |
| **Turn** | Primary unit of work: one user prompt and everything the agent does until it stops. |
| **Run** | One agent execution inside a turn: the main agent or a sub-agent, linked by `parent_run_id`. |
| **Agent group** | The logical kind of a sub-agent run (`Explore`, `workflow:review`): the collector's `agent_group`, else derived from `agent_type` by the one rule in `apps/web/src/lib/queries/agent-groups.ts` (ADR-0019). |
| **Orchestration** | The batch / workflow run that launched a sub-agent (`orchestration_id`, e.g. a `wf_…` id) (ADR-0019). |
| **Agent timeline** | Git graph over time on the Agents page: one lane per session, coloured by project; turns are the trunk, runs branch off their parent and merge back. One UTC day window (`day`, `fromH` / `toH` as HH:MM in the URL) (ADR-0019). |
| **Stage** | The ordinal of a workflow agent's phase inside its orchestration (`runs.stage_index`, from the journal's launch order); a row in the agent flow (ADR-0020). |
| **Flow key** | The item a workflow agent works on, from the label convention `<stage>:<item>` (`runs.flow_key`, slugged) (ADR-0020). |
| **Run link** | A directed edge between two runs of one turn whose result fed the later one (`run_links`, carried by the target run): `item` (same orchestration and flow key, consecutive stages) or `sequence` (Agent-tool siblings, the later one started after the earlier ended; also derived on read) (ADR-0020). |
| **Agent flow** | The chart of one flow in its section of the turn page: one lane whose rows are the flow's stages, pills = runs over time, arrows = run links (ADR-0020, ADR-0025). |
| **Flow** | At least two sub-agent runs of one turn that form one piece of work: a Workflow-tool run (orchestration), a turn's legacy `workflow:*` runs, or Agent-tool runs connected by run links. Computed on read (`buildFlows`), listed at `/flows`; its detail is a section of its turn's page, `/turns/<id>#flow-<key>` (ADR-0020 amendment, ADR-0025). |
| **Flow flag** | A personal bookmark of one flow (`flow_flags`: user × turn × flow key, name snapshot, note). Only its owner sees it; listed on `/flows` regardless of the date range (ADR-0024). |
| **Flow report** | The print-ready page of one flow (`/report/flows/<turnId>/<key>`); "Download PDF" is the browser's print-to-PDF (ADR-0024). |
| **Complex flow** | A flow with ≥ 5 steps, ≥ 20 min or ≥ 1 M tokens, highlighted on the Overview (ADR-0024). |
| **Ingest statistics** | Company-wide counts of received events by type (24 h / 7 d) and the last receipt, from the `ingest_events` ledger via `agg_ingest_stats()` (ADR-0024). |
| **Usage** | Token counts for a run, split per model × effort. |
| **Skill use** | A skill run in a turn or run, by skill name: started by the model (Skill tool; Codex: reading its SKILL.md) or typed by the user (`/name`). Names follow the project-naming mode (ADR-0016). |
| **MCP call** | A call to an MCP server's tool, counted per server × tool. Names follow the project-naming mode (ADR-0016). |
| **Phase** | Category of time inside a run: thinking, exploring, coding, documenting, testing, validating, other. |
| **Outcome** | success / failed / abandoned / unknown, derived from signals; may be revised by a later patch. |
| **Summary** | ≤ 140-char description of a turn, generated locally by a cheap model during the session (batches of ten, ten-minute wait, or session end; ADR-0023). |
| **Rollup** | Daily aggregate per company / team / user / project / harness / model / effort; skill uses and MCP calls have their own daily rollup per skill / server / tool. |
| **Budget** | Monthly token or estimated-cost limit for a team or user; notifies, never blocks. |
| **Wasted spend** | ≈ Cost of turns whose outcome is failed or abandoned (ADR-0017). |
| **Runaway** | A finished turn far above its user's normal tokens, or over the company's ≈ cost / duration threshold; one alert per turn, mailed in an hourly digest (ADR-0018). |
| **Plan** | Free / Team / Business — limits on users, teams, retention, features. Limits are enforced for growth only: a downgrade keeps existing usage. |
| **Invitation** | A pending offer to join a company/team. Never accepted automatically: a new e-mail picks it on `/signup`, an existing account on `/invitations`; accepting adds a membership. |

## Collector files

- `~/.ai-obs/config.json` (mode 0600, v2): `tokens[]` (name, company label, optional e-mail, endpoint, token), a default
  endpoint, `machine_id`, and `routing_epochs`, which records when the single registered token changed so that a session is
  bound by the routing in force when it started. Malformed entries are kept, not erased. A user token (`aiobs_u_`) or a
  company token (`aiobs_c_`) per entry.
- `~/.ai-obs/projects.json` (0600): project key → token identity (endpoint, company slug, token fingerprint), or `none`.
  Written only by `ai-obs use`, never sent.
- `~/.ai-obs/queue/p/<o|t>-<id>/`: one stream per project and binding. `o-` streams were recorded while the project had no
  usable choice (open, held until `ai-obs use`); `t-` streams are bound to one token identity. `queue/u/` holds streams whose
  key could not be resolved yet. The files of the 0.1.x collector (`queue/*.ndjson`) are moved to `queue/dead/pre-upgrade/`
  by the first registration and never sent.
- `~/.ai-obs/state/`: per-token collector-config cache and delivery state (`blocked` after 401 / 403), the cwd → project key
  cache the hook reads, per-session adapter state (with the pinned stream), the SessionStart markers.
- Routing rules (which token a stream goes to, which streams are held) live in `packages/collector/src/projects.ts`. The sender
  re-reads them before every POST. Details: `packages/collector/README.md`, ADR-0022.
