# Brief: one deployment = one company — per-user tokens, device login, project dot file

Status: **Accepted 2026-10-24 (owner go); built in the working tree, awaiting owner checks.** Deviations are listed in the "Resolved" note at the end. Owner: "We will remove all SaaS parts and change the tool to
only work for single company (per deployment) with multiple teams — this level will stay, but multi-company feature will
be gone. You can merge data from multiple companies to single one on the dev deployment, keep the teams separation. We
will also rework tokens, token will be per-user, team selection will be per-project based on dot file with config. Also
tweak the CLI tool to support interactive login (like our spoor-memory CLI) or manual token. User still can bind multiple
projects to multiple 'companies' — in this case remote servers."

Decisions Q1–Q9 were taken by the owner in the grilling of 2026-10-24. Defaults marked *(assumed)* are Claude's and are
open for review. The subsystem maps behind this brief were produced by a seven-agent workflow (six readers, one critic).

## Goal

One ai-obs deployment serves one company. Teams, leads, members, project → team mapping, budgets and the two
visibility modes stay exactly as today. Every ingest token belongs to one user (or one admin-created service user).
A repository says which team it reports to in a committed dot file. A developer logs the collector in from the terminal
(device code approved in the browser, or a pasted token) and may hold one token per server, so "several companies"
becomes "several servers". Nothing is ever sent to a server the user has not logged in to.

## Decisions

| # | Decision | Owner answer |
|---|---|---|
| Q1 | **The company concept leaves the schema.** `companies` and every `company_id` column are dropped; RLS is rewritten around users and teams; a one-row `deployment` table holds the name, slug, settings and project salt. | Drop entirely now |
| Q2 | **Dev merge: all four companies**, six teams, full visibility, runaway threshold 20 USD, plain project naming, retention 395 days (nothing is deleted). | All four, full, 395 |
| Q3 | **Only the dev DB has several companies.** The merge is a one-off script rehearsed on a `pg_dump`; migration 0018 refuses to run while more than one company exists. | Only dev |
| Q4 | **Committed `.ai-obs.json` with server URL and team slug**, optional git-ignored `.ai-obs.local.json` overriding either. Tokens never go in either file. The collector sends only to servers it holds a token for. `projects.json`, `ai-obs use` and hold-until-assigned go away. | Committed, server + team, local override |
| Q5 | **The admin's project → team mapping always wins.** The dot-file team fills in projects that are not mapped. | Admin mapping wins |
| Q6 | **Fixed 90-day expiry for device-login tokens** (spoor parity), nudge 14 days before. Manually created tokens get a lifetime chosen at creation (30 / 90 / 365 days / none), default 90. | Fixed 90, spoor parity |
| Q7 | **Carry over.** The two live user tokens stay valid (expiry set to cutover + 90 days). Collector 0.5.0 migrates its config, re-binds queued streams, ignores `projects.json`. **Collector 0.4.0 is never published**; 0.5.0 ships the live-session work too. | Carry over, skip 0.4.0 |
| Q8 | **`ADMIN_EMAILS`** replaces `SUPER_ADMIN_EMAILS`: a listed e-mail becomes admin on first login. Everyone else joins by invitation, or automatically as a member when their verified e-mail domain is in **`ALLOWED_EMAIL_DOMAINS`** (empty by default). | ADMIN_EMAILS + domain auto-join |
| Q9 | **Admin-created service users** for CI, bots and shared machines: no login, a name and a primary team, holding tokens that admins create and revoke. | Service users |
| — | **Deployment name: SPECTADO**, slug `spectado`. | SPECTADO |

### Architect defaults *(assumed, open for review)*

- **Dot-file team is membership-checked.** Order: admin mapping → dot-file team if the user is a member of it → user's
  primary team → no team. A non-member or unknown slug falls through with a warning (`team_not_member`,
  `team_unknown`) that `ai-obs status` and `doctor` show. Enforced in the DB by a `SECURITY DEFINER` function, so no
  token holder can feed a team they do not belong to (turns.team_id drives lead visibility and team budgets).
