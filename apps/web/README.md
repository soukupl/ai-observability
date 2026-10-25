# @ai-obs/web

## Authentication

Dashboard login per [ADR-0013](../../docs/adr/0013-dashboard-authentication.md) as amended by
[ADR-0028](../../docs/adr/0028-one-deployment-one-company.md): magic link e-mail and Google / GitHub OAuth, no
passwords. One deployment serves one company, so there is no sign-up, no company switcher and no super admin. Code:
`src/lib/auth/*`, routes in `src/app/api/auth/*`, pages in `src/app/(auth)/*`, route protection in `src/proxy.ts`.

### Flows

| Step | Route |
|---|---|
| Request a magic link (form POST, origin-checked, rate-limited 5 per e-mail and 20 per IP per 15 min, in memory). The e-mail names the deployment ("Your SPECTADO sign-in link") | `POST /api/auth/magic` → `/login/sent` |
| E-mailed link (single use, 15 min; only the SHA-256 of the token is stored in `magic_links`). GET never consumes it (mail scanners prefetch links): it redirects to a confirm page whose "Continue to sign in" button POSTs back; only that same-origin POST verifies + consumes | `GET /api/auth/magic/<token>[?next=/path]` → `/login/magic/<token>` → `POST /api/auth/magic/<token>` |
| OAuth (state + PKCE for Google in a signed httpOnly cookie, 10 min; only a provider-verified e-mail is accepted) | `GET /api/auth/<google\|github>/start[?next=]` → `/callback` |
| Refusal page for an e-mail no rule admits (no account is created) | `/login/refused?reason=not-invited\|removed` |
| One-time welcome notice after joining: names the deployment, the new member's role and teams and what the visibility mode means for their data, then continues to `next` | `/welcome[?next=]` |
| Logout (also the `logout` server action, `/logout` page) | `POST /api/auth/logout` |

After a verified e-mail, the provisioning rules (`src/lib/auth/provisioning.ts`, pure and unit-tested) decide
(ADR-0028 E6, E7):

1. A linked OAuth account (`auth_accounts`) or a person with a membership → **log in**. Open invitations for that
   e-mail are accepted on the way (they only add team memberships; the role does not change).
2. An e-mail never seen before, listed in **`ADMIN_EMAILS`** → `auth_provision_member(email, name, 'admin')`, then any
   open invitations add their teams.
3. An unknown e-mail with **open invitations** → every invitation is **auto-accepted** (`auth_accept_invitation`), an
   admin invitation first (the first accepted creates the membership, so it decides the role and the primary team),
   then newest first. Possession of the mailbox or OAuth identity is the consent (SEC-1 guarded against a look-alike
   company, which cannot exist with one company per deployment).
4. An unknown e-mail whose domain is listed in **`ALLOWED_EMAIL_DOMAINS`** (exact match, no sub-domains) →
   `auth_provision_member(email, name, 'member')`, no team.
5. Otherwise → refused (`/login/refused?reason=not-invited`).

A **removed member** (identity without membership, ADR-0022 D1) gets back in only through a new invitation:
`ADMIN_EMAILS` grants admin at first login only, and the domain rule must not undo an admin's removal
(`/login/refused?reason=removed`). Service users (`users.kind = 'service'`) have no e-mail and never log in. Rules 2–4
land on `/welcome` once and write `auth.provisioned` or `auth.invitation_accepted` (meta: method and rule). All of this
runs as `app_web` through the `auth_*` `SECURITY DEFINER` functions (no RLS context exists before login).

### Sessions

- Cookie `ai_obs_session`: 256-bit random id, `HttpOnly`, `SameSite=Lax`, `Secure` when `APP_URL` is https, `Max-Age`
  30 days. `auth_sessions` stores only its SHA-256. Every request re-reads the user and their membership
  (`auth_get_user`): a removed member, or an identity that is not a person, has no session any more.
- Sliding expiry: the DB expiry moves to now + 30 days at most once an hour (`getCurrentUser()`), and `proxy.ts` re-sets
  the cookie's `Max-Age` on page loads.
- Redirects and e-mailed links are built from `APP_URL`; `next` accepts only same-site relative paths (`safeNext()`,
  which also refuses `/login`, `/logout`, `/welcome` and `/api/auth/*`), so there are no open redirects.
- State-changing POSTs check `Origin` (or `Referer` / `Sec-Fetch-Site`) against `APP_URL`; that includes the magic-link
  confirm POST (cross-site or origin-less → 403, token untouched). The confirm page sets `Referrer-Policy: same-origin`
  so the token in its URL never leaves in a `Referer`.
- `audit_log` gets `auth.login`, `auth.logout`, `auth.provisioned`, `auth.invitation_accepted` (meta: login method and
  provisioning rule only, no IPs or e-mails), written as the user under their own RLS context.

### Using it in pages and handlers (`src/lib/auth/session.ts`)

```ts
const user = await requireUser();        // CurrentUser; no session → /login
const admin = await requireAdmin();      // role 'admin', else → /overview
const maybe = await getCurrentUser();    // CurrentUser | null, cached per request (React cache())
await withUserDb(user, (tx) => …);       // from '@/lib/db' or '@/lib/auth/rls': RLS context { userId, role } as app_web
<form action={logout}>…</form>           // server action
```

`CurrentUser` is `{ id, email, name, role: 'admin' | 'member', teams: { id, slug, name, role: 'member' | 'lead' }[],
primaryTeamId, deployment: { id, name, slug, settings } }`. The visibility mode is
`user.deployment.settings.individualVisibility`, the naming mode `user.deployment.settings.projectNaming`. Lead rights
come from `team_memberships` in the DB, and the DB re-checks `role` against `memberships`, so a stale admin claim
cannot escalate.

`src/proxy.ts` sends requests without a session cookie to `/login?next=…` (API calls get 401). Public
(`src/lib/auth/routes.ts`): `/`, `/login*`, `/logout`, `/api/auth/*`, `/api/v1/ingest`, `/api/v1/collector-config`
and the two device-login routes `/api/v1/device/code` and `/api/v1/device/token` (the CLI has no token yet; rate
limited per IP). `/device` and `/welcome` need a session, so `ai-obs login` opening `/device` lands on
`/login?next=/device` and comes back after sign-in. The proxy only checks that the cookie exists; pages must still call
`requireUser()` etc.

### Device login approval (`/device`, ADR-0029 T4)

`ai-obs login --server <APP_URL>` asks `POST /api/v1/device/code` for a code, prints `Open <server>/device and enter the
code XXXX-XXXX` and opens the browser. On `/device` (`src/app/(dashboard)/device/page.tsx` and `DeviceApproval.tsx`,
one POST server action `deviceAction` in `src/lib/auth/device-actions.ts`, logic in `src/lib/auth/device.ts`) the
signed-in person types the code (`XXXX-XXXX` or `XXXXXXXX`, any case), sees the computer
name, collector version, requester IP and age (`device_lookup`), and presses **Approve** (`device_approve`, audited as
`device.approve`) or **Deny** (`device_deny`, `device.deny`). Approval only marks the code: the CLI's next poll of
`POST /api/v1/device/token` mints the token for the approver through `device_exchange` (90 days, `source = 'device'`,
`label` = the computer name, audit `token.create`). Codes live 10 minutes; any person with a membership may approve
their own login, service users cannot. The code is always posted, never read from the URL, so a link cannot skip typing
it. Wrong codes are limited to 20 per user per 15 minutes (`deviceMissLimiter`, per web process): lookup, Approve and
Deny all run through `withMissBudget`, which counts a code that is not open as a miss and, once the budget is spent,
refuses every attempt (a correct code too) before it reaches the database.

### Environment

`APP_URL`; `SESSION_SECRET` (signs the OAuth cookie; required in production; a missing or placeholder value in
production shows `/login?error=config` with a clear message instead of a 500, and the cause is logged once);
**`ADMIN_EMAILS`** (comma-separated, case-insensitive: these e-mails become admin at their first login; removing one
later demotes nobody, admins are managed in the console); **`ALLOWED_EMAIL_DOMAINS`** (comma-separated, empty by
default: an unknown, verified e-mail of one of these domains joins as a member with no team); `TRUSTED_PROXY_HOPS`
(default 1: how many proxies append to `X-Forwarded-For`, the client IP is the n-th entry from the right; 0 = use
`X-Real-IP` only; without a proxy in front the headers are client-controlled and only the per-e-mail limit protects
`/api/auth/magic`); `SMTP_*` (Mailpit in dev); `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` (buttons appear
only when set). OAuth callback URLs: `${APP_URL}/api/auth/google/callback`, `${APP_URL}/api/auth/github/callback`.
`SUPER_ADMIN_EMAILS` and `DATABASE_URL_PLATFORM` are gone (ADR-0028 E10).

