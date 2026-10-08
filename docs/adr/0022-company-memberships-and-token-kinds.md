# ADR-0022: Company memberships, user and company tokens, per-project token choice

- **Status:** Accepted. Supersedes in part [ADR-0007](0007-ingest-tokens.md); amends [ADR-0011](0011-local-queue-idempotent-delivery.md)
  (queue streams, pre-upgrade stream), [ADR-0012](0012-retention-and-rollups.md), [ADR-0013](0013-dashboard-authentication.md),
  [ADR-0014](0014-db-roles-and-connections.md) (`platform_invitee_status`), BRIEF §4 and §5.1
- **Date:** 2026-10-08
- **Deciders:** Ladislav Soukup (owner: grilling Q1-Q9 and "yes, go!" on `docs/briefs/multi-company-tokens.md`; confirmed D1, D2
  and D6 and the lint item afterwards); options proposed by Claude
- **Tags:** security, auth, schema, collector

## Context

A developer works for several companies, and in several teams in each. Two things stood in the way:

- `users.company_id` made one login belong to exactly one company, so the same e-mail could not be invited to a second one.
- Team tokens bound a machine to one team, and a collector config held a single token, so every repo on a machine reported
  to the same place.

The owner asked that one developer can be part of several companies and teams, register one collector token per company on a
machine and choose per project which one is used, with the AI harness asking when no token has been chosen yet. Nothing may
ever be sent to the wrong company.

## Decision

### Owner decisions (grilling of 2026-10-08)

| # | Decision |
|---|---|
| Q1 | **One login, many companies.** A user account holds memberships in several companies; the dashboard gets a company switcher. |
| Q2 | **Token kinds: company + user, no team binding.** Company tokens (`aiobs_c_`) for bots / CI / rollout match users by git e-mail company-wide. User tokens (`aiobs_u_`) identify the user in one company. Team tokens are dropped. Team attribution: project mapping, else the user's primary team in that company. |
| Q3 | **Hold until assigned.** With two or more registered tokens, an unassigned project's events stay in the local queue and are sent only after assignment. With one token nothing changes. |
| Q4 | **Assignment key = normalized git remote, else repo top-level path** (the project-key rule of ADR-0008). Stored locally, never sent. |
| Q5 | **Server-provided labels, endpoint per token.** The collector-config endpoint returns company name + slug and (user token) the e-mail; the token is stored under the company slug (`--name` overrides). |
| Q6 | **`company_memberships` table, active company on the session.** `users` keeps identity only. Invitations to an existing e-mail add a membership; sign-up with an existing e-mail logs in. Removal from a company revokes the user's tokens there. |
| Q7 | **Clean break.** The migration revokes every existing token; everyone re-runs `ai-obs init`. No legacy prefix. |
| Q8 | **SessionStart context, once per session until assigned.** The hook returns `additionalContext` naming the project key, the registered token names and the `ai-obs use <name>` instruction. No "default token" when two or more are registered. Also shown by `ai-obs status` / `doctor`. |
| Q9 | **Company tokens: admins and leads.** User tokens: everyone, own only. |

### Design decisions (Claude, within the brief)

- **D1, removal is non-destructive (owner confirmed).** Removing a member keeps their raw telemetry, machines and runaway
  alerts in that company; only team memberships and per-user budgets are deleted. The telemetry foreign keys point at
  `users(id)`. Rows of former members render as "former member". If the owner later wants deletion, only the body of
  `admin_remove_member` changes, with no schema change.
- **D2, tokens are revoked, not deleted.** `admin_remove_member` revokes the member's user tokens and the company tokens they
  created. The same company tokens are revoked when a role change leaves their creator neither an admin nor a lead of any team
  in that company (owner confirmed). `lookup_ingest_token` also requires a live membership for user tokens, and accepts a
  company token only while its creator is still an admin or a team lead of the company, so a token inserted concurrently
  with the creator's removal or demotion (which the one-shot revoke cannot see) never works.