- **No dot file:** with one registered server, send without a team (the server applies mapping → primary team → none)
  and say nothing (resolved 2026-10-24: no nudge). With two or more servers, hold that repository locally and nudge to run `ai-obs link`.
- **Team identifier:** new immutable `teams.slug` (unique, generated from the name, editable only until first use).
- **Same e-mail in several dev companies** (alice in acme + globex; the owner's gmail in plg + spectado): one user, the
  highest role wins (admin), the primary team comes from the company with more turns. The one shared `machines` row
  is merged (its 102 sessions re-pointed). Duplicate team names get a suffix (none in dev). Rollups add up per day.
  Any duplicate external id aborts the merge. Platform audit rows and the company-less super-admin identity are deleted.
- **Device flow** is a copy of spoor-memory's: server-global `POST /api/v1/device/code` and `/device/token` (public, IP
  rate-limited, miss limiter, row cap), an authenticated `/device` page where the user types the 8-letter code and sees
  the client name and requester IP, 10-minute codes, any member may approve their own login, tokens minted by a
  `SECURITY DEFINER` function. One token per machine, named by the client name. The CLI builds `<server>/device` itself.
- **Token visibility:** users see and revoke their own tokens; admins see and revoke every token (ADR-0022 D6) including
  service-user tokens. Leads lose `/admin/tokens` and keep `/admin/budgets`.
- **Ingest write guard:** the ingest context also sets `app.user_id`, and the ingest policies add
  `WITH CHECK user_id = app_user()`.
- **Git-e-mail attribution is dropped.** `ingest_match_user_by_email` and the `matched` / `unverified` paths go; the enum
  values stay for old rows; new rows are always `verified`. The collector may still send `identity.git_email`; the server
  ignores it.
- **Invitations are auto-accepted** at the first magic-link or OAuth login, with a one-time notice naming the visibility
  mode. The cross-company `/invitations` page goes. (SEC-1 guarded against a look-alike company; one company cannot have one.)
- **Blocked-by-401 time does not count** against the collector's 30-day queue age cap, and the collector keeps the expiry
  locally so it can warn before day 90.
- **Model prices** become editable by admins in the admin console (audited); `ensureDefaultModelPrices` keeps seeding.
- **Retention** stays admin-editable within 30–730 days, default 395; budgets are always allowed.
- **Kept as is:** magic link and Google / GitHub OAuth, sessions, invitations to a team with a role, the last-admin rule,
  non-destructive member removal (D1), audit log, budgets, runaway alerts, project naming plain / hashed, aggregates-only
  vs full visibility, the `agg_*` definer functions, DB roles `app_web` / `app_ingest` / `app_worker` / `app_definer`.

## In scope

### Database (packages/db)

- **One-off dev merge script** (`scripts/merge-companies.ts` or SQL under `scripts/`): collapses the four companies into
  `spectado` with the collision rules above; asserts per-table row counts before and after; run on a `pg_dump` copy
  first, then on `ai-obs-postgres-1`. Not a migration.
- **Migration 0018** (hand-written SQL like 0014, drizzle snapshot generated after the schema TS changes): refuses when
  `count(companies) > 1`; creates `deployment` (one row: name, slug, settings, project_salt, unique-index guard) from the
  remaining company; drops `company_id` from every table (about 20) and the composite `(company_id, id)` keys; drops
  `companies`, `identity_providers`, `users.is_super_admin`, `auth_sessions.active_company_id`,
  `company_memberships.last_active_at`, `companies.plan` / `status`, enums `plan`, `company_status`,
  `identity_provider_kind`, token kind `company` (and the column; `user_id` NOT NULL); drops the `app_platform` role, its
  policies, grants and `platform_*` functions, `auth_create_solo_company`, `auth_ensure_super_admin`,
  `company_has_user_capacity`, `auth_user_memberships`, `auth_set_session_company` and the super-admin triggers.