### Demo accounts

`pnpm db:seed` (see `packages/db/README.md`) names the deployment SPECTADO and creates `alice@acme.example` (admin),
`bob@acme.example` (lead of Platform), `carol@acme.example` and `dave@acme.example` (Mobile), the first `ADMIN_EMAILS`
address (default `admin@example.com`) as an admin, and the service user "Demo CI". Sign in with any of the e-mails by
magic link; in dev the mail lands in Mailpit (http://localhost:8025).

### Tests

`pnpm vitest run --project web test/auth` runs: token / cookie / origin / rate-limit helpers and the public-route list
(`helpers.test.ts`), `clientIp`, the placeholder-secret redirect and the login redirects including the refusal page
(`http.test.ts`), the provisioning rules (`provisioning.test.ts`), the device-code helpers (`device.test.ts`), and two
real-Postgres suites that create and drop their own databases (skipped without Postgres): `magic-link-flow.test.ts`
(database `ai_obs_webauth_test` on `TEST_DATABASE_URL`'s server: `ADMIN_EMAILS`, auto-accepted invitations incl. the
admin-first order, the domain allow-list and its sub-domain refusal, refusal without side effects, existing members,
removal and re-invitation, logout, OAuth linking, the scanner-safe link endpoint, the rate limit) and
`device-flow.test.ts` (`<TEST_DATABASE_URL name>_device_test`, by default `ai_obs_webauth_device_test`: lookup,
approve, exchange once, deny, the spent wrong-code budget refusing a correct code, service users refused).

## Ingest API

Collector-facing endpoints (BRIEF §6, ADR-0005/0011, ADR-0029, ADR-0030). Route modules in
`src/app/api/v1/{ingest,collector-config,device/code,device/token}/route.ts` are thin; the logic lives in
`src/lib/ingest/` and runs as the DB role `app_ingest` (`dbFor('ingest')`).

| Endpoint | Auth | Response |
|---|---|---|
| `POST /api/v1/ingest` | `Authorization: Bearer aiobs_u_…` (a person's or a service user's token) | `200 { accepted, duplicates, rejected: [{ event_id, reason }] }` (the protocol's optional `warnings` is no longer sent, ADR-0035) |
| `GET /api/v1/collector-config` | same | brief Appendix A: `{ project_naming: "plain" \| "hashed", min_collector_version, project_salt, deployment: { name, slug }, user: { email \| null, name, kind: "person" \| "service" }, teams: [{ slug, name }], primary_team: slug \| null, token: { expires_at \| null, label \| null, source: "device" \| "manual" } }` (`MIN_COLLECTOR_VERSION`, default `0.0.0`; `project_salt` is the deployment's stable 64-hex secret the collector HMACs hashed project keys with, ADR-0008; `teams` are the user's teams in slug order, which `ai-obs login` and `doctor` list; cached privately for 300 s) |
| `POST /api/v1/device/code` | public | `{ client_name, client_version }` → `200 { device_code, user_code: "XXXX-XXXX", verification_uri: "<APP_URL>/device", expires_in: 600, interval: 5 }`; `429` beyond 10 requests per client IP in a burst (5 / min sustained) or while 100 codes are open server-wide; `400 { error: "invalid_request" }` without a client name |
| `POST /api/v1/device/token` | public | `{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code }` → `200 { token: "aiobs_u_…", expires_at, label }` once approved on `/device`, else `400 { error: "authorization_pending" \| "slow_down" \| "access_denied" \| "expired_token" \| "invalid_grant" }` (`unsupported_grant_type` / `invalid_request` for a bad body); `429` when the client IP spent its miss budget |

**Device login** (ADR-0029, brief Appendix B, `device.ts`): `device/code` draws a 43-character base64url device code
and an 8-letter user code (alphabet without I and O) and stores them through `device_create_code()` (only the
SHA-256 of the device code, the client name with control characters removed and cut to 100 characters, the version
and the requester IP); a user-code clash with an open code is retried with a new draw. The user approves the code on
the dashboard's `/device` page. `device/token` generates the token itself (`generateToken`), passes only its hash and
prefix to `device_exchange()` (which mints it for the approver with `source 'device'`, `label` = client name and a
90-day expiry, writes the `token.create` audit row and consumes the code, so it is exchanged at most once) and
returns the plaintext once. Polling within 5 s answers `slow_down`. `invalid_grant` answers spend the client IP's
miss budget (`INGEST_FAILED_AUTH_*`, the same `AuthGuard` as ingest) and are cached as bad for 30 s. Codes and tokens
are never logged. Both limiters are in memory per instance and use the trusted-proxy IP rule below.

Request handling, in order:

1. **Token** → SHA-256 hex → `lookup_ingest_token(hash)` (also touches `last_used_at`, at most once a minute).
   Missing / unknown / revoked / expired token, or one whose user no longer holds a membership → `401` with
   ``ingest token expired or revoked, run `ai-obs login` ``; the retired company (`aiobs_c_`) and team (`aiobs_t_`)
   prefixes → `401` with `company and team tokens are no longer accepted, …` without a lookup. Retention comes from
   `deployment.settings.retentionDays` (`effectiveRetentionDays`, 30–730 days). Before the lookup an `AuthGuard` answers recently
   failed token hashes with `401` for 30 s without a DB call and gives each client IP a budget for failed
   authentications only (`INGEST_FAILED_AUTH_BURST` 20, `INGEST_FAILED_AUTH_PER_MINUTE` 10); valid tokens never spend it.
   The client IP is the n-th entry from the right of `X-Forwarded-For` (`INGEST_TRUSTED_PROXY_HOPS`, default 1); without
   the header all callers share one key (SEC-9).
2. **Rate limit** per token, taken after a successful lookup and keyed by `token_id` (so random bearers cannot evict real
   buckets): in-memory token bucket, `INGEST_RATE_LIMIT_PER_MINUTE` (60) sustained,
   `INGEST_RATE_LIMIT_BURST` (20) burst → `429` + `Retry-After`. **Per instance**: N web replicas allow N × the limit.
3. **Body**: plain JSON or `Content-Encoding: gzip`. More than 1 MB (on the wire or decompressed) or more than
   500 events → `413`; other encodings → `415`; invalid JSON / gzip / envelope (`validateBatch`) → `400`.
   Invalid events are listed in `rejected`; the rest are applied.
4. **Validate server-side** (`limits.ts`), after the wire schema: counts the columns or aggregates cannot hold
   (tokens ≤ 1e10 per usage entry, requests ≤ 1e7, phases ≤ 24 h, tool counts ≤ 1e9, depth ≤ 1000, files / lines /
   rules version ≤ 2^31-1) **reject** the event with a reason such as `lines_added is out of range` (never clamped).
   Skill and MCP counts (`skills`, `mcp`; ADR-0016) are bounded at 1e6 per entry; with `hashed` project
   naming a plain skill / server / tool name is hashed here (`sha256:` + SHA-256 of `skill:<name>`, `mcp:<server>`,
   `mcp:<server>/<tool>`), so it is never stored.
   Tool keys are lower-cased and restricted to `[a-z0-9_]{1,64}` (anything else → `other`, `mcp__*` → `mcp`), agent
   types to `[A-Za-z0-9_.:-]{1,64}` (else `other`) and outcome signals to the known set, so an older collector cannot
   store paths or internal names. A turn, run or `turn_started` that started before the deployment's retention cutoff
   (`settings.retentionDays`, 00:00 UTC) or that starts or ends more than a day in the future is rejected (for `turn_started`, `started_at` counts as both).
5. **Apply** in one transaction under `withIngestContext(db, userId)`, in chunks of 25 events per savepoint
   (a batch of 500 uses about 20 subtransaction ids, DP-14), together with the events' `ingest_events` rows, so a
   duplicate `event_id` is counted in `duplicates` and changes nothing. A failing chunk is rolled back and its events
   retried one per savepoint, so an event the DB refuses is rejected (`"could not be stored"`) alone, without being
   marked as seen. Events are applied in the order session_start → turn_started → turn → run (by depth) → patches (`turn_outcome`, `turn_summary`,
   `session_title`; arrival order) → session_end.
   Ledger keys are `<user id>:<event_id>`: retries de-duplicate across one user's tokens and
   machines, and nobody can pre-claim another sender's event ids (SEC-3).

Resolution rules:

- **Attribution**: every row belongs to the token's user and is `verified` (ADR-0029); `identity.git_email` is
  ignored (old rows keep `matched` / `unverified`).
- **Ownership** (SEC-3): an existing turn, run or session can be overwritten only by its current owner (any token or
  machine of that user), or while it has no owner. Since migration 0018 the ingest role cannot even see another
  user's rows (RLS `USING user_id = app_user() OR user_id IS NULL`, `WITH CHECK user_id = app_user()`): an upsert
  that collides with one is rejected as `conflicts with data owned by another user` and not recorded as seen, while
  a patch, title or run aimed at another user's turn or session finds nothing and is parked (or stored unlinked)
  under its sender, where it is never applied to that row. Every write claims an ownerless (pre-ADR-0029,
  company-token) row for the sender (turns become `verified`). A parked patch remembers its sender
  (`pending_turn_patches.user_id`) and is applied only to an ownerless turn or one with the same owner.
- **Team** (ADR-0030, ADR-0035), resolved per session at `session_start` and stored on `agent_sessions.team_id`;
  the session's turns (and their runs and usage) take it: the admin's project → team mapping (`projects.team_id`),
  else the user's primary team, else none. `project.team` from collectors before ADR-0035 is ignored, and no
  warnings are returned. The team is pinned by the
  first `session_start` with a project: a later mapping or membership change does not move a running session, and a
  later `session_start` of the same session (a lost collector state) keeps the stored project and team, so one
  session's turns never split across teams; a `session_start` without a project keeps the session's team. Rows
  that arrive before their `session_start` get the primary team and move to the resolved team when it arrives.
- **Ids**: sessions and turns are stored as `<harness>:<collector id>` in `external_id`; runs keep their id
  and are keyed by `(turn_external_id, external_id)`. Unknown harnesses are accepted.
- **Machine** upserted by `machine.id`. **Project** upserted by key; the display name is only set on insert
  (admin renames stick). Hashed keys (`sha256:…`) never get a name; with hashed naming a
  plain key is hashed server-side (`sha256:` + hex SHA-256 of the key, which collectors must match) and its name dropped.
- **Sessions**: a `turn_started`, turn or `session_end` for an unknown session creates it; `session_start` sets
  `started_at`, project, version and team, and back-fills the project and team of turns that came first.
- **Session titles** (ADR-0026): `session_title` sets `agent_sessions.title` / `title_source` (`custom` | `ai`; the
  latest patch wins; only the session's owner, or anyone while it has none). A title for a session that has not
  arrived is **parked** in `pending_session_patches` (it never creates a session) and moved onto the session by
  `ingest_apply_pending_session_patch(session_id)` (SECURITY DEFINER) whenever a `session_start`, turn or
  `session_end` upserts it, only onto an ownerless session or one of the same sender; parked titles whose session
  never comes are dropped after 30 days by the worker's retention pass. Session writes and title patches take an
  advisory lock on the session key; `processBatch` takes every session lock of the batch first, in sorted order
  (`lockBatchSessions`), so session locks always precede turn locks and concurrent batches cannot deadlock.
  The ingest role (`app_ingest`) can write titles but not read them.
- **Live status** (ADR-0027): `agent_sessions.current_turn_started_at` (C; null = idle) and `last_seen_at`, both
  nullable and not backfilled (a row from before migration 0017 never shows as live). `turn_started` sets C to the
  greater of the stored value and `started_at`, creates an unknown session, applies a parked title, and re-opens a
  session that ended before it (`ended_at` and `end_reason` back to null; one from before `ended_at` leaves it ended).
  A `turn` clears C when C is at or before the turn's `ended_at`; `session_end` clears C (and sets `ended_at` and
  `end_reason`) only when C is at or before its time, so an older end that arrives after a newer prompt's
  `turn_started` (one backlog batch orders `turn_started` first) does not end the resumed session. `last_seen_at` is
  `greatest(stored, least(event time, now()))`, bumped by `session_start` (at), `turn_started` (`started_at`), `turn`
  (`ended_at`) and `session_end` (at); `run`, `turn_outcome`, `turn_summary` and `session_title` do not bump it. Migration
  0017 gives the ingest role (in addition to its earlier grants) SELECT on `current_turn_started_at`, `last_seen_at`
  and `ended_at` of `agent_sessions` and UPDATE on the first two; `started_at`, `title` and `end_reason` stay
  unreadable for it, so the re-open and the `end_reason` write are their own statements (`UPDATE ... WHERE ended_at <
  started_at`, `UPDATE ... SET end_reason`). The index `agent_sessions_last_seen_idx` (0018) serves the live query.
- **Runs** before their turn keep `turn_id` null and are linked (with team / user) when the turn arrives;
  children before their parent are linked when the parent arrives.
- **Run links** (ADR-0020): a run event stores `stage_index` and `flow_key` (trimmed, ≤ 128, path-like or free text →
  NULL) and **replaces** the run's incoming links in `run_links` (de-duplicated, self-links dropped). A link whose source
  run has not arrived keeps `from_run_id` NULL and is resolved when that run arrives; `turn_id` is set with the runs'
  when the turn arrives. Reads skip unresolved links.
- **Usage rows**: the turn event's `usage` is the **whole turn, sub-agents included** (as in the protocol
  fixture). It is stored as the turn's rows (`turn_id` set, `run_id` null) and summed into the turn's token
  columns; each run's usage is stored as rows with `run_id` set and `turn_id` **null**. So
  `sum(usage where turn_id = X)` is the turn total and sub-agent tokens are never counted twice, whatever the
  arrival order. A re-sent turn / run replaces its rows (no longer reported pairs are zeroed: `app_ingest` has no DELETE).
- **Patches before their turn** (ADR-0015): `turn_outcome` / `turn_summary` for a turn that has not arrived
  are **parked** in `pending_turn_patches` (no turn row is created, so nothing is counted early). When the turn
  arrives, `ingest_apply_pending_patch(turn_id)` (SECURITY DEFINER; `app_ingest` cannot read patch values or
  delete) copies the patch onto it and deletes it; patches whose turn never comes are dropped after 30 days.
  Turn and patch handling take a transaction-scoped advisory lock on the turn key, so a turn and its patch in
  concurrent batches cannot miss each other (runs take the same lock, DP-13). Each outcome patch also leaves a marker row
  `outcome-patch:<sender user id>:<turn key>` (type `marker`) in `ingest_events`, so a re-sent turn never replaces a
  patched outcome with its provisional one; a final (non-provisional) patch also writes
  `outcome-final:<sender user id>:<turn key>`, after which a provisional patch is ignored whatever the order (DP-09).
  Markers carry the sender because another user's turn is invisible to the ingest role: a stray patch for it is parked
  under the sender and never applied, and its markers must not freeze the owner's outcome. Readers check the markers of
  the user writing the turn (its owner) plus the pre-0018 form without a user part (`outcome-patch:<turn key>`). Runs before their turn never create a turn either (see above).
  Not solved: an older turn revision overwriting a newer re-send (needs a revision on the wire).
- Nothing from `ext`, and no prompts, code, diffs or paths, is stored (ADR-0008).

Library (`src/lib/ingest/`): `tokens.ts` (`generateToken()` → `{ plaintext: "aiobs_u_…", prefix, hash }` for the admin
UI, "My tokens" and the device exchange, `hashToken`, `parseBearer`), `rate-limit.ts`, `body.ts`, `handler.ts`
(`handleIngest`, `handleCollectorConfig`; DB and limiter injected), `device.ts` (`handleDeviceCode`,
`handleDeviceToken`), `process-batch.ts`, `apply-events.ts`, `resolve.ts` (`resolveTeam`, `resolveSessionTeam`),
`usage.ts`, `usage-rows.ts`, `limits.ts`.

Tests: `pnpm vitest run --project web test/ingest`. Unit tests always run (limits, rate limit and auth guard, tokens, body); the integration suites create their
own databases `ai_obs_ingest_test` and `ai_obs_ingest_device_test` (from `INGEST_TEST_DATABASE_URL`), apply all
migrations, run as `app_ingest`, drop the databases afterwards, and are skipped (reason in the suite name) when
Postgres is unreachable. They cover token expiry and the retired prefixes, the collector-config shape, the team
resolution matrix with its warnings, and the device flow end to end (`slow_down`, `access_denied`, `expired_token`,
single exchange, the open-code cap). The ingest suite also
proves patch-before-turn end to end: nothing is counted until the turn arrives, then the dashboard KPIs (both
read paths, raw and rollup) and the worker's `recomputeDay` count exactly one turn.

## Dashboard read layer

Shell, filters, queries, cost and CSV that every dashboard view builds on. Code: `src/lib/filters.ts`,
`src/lib/cost.ts`, `src/lib/csv.ts`, `src/lib/queries/*`, `src/components/*`, `src/app/api/export`.
Tests: `pnpm --filter @ai-obs/web test:shell` (or `pnpm vitest run --project web`). The query tests create
databases (`test/shell/harness.ts`): one database holds one deployment, so `prepareShellDatabase()` creates and migrates a
template database once per test process and `seedDeployment()` clones it (`CREATE DATABASE … TEMPLATE`) into one database
per fixture, each seeded with one deployment in one visibility mode; `dropShellDatabase()` drops them all. Names carry the
process id so parallel runs cannot drop each other's: `ai_obs_shell_<pid>_test` for the template and
`ai_obs_shell_<pid>_<fixture>_test` for the fixtures. `SHELL_TEST_DATABASE_URL` (name must end in `_test`) gives the base
name that replaces `ai_obs_shell` and gets the same per-pid suffixes, so no `--no-file-parallelism` is needed. The tests
skip when Postgres is unreachable. The fixture's `daily_rollups` are built by the worker's real
`recomputeDay(db, day)` (imported from `apps/worker`), and the `mixed` fixture kind has mixed-model turns.

### Using it in a view

```tsx
const user = await requireUser();
const filters = parseFilters(await searchParams, { allowUser: canSeeUsers(user) });
const data = await withDashboardContext(user, async (ctx) => ({      // one RLS transaction + price book
  options: await loadFilterOptions(ctx),
  projects: await getProjects(ctx, filters),
}));
return <><FilterBar filters={filters} options={data.options} /> … </>;
```

Import components by path (`@/components/KpiTile`); there is no barrel, so client code never pulls in
server modules. Client components take **serializable props only**: `DataTable` formats by column `kind`
(`tokens`, `cost`, `model`, `percent`, `duration`, `datetime`, `outcome`, `sparkline`, …) and charts by
`valueFormat` (`tokens | int | cost | duration | percent`), never by function. Export buttons use
`exportUrl(view, filters)`.

### Filters (`filters.ts`)

URL search params: `range` = `7d | 30d (default) | 90d | 12m | custom` (+ `from`, `to` inclusive,
YYYY-MM-DD UTC), `teamId`, `projectId`, `userId`, `harness`, `model`, `effort`. `parseFilters` never throws;
invalid values fall back to the default. `userId` is only parsed when `allowUser` is set, and queries
apply it only when `canSeeUsers(user)`. `FilterBar` only writes the URL (and drops `page`).

### Visibility and the two read paths

| Viewer | Reads | Per-user data |
|---|---|---|
| member (any mode) | tables, RLS gives own rows | own only, no user column |
| lead / admin, `full` mode | tables, RLS gives led teams / the deployment | `canSeeUsers` = true: user column and filter |
| lead / admin, `aggregates-only` | `agg_*` SQL functions (`ctx.agg`) | never selected: no `user_id`, names or e-mails in any result |

`canSeeUsers(user)` and `usesAggregateFunctions(user)` live in `queries/scope.ts`. Limits of the aggregate
path (the SQL functions are fixed): the effort filter is applied in JS (KPIs, turn list) or not at all
(`ignoredFilters` says so); the agent depth histogram is `null` (only avg / max depth exist); the KPI median
and the unfiltered counts come from a capped sample of turns (`approximate`); a project's cost needs one
`agg_usage_daily` call per project, so only the top 40 projects get a cost (`costSkipped`); user budgets of
other people are hidden (`hiddenUserBudgets`); someone else's turn detail has no phases / tools / signals
(`limited`), and `getTurnDetail(ctx, id, atMs)` needs the list row's `startedMs` to find it cheaply.

### Source selection: raw or rollups

A range of at most 35 days (`RAW_MAX_DAYS`) reads raw rows, a longer one reads `daily_rollups` (or
`agg_rollups`); so does a range that starts before `today - retentionDays` (`settings.retentionDays`, `QueryCtx.retentionDays`), because its raw rows may already be gone (DP-04). Turn counts,
outcomes and token totals agree exactly between the two (tested). Differences:

- The **median** needs raw rows. On long ranges that still start inside retention it is computed from raw turns (exact
  on the direct path, a capped sample on the aggregate path: `Kpis.medianApproximate`); past retention, or with a forced
  rollup source, `medianAvailable` is false and the views show "n/a".
- Both sources use the **same attribution** (`daily_rollups` fold, packages/db README, ADR-0015): turn counts,
  outcomes and durations belong to the turn's **primary** model × effort; tokens and ≈ cost belong to the
  **usage row's** model × effort (a Haiku sub-agent is priced as Haiku), priced per day. So KPIs, the token
  series, projects and **models × effort** agree exactly for mixed-model turns too (tested on a mixed-model
  fixture). A model used only by sub-agents shows up in models × effort with tokens and cost but 0 turns
  (success rate and durations "—"). The model filter follows the same split (usage model for tokens, primary
  model for turn counts).
- **Zero-token usage rows** (a model that was only mentioned) are dropped from usage queries and never priced (DP-10).
- **Phases, agents and the turns explorer** have no rollup form and always read raw rows (empty beyond retention).
- **Wasted spend** (`getWastedSpend`, ADR-0017) reads usage rows joined to their turns' outcome on raw ranges and the
  outcome-split columns of `daily_rollups` on long ones (`agg_wasted` / `agg_wasted_rollups`); both agree exactly
  (tested, mixed-model too). Rollup days written before the split are counted in the total but not in wasted
  (`unsplitDays`).
- **Skill impact** (`getSkillImpact`) compares cells (project × primary model) from raw turns, or success only from the
  split rollups on long ranges. **Effort suggestions** (`getEffortAdvice`) need raw turns (medians) and ignore the
  effort filter. **Runaways** (`getRunaways`) read `runaway_alerts` (`agg_runaways` on the aggregate path).
- **Skills & MCP** reads `turns.skills` / `turns.mcp` plus the turns' runs on raw ranges and `daily_skill_mcp_rollups` on
  long ones (`agg_skill_mcp` / `agg_skill_mcp_rollups` on the aggregate path); both give the same rows (tested). Effort
  is not a dimension there, so the effort filter is ignored except on the direct raw path.
- `ctx.forceSource` overrides the choice (tests, tooling).

### Cost (`cost.ts`)

`PriceBook` is loaded once per request (`createQueryContext`). It picks the `model_prices` row with the latest
`effective_from <= day` (for a day before the model's earliest row, that earliest row, DP-03: the same rule as
`estimate_cost_usd()` and `priceInEffect()`) and prices input / output / cache read / cache write per million tokens (reasoning is
part of output). Turn lists, turn headers and the turns CSV price each usage row (model × day), so a mixed-model turn is not billed entirely
at its primary model (DP-02). A model without a price gives `usd: null` ("n/a"), never `$0`; a total over several
models is `partial` (shown as `≈ $12.50+`) when some had no price. `formatCost` always prefixes "≈".

Model ids are shown as friendly names (`claude-opus-5-5` → "Opus 5.5", raw id in the `title` tooltip) by the pure parser `src/lib/model-name.ts` (ADR-0021), mostly through the `model` column kind. Filters, URL params, chart series keys and the CSV keep the raw id; an unknown id is shown verbatim.

### CSV export

`GET /api/export?view=<overview|projects|models|phases|agents|skills-mcp|turns|flows|budgets>&<filters>` (+ `group=team|project|model`
for phases, `outcome=` for turns and flows) re-runs the view's query inside `withUserDb`, so it can show no more than the
screen, streams UTF-8 CSV (BOM, CRLF, RFC 4180 quoting, formula starters neutralised) and appends an
`audit_log` row `{action: 'export', target: view, meta: {filters, rows, …}}`. Turn exports are paged by keyset (stable with ties on the start time) and capped at 50,000 rows; a capped export ends with a `TRUNCATED: only the newest N turns…` row, sends `X-Truncated: true` and records `truncated: true` in the audit meta (the row count includes the marker row). Only telemetry views are exported: the admin tables (members, teams, tokens, projects) are administration data, not telemetry, and have no CSV (BRIEF §8 covers the dashboard views); the audit log has its own export.
Costs are USD with 6 decimals and empty when unknown.

### Conventions

- Team is optional on a turn (an unmapped project of a user with no primary team has none): lists show "No team". Activity of a removed member shows as "former member" (their identity is hidden by RLS, ADR-0022).
- Tokens: `total = input + output + cacheRead + cacheWrite`; reasoning is already inside output.
- Success rate = success / (turns - unknown); the unknown share is always shown next to it (ADR-0003).
- Budget progress is month to date (UTC): token budgets count `total` tokens, cost budgets the ≈ cost.
- Days are UTC calendar days; chart days are zero-filled.
- Time zoom: every stacked-area time-series chart (`components/charts/TokensAreaChart.tsx`: Overview, project detail,
  Skills & MCP) zooms by dragging across the days to keep; dragging again narrows further, "Reset zoom" or a
  double-click shows the whole range. The zoom is client state over the rows already loaded (pure index helpers in
  `charts/zoom-range.ts`, tested in `test/views/charts-zoom.test.ts`) and is tied to the data array it was made for,
  so a filter change or navigation starts un-zoomed. The agent timeline has its own URL-backed zoom (`fromH` / `toH`).

## Dashboard views

All views follow the read-layer pattern above (`requireUser` -> `parseFilters` -> one `withDashboardContext`), take the shared
`FilterBar` filters, show the `unknown` outcome share and "≈ at API list prices" costs, and have a CSV export button
(`exportUrl`). Notes from the query layer (`ignoredFilters`, `approximate`, `costSkipped`, `limited`) are shown as small notes.
Pure page helpers live next to each page and are tested in `test/views/<view>`.

### Overview (`/overview`)

`page.tsx` runs `getKpis`, `getTokenSeries` and `getBudgetProgress` in one `withDashboardContext`. It renders KPI tiles,
budget progress bars for the current UTC month (`BudgetBars.tsx`: green, amber from 80 %, red from 100 %; own budget first),
the stacked tokens-by-model area chart (straight segments; every day carries a key for every series, 0 for idle models, `zeroFilledChartRows`, so a model that is idle on a day does not draw a ribbon across it) with a CSV link (`exportUrl('overview')`), and the outcome mix strip
(`OutcomeMix.tsx`; `unknown` is always shown). Pure helpers are in `helpers.ts` (tests: `test/views/overview`). `loading.tsx` is the skeleton.

Two more cards (brief `docs/briefs/dashboard-followups-2026-10-10.md`):

- **Ingest** (`IngestCard.tsx`, right after the KPI tiles): what the collectors delivered, deployment-wide and not filtered:
  the last event received (relative, UTC in the sub line), events in the last 24 h (by type: turns, runs, patches =
  `turn_outcome` + `turn_summary` + `session_title`, sessions = `session_start` + `turn_started` + `session_end`, other) and in the last 7 days. `getIngestStats` (`lib/queries/ingest-stats.ts`)
  reads `agg_ingest_stats()` (migration 0015, SECURITY DEFINER over `ingest_events`, which keeps 30 days) inside a
  savepoint, so a deployment without the migration shows "Ingest stats unavailable" instead of failing the page;
  `ingestSummary` / `relativeAgo` in `helpers.ts` shape the card.
- **Long or complex agent flows** (`ComplexFlows.tsx`, after "Runaway turns", only when there are rows): the flows of the
  range (`listFlows`, same read as `/flows`) with **≥ 5 steps, ≥ 20 minutes or ≥ 1M tokens** (`COMPLEX_MIN_STEPS`,
  `COMPLEX_MIN_DURATION_MS`, `COMPLEX_MIN_TOKENS` in `helpers.ts`; constants, not settings), longest first, at most 8
  (`COMPLEX_MAX_ROWS`), each linking to its detail page with the reasons it qualified; "All agent flows" keeps the filters
  (`allFlowsHref`). A note appears when the flow read hit its 20,000-run cap.

### Projects (`/projects`, `/projects/[id]`)

`/projects` (table: turns, tokens, ≈ cost, success, unknown share, 14-day sparkline, team; sorted by tokens; CSV via
`/api/export?view=projects`) and `/projects/[id]` (facts, KPI tiles, tokens over time, model x effort, phase split,
10 recent turns, link to `/turns?projectId=…`). Code: `src/app/(dashboard)/projects/**` (`helpers.ts` holds the pure
row mapping, tested in `test/views/projects`). Hashed project keys without an admin-given display name show the short
hash with the hint "name it in Admin → Projects". Unknown ids / other companies' projects (RLS) give 404.

### Models & effort (`/models`)

Table from `getModelsEffort` (a **Provider** column - Anthropic, OpenAI, Google, "—" when unknown - beside the friendly model name; tokens by kind, ≈ cost, success and unknown share, median time, **primary turns**: turns whose primary model is this one; tokens and cost include sub-agent runs, so a model used only by sub-agents shows "—" there with a footnote) plus two `HBarChart`
cards (cost and tokens by model). `?group=effort|model` switches between model × effort (default) and model only (helpers in
`models/group.ts`); the CSV export is always model × effort. Grouped by model, success / unknown shares are re-weighted by
turns (approximate) and the median is shown only for models with a single effort level. The median is "—" only when raw turns are gone (range past retention) or for a forced rollup source; on long ranges inside retention it is computed from raw turns.

### Phases (`/phases`)

100 % stacked bars of time per phase (thinking, exploring, coding, documenting, testing, validating, other), grouped by
`?group=team|project|model` (default team) from `getPhases(ctx, filters, group)`; a table with hours and share per row
(`PhaseTable`, scrolls horizontally), a CSV export (`/api/export?view=phases&group=...`), an explanation of the BRIEF §5.4
rules with the `phase_rules_version` values found in the range (one RLS-scoped `select distinct`), an empty state and
`loading.tsx`. Aggregates-only: the query itself drops per-person data and reports `ignoredFilters`, shown as a note.
Page helpers (`parseGroup`, hour/share formatting, chart rows) live in `src/app/(dashboard)/phases/helpers.ts`.

### Agents (`/agents`)

KPI tiles (sub-agent spawns with the number of agent groups and types, spawns per turn, sub-agent tokens), the **agent
timeline**, an `HBarChart` of tokens by agent group, the depth histogram (a note when the aggregate path only has avg / max
depth) and `AgentGroupsTable`: one row per agent group (spawns, tokens, token share, success, unknown share, depth) that
expands to its agent types, each row with a "flows →" link to `/flows?…&group=<group>` under the current filters
(`flowsQueryString` in `agents/agents-view.ts` drops the timeline window and paging). "Spawns per turn" is spawns / turns,
not the share of turns that used a sub-agent (no such query exists). The CSV has one row per agent type with its
`agent_group`. The former "Agent flow" card was removed (brief `docs/briefs/dashboard-followups-2026-10-10.md`): the
flows live at `/flows`, and every run drawn on the timeline links there.

- **Agent groups (ADR-0019):** `agentGroupOf(agent_type, agent_group)` in `src/lib/queries/agent-groups.ts` is the only
  grouping rule: the collector's stored group wins, else `workflow:<label>` becomes `workflow:<verb>` (first token of the
  label, trailing digits stripped) and any other type is its own group. `getAgents` merges rows per type × resolved group;
  `groupAgentRows` (`agents/agents-view.ts`) folds them into groups.