- **D3, `turns.team_id` and `runaway_alerts.team_id` are nullable.** Team: project mapping, else the primary team of the
  resolved user in that company, else null.
- **D4, the last active company is `company_memberships.last_active_at`,** stamped by a trigger when a session is created in,
  or switched to, a company. Login picks the newest.
- **D5, a user with no membership goes through sign-up** like a new e-mail; one whose companies are all suspended gets an
  invitations-only sign-up when invited, else is blocked. Sign-up works on the identity's own e-mail. A super admin with no
  membership whose e-mail left `SUPER_ADMIN_EMAILS` stays blocked (`no-company`): neither sign-up path could succeed.
- **D6, admins keep seeing and revoking members' user tokens (owner confirmed);** leads see company tokens; members see their
  own user tokens. Only the owner creates a user token. Revocation is one-way (trigger).
- **D7, existing team tokens are retyped to company by the enum swap** and revoked like every other token.
- **D8, member removal runs in a SECURITY DEFINER function,** `admin_remove_member(uuid)`: revoke tokens, clear the member's
  sessions' `active_company_id`, delete the membership, atomically.
- **D9, existing accounts accept invitations at `/invitations`;** the invitation e-mail links to `/login?next=/invitations`.
  Consent stays explicit (SEC-1).
- **D10, every mutating admin and token form is bound to the company it was rendered for** (hidden `_companyId`, checked
  against the session's active company); a mismatch is refused. The active company is shared by all tabs of a session.
  Each page renders the binding from its own session read, never a shared layout (a layout is not re-rendered on client
  navigation, so it could keep the company of an earlier page).
- **D11, DB invariants are triggers:** a super admin holds no membership and a member cannot become a super admin; a revoked
  token stays revoked; a membership's primary team belongs to the same company (composite FK).
- **Collector contract:** collector-config returns `company: {name, slug}` and `user: {email} | null`; naming mode and salt are
  per token and applied at send time; 401 / 403 keep the batches of that token and surface in `status` / `doctor`.
- **Order of the migration (0014):** create memberships from `users`, set `active_company_id` on sessions, retype token kinds,
  revoke every token, then drop `users.company_id / company_role / primary_team_id` and `ingest_tokens.team_id`.
- **The lint item of the brief is not applicable:** the repo has no lint script or linter; the owner accepted that.

## Consequences

- Turns can have no team; team breakdowns show them as unassigned.
- Every token is revoked at the upgrade; each developer re-runs `ai-obs init`.
- `users` holds identity only; `app_web` reads only its identity columns (`last_login_at` is not visible to co-members).
- Plan limits count memberships.
- The active company is session-wide, so forms are company-bound (D10). The company-switch audit row is written only in the
  destination company and records no source.
- Removal keeps recorded activity of former members (D1); the ADR-0012 anonymising cascade only applies when an operator deletes
  an identity.
- Collector 0.2.0 registers several tokens per machine and implements `ai-obs use`, hold-until-assigned and the SessionStart
  question (Q3–Q5, Q8); see "Collector (design, Claude, 2026-10-08)" below. Deployers raise `MIN_COLLECTOR_VERSION` to 0.2.0.
- Project naming and the salt are applied per token at send time by the collector, so a project assigned to another company
  is hashed with that company's salt.
- **Rollout note:** right after the upgrade every old collector gets 401. Behind one NAT IP that can empty the per-IP
  failed-auth budget and make a fresh token's first request 429 until it refills. Old collectors back off to one try per hour;
  operators should raise `INGEST_FAILED_AUTH_BURST` / `INGEST_FAILED_AUTH_PER_MINUTE` for the first day (or restart the web
  process to reset the guard); `ai-obs init` and `token add` retry after `Retry-After`.

## Alternatives considered

- **One user row per company** (the previous model) - one login per company, no switcher, no way to report to two companies
  from one identity.
- **Team tokens kept beside company tokens** - a third kind that binds a machine to one team and cannot serve a developer in
  several; dropped (Q2).
- **Auto-pick the token** (last used, or the first) - risks sending a repo's data to the wrong company; held until the
  developer chooses (Q3).
- **Delete a member's telemetry on removal** - irreversible and not asked for; kept instead (D1).

## Collector (design, Claude, 2026-10-08)

- **Status:** Accepted and shipped in collector 0.2.0 (`MIN_COLLECTOR_VERSION` 0.2.0: older collectors cannot register a token).
- **Deciders:** the owner for Q3, Q4, Q5 and Q8 (above) and for the four open questions below (answered 2026-10-08); Claude for
  C1-C27, within the brief.

### Decisions C1-C27

- **C1 Streams.** The queue is a set of streams keyed by (project key, binding): `queue/p/o-<id>/` open, `queue/p/t-<id>/`
  token-bound, `queue/u/` unresolved key, root `queue/*.ndjson` the frozen pre-upgrade stream. Each directory is created with its
  `stream.json`.
- **C2 Project key.** `normalizeRemote(remote)`, else the git top level, else `realpath(cwd)`; `null` only when git timed out; never sent.
- **C3 Naming at send time.** The queue holds plain keys and plain skill / MCP names; the sender rewrites `session_start.project` and applies
  the receiving token's naming mode and salt. A path key is always sent as `sha256:` + HMAC(local secret).
- **C4 No send without a fetched collector-config.** Such a token keeps its streams queued.
- **C5 Clean break of config.json.** A 0.1.x file loads as `tokens: []`; the first registration records `legacy` (masked token only) and deletes the old cache.
- **C6 Zero tokens, nothing recorded.** The worker drops jobs; every CLI command except `hook` prints an upgrade banner. Known limit: a machine that still runs the 0.1.x hook runtime and never runs the CLI gets no signal from the collector; the README and the rollout note are the channel.
- **C7 Pre-upgrade stream (amended, see below):** never sent.
- **C8 Token identity, not name.** Assignments and bindings store `{endpoint, company_slug?, token_fp}`; rotation within a company (`prior_fps`) keeps data, a reused name does not inherit another company's.
- **C9 Unverified tokens.** With another token registered, offline registration needs `--name` and sends nothing until its company is known (`token confirm` or a fetch). A single offline token is named `default` and the first successful fetch confirms and renames it.
- **C10 `AI_OBS_ENDPOINT`** is only the default endpoint for `init` / `token add`; the 401 / 403 message then suggests `--endpoint`.
- **C11 Nudge once per session per text** (marker `state/nudged/<session>`, sha1 of the text).
- **C12 Capture-time binding.** A session is bound by the routing in force at its first hook (C18), also when that hook enqueued nothing (Codex pins at its first hook); bound data goes only to that identity, also when an unresolved stream is adopted after a later `use`; `use --move-queued` is the explicit exception. A session that started open joins the project's choice from its next event on: what it records after `use <name>` stays with `<name>`, what it recorded before follows the choice as open data (owner decision 2). An explicit choice saved after a session's first hook does not take that session from the single token it was captured under.
- **C13 Caps.** The 30-day age cap applies only to streams that resolve to a sendable, non-blocked token, and counts from when the stream became sendable (`sendable_since` / `seen_at` in its `stream.json`, recorded by every flush and cap run; a stream not seen for two days starts a new period), so data released after a hold gets its full 30 days. The 50 MB cap applies to all, oldest segment first; every drop (held or sendable) is counted in `state/dropped.json` and shown in `status`, `doctor`, `flush` and once in the next SessionStart text (the hook records that in `state/dropped-shown.json`, never in the counters).
- **C14 `maxBatches` per flush applies per token.**
- **C15 A session's stream is pinned once** (`stream` in the session state).
- **C16 No key, no guessing.** A git timeout writes to an unresolved stream that the sender re-resolves; events with no cwd are dropped and logged.
- **C17 Routing is read fresh** per stream and before every POST; the worker re-reads config every loop and runs again when config.json or projects.json changed.
- **C18 Routing epochs** (`routing_epochs` in config.json) replace per-stream hold flags: a session binds by the epoch in force at its first hook's `received_at`.
- **C19 `use --none`** stops recording the repository and holds what is queued (`opted-out`), unresolved streams adopted later included; `--discard-queued` deletes.
- **C20 `use <name> --all-held`** assigns every repository whose open data is held; going from one to two tokens lists recently seen repositories.
- **C21 Codex SessionStart output** was designed as the same JSON as Claude Code (checked on codex-cli 0.154.0). The owner later reported codex-cli 0.154.0 rejecting it, so Codex gets plain text (`SESSION_START_OUTPUT` in `src/nudge.ts`; `FORMAT.md`, "Hook output").
- **C22 Malformed token entries survive every write** (`invalid_tokens`); while any exist the single-token rule is off; only `token remove --invalid` deletes them.
- **C23 projects.json is written only by `use`.** Unreadable: `use` refuses except `use --reset-projects` (renames aside); with two or more tokens new sessions are open, with one token routing continues.
- **C24 Lock discipline.** `init`, `token add|confirm|remove` and `use --move-queued | --discard-queued` take `worker.lock` for the write phase (30 s, then "nothing was changed"). The holder refreshes the lock's mtime while it holds it, so a live worker is never taken over by age, and release removes the lock only while it is still the holder's. `use` re-reads projects.json right before each write.
- **C25 Job files v2.** The new hook writes `jobs/<ulid>.v2.json`; the worker reads both names, so a 0.1.x worker still in memory cannot process a new job into the old stream. `init` and `token add` refresh `<home>/app`.
- **C26 Bounded git in the hook.** Only on a key-cache miss, only when under 40 ms have elapsed, killed at the deadline; the Claude Code SessionStart entry gets `timeout: 5`, Codex entries stay unchanged.
- **C27 Hook budget** is in-process time from `runHook` entry (Node start-up excluded); see "Hook budget" below.

### Routing tables

`T` = valid registered tokens, `a` = the project's assignment, `match(I)` = the token entry matching identity `I`.

**A, capture binding** (once per session; first match wins):

| # | Condition | Result |
|---|---|---|
| A1 | no tokens | not recorded (the worker drops the job) |
| A2 | `a` is `none` | drop |
| A3 | `a` explicit with identity `I`, `match(I)` exists | bind token `I` (even if blocked or unverified) |
| A4 | `a` explicit, no match | open, `dangling` |
| A5 | the epoch in force has a single token that still exists | bind that token (also when projects.json is unreadable) |
| A6 | two or more tokens and projects.json unreadable | open, `projects-unreadable` |
| A7 | malformed token entries exist | open, `config-damaged` |
| A8 | otherwise | open, `unassigned` |

**B, send resolution** (sender, cap, `status`; first match wins):

| # | Stream | Condition | Result |
|---|---|---|---|
| B1 | unknown / unresolved | - | held `unknown-stream` / `unresolved` |
| B2 | any | no tokens | held `no-tokens` |
| B3 | project / pre-upgrade | `a` is `none` | held `opted-out` |
| B4 | bound to `I` | no match: held `dangling`; match not usable: held `unverified` / `company-mismatch`; else | send with that token |
| B5 | open | projects.json unreadable | held `projects-unreadable` |
| B6 | open | `a` explicit with `I` | as B4 |
| B7 | open | no `a` | held `unassigned` (open data is released only by an explicit choice) |
| B8 | pre-upgrade | always | held `pre-upgrade` (never sent, see below) |

Transitions: **1 to 2 tokens**, sessions captured before stay bound to the first token and new sessions are open until `use`.
**2 to 1 tokens**, open data stays held until an explicit `use`; new sessions bind to the remaining token; data bound to the removed token is dangling until a token of the same company is registered again or `--move-queued`. **Re-assignment** `use b` after A: A-bound data goes to A or waits, B gets open data and new sessions, and only `--move-queued` moves A-bound data. A **repaired damaged config** leaves data captured meanwhile open. **`--reset-projects`** leaves bound data alone, open data waits again and `--none` choices of the old file stop applying.

### Pre-upgrade queue and the 0.1.x plain names

The contract (server design 5.5) allowed sending the pre-upgrade stream to a single registered token. The owner decided instead (2026-10-08)
that **pre-upgrade data is never sent**: tokens were reset (Q7), so no token can claim batches written under the old ones. Every
successful `init` / `token add` moves the root `queue/*.ndjson` files to `queue/dead/pre-upgrade/` and `status` / `doctor`
report the count once. This replaces the planned `use --pre-upgrade`, `legacy.salt_fp` and the salt-mismatch hold. For the same reason
a 0.1.x session state without a working directory, and pending summary digests without a stream key, have their events dropped
and logged: nothing can prove which company they belong to.

### Other collector decisions

- **Per-token 401 / 403.** A rejected (401) or suspended (403) token keeps its batches, stops sending, shows in `status` / `doctor` /
  the SessionStart text; automatic flushes skip it, `flush` retries once, a success clears the block. Other tokens keep sending.
- **Per-token cache and send-time naming** (privacy note): the collector-config is cached per token; because names are hashed when sending, plain remotes and
  skill / MCP names now sit in the local queue (mode 0600) in every company, including hashed-naming ones. They never leave the machine in plain form.
- **Nudge content rule.** The SessionStart text carries identifiers only: the sanitized project key, token names, company slugs, hosts, and a sanitized `<dir>` / `<cmd>`; never a token, a display name or free text.
- **`AI_OBS_ENDPOINT` change** (C10): it no longer overrides endpoints at runtime; each token keeps its own.
- **Single-token offline `default`** with first-fetch confirmation (C9), because with one token whatever the server says is the only company.
- **`use --none` keeps data** (C19); deletion needs `--discard-queued`.
- **Job file v2** (C25).
- **Version.** Collector 0.2.0; `MIN_COLLECTOR_VERSION` 0.2.0 on servers that have revoked the old tokens.
- **Upgrade signal limit** (C6).

### Hook budget (C27)

The brief says hook handlers return in under 100 ms. The collector cannot shorten Node start-up (about 60-85 ms, unchanged from 0.1.x), so the
budget is read as **in-process time from hook entry**: everything the collector adds is bounded (key cache first, git only when under 40 ms
have elapsed and for at most 40 ms, no network). This is a reinterpretation of the brief's constraint, recorded here; the real-process test
(`test/hook-process.test.ts`) checks under 400 ms wall time (500 ms on CI).

### Owner answers to the open questions (2026-10-08)

1. **`use --none` stays** (a repository that belongs to no company stops asking; queued data is kept until `--discard-queued`).
2. **Re-assignment moves only data recorded while the project had no choice;** older data needs `--move-queued`.
3. **Pre-upgrade data is never sent** (a simplification of the design's single-token rule), see above.
4. **The hook budget is in-process time from hook entry,** git bounded to 40 ms and only while under 40 ms have elapsed.

### Design assumptions not yet confirmed by the owner

- Codex gets plain text for SessionStart, based on the owner's report about codex-cli 0.154.0; Claude Code gets JSON. If a Codex build accepts JSON the switch is one line.
- A project with no remote and no git top level is keyed by its directory path, so a moved directory is a new project.
- Dropped events (size cap) are reported once in the next SessionStart text and on every `status` / `doctor`; no stronger alert exists.
- The SessionStart text is capped at 1000 characters. When it is longer it is shortened in this order: token details, the repeated collector command (written once, then plain `ai-obs`), `--project-dir`, and only then the number of tokens named (Claude, 2026-10-08, after `hook-process.test.ts` showed a long command cutting the token list).