- `company_memberships` becomes `memberships` *(assumed name)*: `user_id`, `role` (admin | member), `primary_team_id`.
- **Users:** `kind` (`person` | `service`), e-mail nullable for service users.
- **Tokens:** `ingest_tokens.expires_at`, `source` (`device` | `manual`), `label` (client name); `lookup_ingest_token`
  returns user, kind, primary team, settings and salt, requires a live membership and `expires_at > now()`.
- **Teams:** `slug`; `ingest_resolve_team(user_id, slug)` (definer, membership-checked).
- **Device login:** `device_codes` (hashed device code, user code, client name, requester IP, expires, status, approving
  user) and `device_exchange()`.
- **RLS rewritten** around `app.user_id` / `app.role` and `team_memberships`; all 40-odd policies and `agg_*` functions
  lose their company predicate; `withRlsContext()` drops `companyId`. The cross-team and visibility proofs in
  `rls.test.ts` are kept case by case; the cross-company proofs go.
- Seed: one deployment, the demo teams and people, `ADMIN_EMAILS`-style admin, no Globex, no super admin.
- New `migration-0018` test on a four-company fixture at 0017 plus the merge script, asserting the counts.

### Dashboard (apps/web)

- Remove `app/super`, `lib/platform`, `app/(auth)/signup` and its API, `CompanySwitcher`, the company-bound form
  machinery (D10), `lib/admin/plans.ts` and every plan check, company tokens (MDM download, stranding), the
  `/invitations` page, `SUPER_ADMIN_EMAILS`.
- `CurrentUser` loses company fields; `requireSuperAdmin` goes; the header shows the deployment name.
- Login provisioning: existing user → login; unknown e-mail → admin if in `ADMIN_EMAILS`, member if invited or if the
  domain is in `ALLOWED_EMAIL_DOMAINS`, else refused with a clear page.
- Admin console: Settings (name, visibility, naming, retention 30–730, runaway thresholds), Teams, Members, Invitations,
  Projects (mapping, now shown as "overrides the repository's dot file"), Budgets, Audit, **Tokens** (every token, person
  and service, with revoke), **Service users** (create, rename, primary team, create / revoke tokens, disable), **Model
  prices**.
- "My tokens": manual creation with a lifetime, list of device logins by client name and expiry, revoke.
- New `/device` approval page and the two public device routes with rate limits.
- Collector-config returns `deployment {name, slug}`, `user {email, name, kind}`, `teams [{slug, name}]` the user belongs
  to, naming mode, salt, `min_collector_version`, token `expires_at`.

### Ingest and protocol (apps/web/src/lib/ingest, packages/protocol)

- `session_start.project` gains optional `team` (slug); `SCHEMA_VERSION` stays 1; the ingest response gains optional
  per-batch `warnings[]` that old collectors ignore.
- Team resolution per the default above, pinned per session at capture time; attribution always `verified`.
- Token auth checks expiry; 401 wording "expired or revoked, run `ai-obs login`".

### Collector (packages/collector, 0.5.0, still zero runtime dependencies)

- **`ai-obs login [--server URL] [--token T|-] [--no-browser]`**: device flow modelled on spoor `cmdLogin` (print
  `Open <server>/device and enter the code XXXX`, open the browser, poll with `authorization_pending` / `slow_down` /
  `access_denied` / `expired_token`, verify with collector-config, store the token mode 0600 in `~/.ai-obs/config.json`,
  one entry per server), or a pasted token. `init` keeps the machine setup (runtime copy, hooks); `init --token --endpoint`
  stays as the non-interactive alias.
- **`ai-obs link --team <slug> [--server URL] [--local]`** writes `.ai-obs.json` (or `.ai-obs.local.json` and adds it to
  `.gitignore`), validating the team against collector-config. `token list` / `token remove <server>` per server;
  `use`, `token confirm` and `projects.json` are deleted (`projects.ts`, `commands/use.ts`, routing epochs, legacy and
  invalid-token handling, open streams and their hold reasons).