- **Agent timeline (ADR-0019):** `getAgentTimeline` (`src/lib/queries/agent-timeline.ts`) reads the turns and runs that
  overlap one UTC day window (at most 1,000 turns / 5,000 runs, flagged when cut); aggregates-only leads and admins read
  through `agg_timeline_turns` / `agg_timeline_runs`. The window is in the URL: `day=YYYY-MM-DD`, `fromH` / `toH` as
  `HH:MM` (`toH` may be `24:00`; `from` / `to` stay the filter bar's custom range). `agents/timeline-view.ts` maps it to
  `AgentGraph` props: one lane per session, ordered by project name then first turn, labelled with the project and
  harness and coloured by the project's index in the legend, so every sub-agent is drawn on its project's lane; a turn
  links to its detail page; a run is labelled with its type (`workflow:` prefix dropped) and coloured by its group, and
  links to its flow's detail page when it is a step of a flow (the page runs `buildFlows` over the window's runs and
  links, `timelineFlowInput` / `runHrefs` in `timeline-view.ts`), else to its turn (`GraphRun.href`).
  `TimelineWindowControls` steps to the previous / next day with turns; dragging on the time axis
  (`AgentGraphWithZoom`) zooms to whole minutes. The graph (`components/charts/AgentGraph.tsx`, pure layout in
  `agent-graph-layout.ts`) is a git graph over time: turns are the trunk, each run branches off its parent and merges back.
  The parent turn of every run in the window is returned even when the turn ended earlier (background workflow agents),
  and its tail is a dashed trunk. Sub-rows below the trunk are capped at six plus one shared overflow row ("+N more");
  runs too short on screen are pills. Branch colours: the page passes its groups by spawns (`groupOrder`), the top
  eight keep their colour in every window, other groups take the colours left free, and the rest are grey (no colour
  twice in one view). Ticks go down to 1 s for short turns.
  Lane sublabels are `harness · HH:MM` (start of the first turn in the window) so two sessions of one project differ. In
  aggregates-only mode `sessionId` is a per-window pseudonym from `agg_timeline_turns`. The lane gutter is sticky
  (narrower below 560 px).
- **Links and the flow card (ADR-0020):** `getAgentTimeline` also returns the window's `links` (stored `run_links`
  under RLS, or `agg_timeline_links` in aggregates-only mode; at most 10,000, flagged in `truncated.links`), passed
  through `deriveSequenceLinks` (`src/lib/queries/run-links.ts`), which adds `sequence` links on read for Agent-tool
  runs without a stored incoming link (each run follows the sibling of the same parent and turn that ended last before
  it started; overlapping siblings are not chained; of two siblings starting at the same instant only the lower id
  leads). The Agents page uses the links only to find each run's flow (above). Flow charts are drawn per flow in the
  flow sections of the turn page (`flowChart` in `flows/_helpers.ts`, ADR-0025; the turn-wide "Flow" card with one
  lane per orchestration went with the merge) with `AgentFlow` (`components/charts/AgentFlow.tsx`, pure layout in
  `agent-flow-layout.ts`): one lane per flow whose rows are its stages (`stage_index`, compacted, named by the most
  common phase; no ordinal → by agent group, else one row; an "unstaged" row for the rest; `src/lib/queries/flow-stages.ts`).
  Pills are agents coloured by group (same `groupOrder` as the timeline); arrows run from the source's end to the
  target's start (`item` solid, `sequence` dashed). Hover highlights the whole chain.