- **Config v3** with migration from v2: user-token entries become per-server entries, company-token entries are dropped
  with a message; `t-<id>` streams re-bind to their endpoint; `o-` streams are sent to the single server or held with a
  nudge when several exist.
- Stream key `(project key, server, team slug)`; capture-time pinning (C12 / C15) stays; a dot file changed mid-session
  never retargets a running session.
- Dot-file lookup inside the hook budget (walk up to `.git`, one read, cached like the project key).
- SessionStart nudge reduced to: no dot file with 2+ servers, dot-file server without a token or with an expired /
  rejected one, token expiring within 14 days, dropped events.
- `status` / `doctor` per server plus "this repository: server, team, token state, dot-file validity".
- README and FORMAT rewritten (login, link, dot-file schema, expiry); `live` unchanged.

### Worker (apps/worker)

- No company iteration, no plan caps; retention and runaway thresholds from `deployment.settings`; mails name the
  deployment.

### Deployment and configuration

- `.env.example`, `docker-compose.yml`, `docker-entrypoint.sh`, `packages/db/README.md`: remove `app_platform`
  (`DATABASE_URL_PLATFORM`, `DB_APP_PLATFORM_PASSWORD`) and `SUPER_ADMIN_EMAILS`; add `ADMIN_EMAILS`,
  `ALLOWED_EMAIL_DOMAINS`; `MIN_COLLECTOR_VERSION` 0.5.0 after the rollout.

### Docs

- ADR-0028 "One deployment = one company; the company leaves the schema" (supersedes ADR-0022's membership part,
  ADR-0006 in part; amends ADR-0010, 0012, 0013, 0014; records the dev merge). ADR-0029 "Per-user and service-user
  tokens, device login, fixed expiry" (supersedes ADR-0007 and the token part of ADR-0022). ADR-0030 "Project dot file
  and team resolution" (replaces ADR-0022 C1–C27).
- BRIEF.md (§1, §2, §4, §5.1, §6, §7, §10 removed, §11, §12), ARCHITECTURE.md, root README, the four package READMEs,
  `docs/briefs/multi-company-tokens.md` marked superseded, project memory updated.

## Out of scope

- SSO / SAML / SCIM, payments, plans of any kind.
- Service users that can log in; OAuth or refresh tokens for the CLI (re-run `ai-obs login` after 90 days).
- Removing `identity.git_email` from the wire format (tolerated, ignored).
- Dropping the `attribution` enum values `matched` / `unverified` from old rows.
- Codex JSON SessionStart output, in-turn heartbeat, SSE (deferred follow-ups of ADR-0027 stay deferred).
- Hosting more than one deployment behind one dashboard.

## Constraints

- Release order: dev merge script → migration 0018 and the DB refactor → web + ingest → protocol → collector 0.5.0 →
  `MIN_COLLECTOR_VERSION` bump last. The `app_platform` drop and the removal of `app/super` + `lib/platform` ship together.
- The merge is rehearsed on a `pg_dump` of `ai-obs-postgres-1` before it touches the live dev DB; row counts per table
  are asserted equal before and after.
- Every table FK to `companies` cascades on delete: the merge collapses rows first and drops the companies last.
- Hook budget (in-process under 100 ms, git bounded to 40 ms) and zero runtime dependencies in the collector stay.
- A committed server URL must never make the collector send a token to an origin the user has not logged in to.
- ADRs recorded before the code; docs updated in the same work; commits only when the owner asks.

## Definition of done

- `pnpm test` green in db, web, worker and collector; the privacy proofs (own rows, led teams, admin, aggregates-only vs
  full) survive in `rls.test.ts`; new tests: migration-0018 + merge on a four-company fixture, device flow end to end,
  team resolution (mapping wins, non-member falls through with a warning), token expiry, config v3 migration, dot-file
  lookup inside the hook budget (`hook-process.test.ts`).