### Agent flows (`/flows`; detail on the turn page, ADR-0020 amendment, ADR-0025)

A **flow** is a set of at least two sub-agent runs of one turn, computed on read by `buildFlows`
(`src/lib/queries/flows.ts`, brief `docs/briefs/agent-flows-view.md`), never stored: one flow per Workflow-tool run
(`orchestration_id`, kind `workflow`; key = that id, or `orch-<smallest run id>` when the id is not URL-safe or looks
like a legacy / sequence key), all legacy `workflow:*` runs of a turn without an orchestration (key `workflow`,
kind `legacy-workflow`), and connected components of the remaining runs over stored and derived links (key
`seq-<smallest run id>`, kind `sequence`). Steps are ordered by stage, then start; stages come from `stage_index` or the
first-start fallback shared with the agent flow card (`src/lib/queries/flow-stages.ts`). The flow outcome is failed if
any step failed, else abandoned if any was, else success when every step succeeded, else unknown; ≈ cost sums each step
at its model's price on its UTC day; skills and MCP calls are summed over the steps (`mergeUses`).

- **List** (`getFlows`): runs of the turns that started in the range, joined to turns (`turnConds`) with `run_links`
  under RLS, or `agg_flow_runs` / `agg_flow_links` in aggregates-only mode (migration 0013; no user ids, effort filter
  ignored, no phases / skills / MCP per step). At most 20,000 runs are read (`truncated` and a note when cut). Outcome
  chips, the optional `group=<agent group>` filter (flows with at least one step of that group, `flowHasGroup`; the
  Agents page links here with it, shown as a clearable chip; not carried into the CSV, whose `group` parameter belongs to
  the phases view), 50 flows per page and the KPI tiles (`totals`: flows, steps, tokens, ≈ cost over every matching
  flow) are computed in TS. CSV: `view=flows`.