- Dev DB merged into SPECTADO with six teams and all 1809 turns present; Docker rebuilt; the dashboard shows the six
  teams and no company switcher.
- Owner manual checks: `ai-obs login` against localhost:3000 approves in the browser; `ai-obs link --team spectado` in a
  repo; a new turn lands under that team; `ai-obs status` shows server, team and expiry; the SessionStart nudge appears
  only in the listed cases.
- Collector 0.5.0 ready to publish (owner publishes); 0.4.0 withdrawn from the publish queue.

## Appendix: cross-package contract (fixed 2026-10-24 so the packages can be built in parallel)

Every agent implements exactly this. A change to it goes through the brief first.

### A. Collector-config, `GET /api/v1/collector-config` (Bearer user token)

```json
{
  "project_naming": "plain",
  "project_salt": "…",
  "min_collector_version": "0.5.0",
  "deployment": { "name": "SPECTADO", "slug": "spectado" },
  "user": { "email": "dev@example.com", "name": "Dev", "kind": "person" },
  "teams": [ { "slug": "spectado", "name": "SPECTADO" } ],
  "primary_team": "spectado",
  "token": { "expires_at": "2027-01-22T10:00:00Z", "label": "mac-ladislav", "source": "device" }
}
```

`project_naming`, `project_salt`, `min_collector_version` are unchanged. `company` is gone. `user.email` is null for a
service user; `teams` lists the teams the user is a member of (in slug order); `primary_team` may be null;
`token.expires_at` is null for a token without expiry, `label` may be null, `source` is `device` or `manual`.

### B. Device login (server-global, modelled on spoor-memory)