- **Detail = the turn page** (ADR-0025): `/turns/[id]?startedMs=…#flow-<key>` (`flowHref`, `flowAnchor`). The turn
  page builds every flow of the turn with `turnFlows(detail, prices)` (`buildFlows` over the turn detail's runs and
  links, so `agg_turn_runs` / `agg_turn_links` in aggregates-only mode) and renders one `FlowSection`
  (`turns/[id]/FlowSection.tsx`) per flow after the timeline: one card with "All agent flows", "Download PDF" and the
  flag button, the key facts (outcome, duration, steps, tokens, ≈ cost) and a one-lane `AgentFlow` of the flow's steps
  and links; behind a collapsed "More" (`components/More.tsx`): the other facts (`flowSectionFacts`: the flow's facts
  without project / turn / harness, which the turn's own card shows, plus the steps' skills and MCP calls,
  `usesSummary`), a steps table (stage, model, effort, offset, duration, tokens, ≈ cost, skills, MCP calls, outcome),
  time by stage and phases per step (`StackedBar100`). The turn's Facts card links to each section ("Agent flows"). The old route
  `/flows/[turnId]/[key]` looks the flow up with `getFlowDetail` (the flow by key, `/^[A-Za-z0-9_.:-]{1,128}$/`) and
  permanently redirects to that anchor (a missing or malformed flow is a 404, as before); `getFlowDetail` also serves
  the report and the flag action. Pure shaping lives in
  `src/app/(dashboard)/flows/_helpers.ts`.
- **Report / "Download PDF"** (`/report/flows/[turnId]/[key]?startedMs=…`, `reportHref`): the same lookup rendered as a
  printable page outside the app shell (`src/app/report/layout.tsx`, forced light theme, landscape `@page`, print rules
  at the end of `globals.css`): facts, the `AgentFlow` chart, a plain steps table, Skills & MCP, time by stage and
  phases per step as server-rendered 100 % bars (`barSegments`, the StackedBar100 colour rule via
  `components/chart-palette.ts`). "Download PDF" (`PrintButton`) opens the browser's print dialog (Save as PDF); `?print=1`
  opens it once after load. No PDF library.
- **Flag for later** (ADR-0024, migration 0015): a private bookmark of one flow, stored in `flow_flags` (user,
  turn id, flow key, a snapshot of the flow's name, optional note ≤ 500 chars; RLS = own rows only, so flags are never
  shared). The flow section's `FlagButton` posts to the server actions in `src/lib/flows/actions.ts` (`flagFlowAction`
  checks the flow is visible with `getFlowDetail` before inserting, `unflagFlowAction` deletes by id; both revalidate `/flows` and `/turns`).
  The turn page reads the viewer's flags of all its flows at once (`getFlowFlags`). The list page
  shows the viewer's flags in a "Flagged for later" card above the table (`listFlaggedFlows`, newest first, at most 100,
  regardless of the date range and filters; a flag whose turn is no longer visible is listed without links and can be
  removed). Queries: `src/lib/queries/flow-flags.ts`.

### Insights on existing views (ADR-0017, ADR-0018)

- **Overview:** a "Wasted ≈ cost" tile (share of ≈ cost, unclassified ≈ cost, 7-day line in `KpiTile`'s `spark`) and a
  "Runaway turns" card (`overview/RunawayList.tsx`) when there are any in range.
- **Projects / Models & effort:** "Wasted ≈" and "Wasted share" columns (`projectTableRows(…, wasted.byProject)`,
  `withWasted(rows, wasted.byModel, group)`), also in the CSV exports (`wasted_est_cost_usd`, `wasted_share`).
- **Effort suggestions** (`components/EffortSuggestions.tsx`, pure rules in `src/lib/effort-advisor.ts`) on Models &
  effort and the project page.
- **Admin → Settings:** runaway thresholds (≈ cost per turn, hours).

### Skills & MCP (`/skills-mcp`)

`getSkillsMcp` (`src/lib/queries/skills-mcp.ts`) returns skills (uses, by the model vs typed by the user, turns, distinct
users), MCP servers with their tools (calls, turns, distinct users) and calls per day; a turn and its runs count together and
a server counts each turn once. The page shows KPI tiles (skill uses, share typed by users, MCP calls), the skills table with
CSV (`/api/export?view=skills-mcp`: one row per skill, server and server × tool), a `<details>` list of servers that open into
their tools, and stacked areas of uses / calls per day (top 6 + other; `skills-mcp-view.ts`, tests in `test/views/skills-mcp`).
The users column is shown to leads and admins only. The skills table also shows success and cost Δ against comparable
turns, with a "Skill impact" detail table (pure math in `src/lib/skill-impact.ts`). Each MCP server and tool shows its
error rate (errors / calls not refused), denied calls and the latency bucket of the median and p95 (red: ≥ 10 % errors
over ≥ 20 calls); the CSV adds `errors`, `denied`, `latency_ms` and the five bucket counts. Hashed names (project naming `hashed`) are shortened to
`sha256:12345678…` (`formatUsageName`). Turn detail lists the turn's skills (typed / by the model) and MCP calls per server.

### Sessions (`/sessions`, `/sessions/[id]`, ADR-0026, ADR-0027)

A session is one harness session (`agent_sessions`; the id `claude --resume` / `codex resume` takes) with its turns
and, through them, their sub-agent runs, workflows (`orchestration_id`) and flows. Read from raw rows under RLS in
`src/lib/queries/sessions.ts` (`listSessions`, `getSessionDetail`, `getSessionLink`, `exportSessions`); no table or
aggregate function of its own. A session's span runs from its first turn (or `started_at`) to the latest of its last
turn end, last run end and `ended_at`, because workflow agents outlive their turn. Its title (`sessionTitle`) is the
harness title stored by the `session_title` patch (`/rename` title over the AI title), else the first turn summary,
else `Session <first 8 chars of the id>`.

- **List** (`/sessions`, paged, CSV view `sessions`): sessions with a filter-matching turn that started in the range
  or up to a day before it, kept when their span overlaps the range; newest first. Columns: title, project, harness,
  user (only when `canSeeUsers`), started, span, turns, runs, workflows, flows, tokens, ≈ cost, outcome mix, "open"
  when no `session_end` arrived and the last activity is under 30 minutes old.
- **Detail** (`/sessions/[id]`): header with copy buttons for the harness session id and the resume command
  (`resumeCommand`), KPI tiles, the session as a one-lane `AgentGraph` over its whole span with drag-to-zoom
  (`SessionGraph.tsx`, "Whole session" resets), turns in order with their flows (links to `/turns/<id>#flow-<key>`) and
  workflows, merged skills & MCP. A session partly cut by retention says so.
- **Links in**: the turn page's "Session" fact, the Agents timeline lane labels (only when the viewer reads raw rows,
  never on aggregate pseudonym lanes), and `?session=<uuid>` on `/turns` and `/flows` (and their CSV exports, recorded
  in the audit log). The session filter ignores the date range and the filter bar; it reads under RLS only.
- **Privacy**: in aggregates-only mode leads and admins see only their own sessions (RLS plus an explicit
  `user_id = viewer` condition); in full mode visibility follows `/turns`.

**Live status** (ADR-0027). Status comes from `sessionStatus` in `src/lib/live/status.ts` (pure, type imports only, so
client components can use it): *ended* when `ended_at` is set; *working* when `current_turn_started_at` is set and later
than the last turn end (stale after `WORKING_MAX_MS` = 2 h; the 30-minute rule never stales it, there is no heartbeat);
otherwise *idle* since the last turn end (or the session start), *stale* once the latest signal (the greatest of
`last_seen_at`, last activity, start and last turn end) is at least `IDLE_MAX_MS` = 30 min old. The collector holds the
same literals (`LIVE_IDLE_STALE_MS`, `LIVE_WORKING_STALE_MS`); each side has a test for them. Collectors older than 0.5.0
send no `turn_started`, so their sessions never show as working. The "open" badge on the list (`SESSION_OPEN_MS`,
30 min) is unchanged.