- `POST /api/v1/device/code`, public, JSON `{ "client_name": "<hostname>", "client_version": "0.5.0" }` →
  `200 { "device_code": "<43 chars base64url>", "user_code": "ABCD-EFGH", "verification_uri": "<APP_URL>/device",
  "expires_in": 600, "interval": 5 }`. Rate limited per IP (burst 10, 5 / min); at most 100 open codes server-wide
  (`429` beyond). `user_code` is 8 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` shown as `XXXX-XXXX`; the CLI accepts both forms.
- `POST /api/v1/device/token`, public, JSON `{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
  "device_code": "…" }` → `200 { "token": "aiobs_u_…", "expires_at": "<iso>", "label": "<client_name>" }`, else
  `400 { "error": "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" }`.
  Polling faster than `interval` answers `slow_down`. A code is exchanged at most once.
- `GET /device` (dashboard, authenticated; unauthenticated visitors go to `/login?next=/device`): the user types the
  code and sees client name, requester IP and age, then **Approve** or **Deny**. Any member (person) may approve their
  own login. Approval marks the code approved by the person; the next poll of `/device/token` mints the token for the approver
  with `expires_at = now() + 90 days`, `source = 'device'`, `label = client_name`, through `device_exchange`
  (`SECURITY DEFINER`), which writes `token.create` (actor = approver) and consumes the code.
- `device_codes` table: `id`, `device_code_hash` (sha256), `user_code` (unique among open codes), `client_name`,
  `client_version`, `requester_ip`, `created_at`, `expires_at`, `status` (`pending` | `approved` | `denied` |
  `consumed` | `expired`), `approved_by` (user id, nullable), `token_id` (nullable), `last_polled_at`.

### C. Wire format (schema version stays 1)

- `session_start.project` gains optional `team` (team slug, 1–63 of `a-z0-9-`): the dot-file team in force when the
  session started. Absent means "no dot file". The protocol accepts any string up to 128 characters as `team` (not only a
  valid slug); ingest answers a malformed or unknown one with a `team_unknown` warning and falls back, instead of rejecting
  the event.
- The ingest response gains optional `warnings: [{ "code": "team_not_member" | "team_unknown", "team": "<slug>",
  "session_id": "<id>" }]`, at most one per session per batch. Old collectors ignore it; the collector records the
  latest warning per project in `state/warnings.json` and shows it in `status` / `doctor`.
- `header.identity.git_email` stays optional and is ignored by the server.
- Token prefix stays `aiobs_u_` for person and service users (`aiobs_c_` is rejected with 401).

### D. Team resolution (server, per session, at `session_start`; later events of the session reuse it)

1. The admin's project → team mapping (`projects.team_id`) if set.
2. Else `project.team` if the user is a member of that team (`ingest_resolve_team(user_id, slug)`), else warning
   `team_not_member` (member of no such team) or `team_unknown` (no such slug) and continue with step 3.
3. Else the user's primary team. 4. Else no team.

### E. Collector files

- `~/.ai-obs/config.json` **v3** (mode 0600): `{ "version": 3, "machine_id", "created_at", "servers": [ { "endpoint",
  "token", "email", "deployment": { "name", "slug" }, "label", "expires_at", "source", "added_at" } ] }`. One entry per
  endpoint (origin). A token is only ever sent to its own `endpoint`. v2 files are migrated on first load: user-token
  entries become server entries (endpoint kept, `expires_at` unknown until the next collector-config fetch), company-token
  entries are dropped with a logged message, `routing_epochs`, `legacy`, `invalid_tokens`, `prior_fps` are discarded.
- `~/.ai-obs/projects.json` is no longer read. On migration it is renamed to `projects.json.v2` (kept for inspection).
- Repository dot file `.ai-obs.json` at the git top level (committed): `{ "server": "https://obs.example.com",
  "team": "spectado" }`. `.ai-obs.local.json` (git-ignored) with the same keys overrides per key. Both optional. The
  lookup walks from the working directory up to the git top level (first hit wins, no git call: stop at the directory
  that holds `.git`) and is cached beside the project-key cache. Unknown keys are ignored; a malformed file counts as
  absent and is reported by `status` / `doctor`.
- Queue stream key: `(project key, server endpoint, team slug | "")` → `queue/p/s-<id>/` with `stream.json`
  `{ key, endpoint, team }`. A session is pinned to its stream at its first hook. On config migration `t-<id>` streams
  bound to a kept user token become `s-` streams of that endpoint with `team ""`; `o-` streams become `s-` streams of the
  single server, or stay held (`held: no-server`) when several servers are registered; `queue/dead/pre-upgrade` is untouched.
- `~/.ai-obs/state/delivery.json` and `state/collector-config/<host>.json` are keyed by endpoint host.

### F. Environment

`ADMIN_EMAILS` (comma-separated; listed e-mails become admin on first login), `ALLOWED_EMAIL_DOMAINS` (comma-separated,
empty by default). `SUPER_ADMIN_EMAILS`, `DATABASE_URL_PLATFORM`, `DB_APP_PLATFORM_PASSWORD` are removed.

### G. Merge script interface (dev DB only, runs on the 0017 schema before migration 0018)

`packages/db/src/merge-companies.ts` exports `mergeCompanies(url, { survivor: 'spectado-c7faa0', name: 'SPECTADO',
slug: 'spectado', settings: { individualVisibility: 'full', retentionDays: 395, runawayCostUsd: 20, projectNaming:
'plain' } })` and `pnpm --filter @ai-obs/db db:merge-companies -- --survivor <slug> --name <n> --slug <s> [--dry-run]`.
It runs in one transaction under `app_definer`, prints per-table row counts before and after, aborts on a duplicate
external id, and refuses when the survivor is missing. Migration 0018 refuses to run while `count(companies) > 1`.

## Resolved 2026-10-24

Deviations of the build from the text above, accepted: the token is minted at the token exchange, not at approval
(Appendix B); the no-dot-file single-server nudge is resolved as none; the merge script keeps and re-points rollup rows
(sums asserted) and de-duplicates events and patches. See ADR-0028 to ADR-0030 for the details.