- **Active now** (top of `/sessions`, above the filter bar, `(list)/ActiveNow.tsx`): working and idle sessions, working
  first, then the most recent state change; at most 100 (`LIVE_MAX_SESSIONS`; when cut it says "Showing the 100 most
  recent."). It is not narrowed by the page filters. Candidates are sessions with `ended_at` null and `last_seen_at` in
  the last 2 h, so rows with a null `last_seen_at` (written before migration 0017) never appear. Visibility is the rule
  above: in aggregates-only mode only the viewer's own sessions (the description says so), and the User column and user
  keys only for full-mode leads and admins. Columns: Session (link), Status, For, User, Project, Harness, Turns,
  Sub-agents, Tokens, ≈ Cost, Last outcome. Empty: "No sessions running." Query: `listActiveSessions`
  (`lib/queries/sessions.ts`).
- **Live session page** (`/sessions/[id]` while the status is not `ended`; stale counts as live): a "Now" card first
  (Status badge: info = working, neutral = idle, warn = stale; ticking Elapsed; Turn: "Turn N started <UTC time>",
  "waiting for the next prompt" or "no signal: the harness may have closed without an end event"; So far: turns,
  tokens, ≈ cost), and a "now" line on the agent graph whose axis extends past the server's now by 2 % of the span
  (at least 1 s). A running turn's tokens arrive only when the turn ends. The page calls `router.refresh()` when the
  polled `rev` differs from the rendered one (`rev` = turns, runs, workflows, last activity, end, title, state and
  `current_turn_started_at`; never flows or cost). A session with no finished turn has a detail page too
  (`sessionSql` left-joins turns; its Turns card says "No finished turn yet."), but `/sessions` lists sessions only
  through turns, so such a session appears only in Active now.
- **Routes** (`src/app/api/live/sessions`, logic in `handlers.ts`): `GET /api/live/sessions`
  returns `{nowMs, ownOnly, truncated, rows}` and `GET /api/live/sessions/<uuid>` returns
  `{nowMs, status, currentTurnStartedMs, turns, runs, workflows, tokens, cost, outcomes, lastActivityMs, endedMs, title,
  rev}`. Both run under `withDashboardContext` (same RLS and visibility as the pages), are read-only and write no audit
  row. Errors are JSON with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`: 401 `unauthorized`, 403
  `forbidden`, 404 `not_found`
  (detail only: bad uuid, missing or not visible). No telemetry query runs on 401 or 403 (the session lookup still does).
- **Polling** (`components/live-poll.ts`): every 10 s (`POLL_MS`) on a `setTimeout` chain; the first fetch comes one
  interval after mount; no fetch while the tab is hidden, and on becoming visible it fetches at once if the last fetch
  is at least 10 s old. It stops for good on 401, 403 or 404 and shows a message (signed out: "Signed out. Reload the page to sign in again."; not
  visible: "This session is no longer visible."; forbidden: "Not available."). Any other failure keeps the last data,
  shows "Couldn't refresh; retrying." and retries. Elapsed timers tick every 1 s (`TICK_MS`) on the client clock,
  offset from the payload's server `nowMs`. Polling keeps the login session sliding (ADR-0027).
- `SessionRow` gained `currentTurnStartedMs`, `lastTurnEndedMs`, `lastSeenMs` (the greater of last activity and
  `last_seen_at`) and `lastOutcome` (outcome of the latest turn). CSV exports are unchanged.

### Turns explorer (`/turns`, `/turns/[id]`)

`/turns` is a paged, filterable table (`?outcome=all|success|failed|abandoned|unknown&page=`, `&session=<uuid>` for one session; started, user (only when
`canSeeUsers`), project, harness, model, effort, duration, tokens, ≈ cost, outcome, attribution, summary). `/turns/[id]?startedMs=…`
is the single detail page of a turn and its agent flows (ADR-0025), kept light to read: secondary detail sits behind
collapsed "More" toggles (`components/More.tsx`, native `<details>`). The Turn card shows the summary and key facts
(outcome with a "provisional" badge, project, model, duration, tokens, ≈ cost, sub-agent runs, links to the turn's flow
sections); its "More" holds the other facts (user, attribution, team, harness, effort, files, lines), token breakdown,
per-model usage, phases and tools, skills & MCP calls (turn and sub-agents, plus the main agent alone) and outcome
signals. Then the turn as a one-lane `AgentGraph` (`turnGraph` in `turns/_helpers.ts`: main agent as the trunk, runs as
branches, no zoom), one flow section per flow (see Agent flows) and the `RunTree` (collapsed). In aggregates-only mode someone else's turn shows only the facts that
carry no person information (`limited`). An unknown id returns a real 404: the detail pages have no `loading.tsx` (a Suspense boundary above `notFound()` would send the 200 status line first), so the list pages and their skeletons live in the `(list)` route groups of `projects/` and `turns/`.

## Admin console

Administration of the deployment (BRIEF §4, §8, §9; ADR-0028, ADR-0029). Pages in `src/app/admin/*` (sub-navigation in
`admin/layout.tsx`, tabs in `src/lib/admin/guard.ts`), the self-service token page `src/app/(dashboard)/tokens`, logic
in `src/lib/admin/*`. The header and the sidebar show the deployment name.

| Route | Who | What |
|---|---|---|
| `/admin` | admin | Counts (members, pending invitations, teams, service users, live tokens, projects), settings summary, links |
| `/admin/settings` | admin | Deployment name (the slug is fixed), individual visibility, project naming, retention (30–730 days), runaway thresholds |
| `/admin/teams` | admin | Create (name + optional slug, else derived), rename (the slug stays), change the slug only while no turn references the team (DB trigger), delete (only empty and unused; its budgets and project mappings go with it, each audited as `budget.delete` / `project.unmap` with reason `team_deleted`), add / remove members, member ↔ lead, primary team |
| `/admin/members` | admin | People with their role (last-admin rule), teams, join date; remove (`admin_remove_member`) |
| `/admin/invitations` | admin | Invite an e-mail into a team with a team role and a role (7-day expiry, e-mail names the deployment and links to `/login`; auto-accepted at sign-in); pending list; revoke. A newer invitation for the same address replaces the pending one (audited as `invitation.revoke`, reason `replaced`). Existing members are added on Teams instead |
| `/admin/service-users` | admin | Service users for CI, bots and shared machines: create (`admin_create_service_user`, name + primary team), rename, set the primary team (joins it), create tokens (lifetime 30 / 90 / 365 / none) and revoke them, disable (revokes every token and leaves all teams; the identity and its turns stay) |
| `/admin/tokens` | admin | **Every token** of every user, people and service users: name, label, source (device login / manual), owner, created, expiry, last use, revoke |
| `/admin/projects` | admin | Key, display name, team mapping (labelled "overrides the repository's dot file", ADR-0030 R1), turns in the last 30 days (`agg_turns_by_project`) |
| `/admin/budgets` | admin (edit), lead (read) | Monthly token / ≈ cost budgets per team or user with month-to-date progress (`getBudgetProgress`); always allowed. In aggregates-only mode alert mails for a user budget go only to that user |
| `/admin/model-prices` | admin | Model prices (USD per million tokens from a date): add, replace (same model + date), delete, all audited; `ensureDefaultModelPrices` keeps seeding missing defaults at every migration, so a deleted default (marked in the confirm and the result message) comes back at the next deploy; edit a default instead to change it for good (edits are never overwritten) |
| `/admin/audit` | admin | Paged audit log; `GET /admin/audit/export.csv` (newest 10,000, writes its own `export` audit row) |
| `/tokens` | everyone | **My tokens**: how to run `ai-obs login`, the device logins (by computer name, with expiry and last use), manual tokens with a lifetime of 30 / 90 (default) / 365 days or none, revoke |
| `/device` | everyone | Approve or deny a collector login (see Authentication) |

Leads reach only `/admin/budgets`; members are sent to `/overview`. The main sidebar (`components/nav.ts`) shows "My
tokens" (`/tokens`) to everyone, "Admin" to admins and "Budgets" (`/admin/budgets`) to team leads.

### How an operation runs

- Core functions `fn(tx, actor, input)` in `src/lib/admin/{deployment,teams,members,invitations,tokens,service-users,
  model-prices,projects,budgets}.ts` validate input (zod), check the pure rules in `permissions.ts`, write, and append
  an `audit_log` row (`settings.update`, `deployment.rename`, `team.*`, `user.*`, `invitation.*`, `token.*`,
  `service_user.*`, `model_price.*`, `project.*`, `budget.*`). They throw `AdminError` for user-facing refusals.
- Server actions (`src/lib/admin/actions/*`, `'use server'`) gate with `requireAdmin()` (or `requireUser()` for the
  own-token actions, whose owner rules live in the core), then run the core inside `withUserDb(user, tx => …)` via
  `runAdmin()` (`run.ts`), so RLS applies as a second check. Postgres errors become generic messages (`errors.ts`);
  team writes run in a savepoint so a unique-slug or slug-locked error becomes a readable message.
- Forms are `<form action>` + `useActionState` (`admin/_components/ActionForm.tsx`) and work without JavaScript.
  Destructive actions use a two-step `<details>` confirm (`Confirm.tsx`), no `window.confirm`.
- `test/admin/forms.test.ts` guards that the company-era machinery (company-bound forms, the switcher, the super
  console, plans, `dbFor('platform')`) does not come back.

### Tokens

`generateToken()` / `hashToken()` from `src/lib/ingest/tokens.ts`; only the hash and the display prefix are stored.
Every token belongs to one user (ADR-0029 T1), prefix `aiobs_u_`. **Device** tokens are minted by `device_exchange` after
an approval on `/device` (90 days, label = computer name). **Manual** tokens are created by their owner on `/tokens`, or
by an admin for a service user, with a lifetime of 30, 90 (default), 365 days or none (`expires_at` null). Admins never
create a person's token (T8). The plaintext and the command `npx ai-obs-cli login --server <APP_URL> --token
<token>` are returned once in the action state and never written anywhere. Users see and revoke their own tokens, admins
every token (RLS); the tables mark tokens that expire within 14 days (the collector's nudge window). Audit rows carry the
prefix, never the secret. Revocation is one-way (a DB trigger).

### Removing a member

`removeMember` (members page) calls the SQL function `admin_remove_member`, in one transaction: it revokes the member's
tokens (`token.revoke` audit rows with `reason: 'member removed'`), ends their dashboard sessions and deletes the
membership (their team memberships and per-user budgets go with it). Their identity and **recorded activity stay**:
turns, runs, usage, machines and runaway alerts render as "former member" (ADR-0012 amendment). They can come back only
through a new invitation. You cannot remove yourself or the last admin. Service users are disabled on their own page
instead.

### Tests

`pnpm vitest run --project web test/admin`: pure tests (`pure.test.ts`: permissions and tabs, token lifetimes and
states, input parsing incl. the 30–730 retention bounds and team slugs, the invitation e-mail, audit helpers), source
guards (`forms.test.ts`), and an integration test against its own database (`ADMIN_TEST_DATABASE_URL`, default
`ai_obs_admin_test`, name must end in `_test`, skipped without Postgres) covering settings and the deployment name,
teams and slug locking, team memberships, the last-admin rule, invitations, own tokens with lifetimes, service users and
their tokens and disabling, member removal, projects, budgets (leads read their teams only), model prices, the audit log
and counts, and that members (and a forged admin claim) are refused by the guard and by RLS.
