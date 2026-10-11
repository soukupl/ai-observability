# @ai-obs/web

## Authentication

Dashboard login per [ADR-0013](../../docs/adr/0013-dashboard-authentication.md): magic link e-mail and
Google / GitHub OAuth, no passwords. Code: `src/lib/auth/*`, routes in `src/app/api/auth/*`, pages in
`src/app/(auth)/*`, route protection in `src/proxy.ts`.

### Flows

| Step | Route |
|---|---|
| Request a magic link (form POST, origin-checked, rate-limited 5 per e-mail and 20 per IP per 15 min, in memory) | `POST /api/auth/magic` → `/login/sent` |
| E-mailed link (single use, 15 min; only the SHA-256 of the token is stored in `magic_links`). GET never consumes it (mail scanners prefetch links): it redirects to a confirm page whose "Continue to sign in" button POSTs back; only that same-origin POST verifies + consumes | `GET /api/auth/magic/<token>[?next=/path]` → `/login/magic/<token>` → `POST /api/auth/magic/<token>` |
| OAuth (state + PKCE for Google in a signed httpOnly cookie, 10 min) | `GET /api/auth/<google\|github>/start[?next=]` → `/callback` |
| Sign-up step (join a listed invitation, or solo sign-up), behind a signed 30-min cookie. The page lists every pending invitation (company, who invited, team, role) with one "Join <company>" button each, and below it the solo-workspace form. The POST sends the picked invitation id | `/signup` → `POST /api/auth/signup` |
| Join an invitation while signed in (existing account, the e-mail links to `/login?next=/invitations`): the page lists `auth_pending_invitations(user.email)` with a "Join <company>" button each | `/invitations` → `acceptInvitationForCurrentUser` server action |
| Switch company (header switcher, shown with two or more companies) | `switchCompany` server action |
| Logout (also the `logout` server action, `/logout` page) | `POST /api/auth/logout` |

After a verified e-mail (magic link, or a provider e-mail that the provider marks verified), the
provisioning rules (`src/lib/auth/provisioning.ts`, pure and unit-tested) decide:

1. A linked OAuth account (`auth_accounts`) or an existing e-mail (a **user** is one identity that can hold memberships in
   several companies) → log in, into the company the user was last active in (`company_memberships.last_active_at`).
   Signing up with an existing e-mail is therefore a login. An identity whose companies are all suspended gets an
   invitations-only sign-up step when it has pending invitations, and is refused (`suspended`) otherwise.
2. New e-mail listed in `SUPER_ADMIN_EMAILS` → `auth_ensure_super_admin` (company-less platform admin;
   this wins over a pending invitation, because super admins cannot be company members).
3. New e-mail, or an identity with no membership at all → `/signup`. A pending invitation is **never accepted on login** (SEC-1): the page lists them
   (`auth_pending_invitations`: company plus inviter) and the user picks one (`auth_accept_invitation(email, name,
   invitation_id)` accepts exactly that row: right e-mail, pending, unexpired, active company with room under its
   plan member limit), which adds a membership (and the team membership), or creates a workspace of their own. For an existing identity the
   step works on the identity's own e-mail, not on a differing provider e-mail.
   Exception: a super admin (DB flag set) with no membership whose e-mail was removed from `SUPER_ADMIN_EMAILS` is
   refused (`no-company`), since a super admin can neither accept an invitation nor create a workspace.
4. Solo sign-up → `auth_create_solo_company` (Free plan, one team, the user is admin + lead).

OAuth logins are linked to the user in `auth_accounts` (by verified e-mail); later logins use the
link even if the provider e-mail changes. All of this runs as `app_web` through the `auth_*`
`SECURITY DEFINER` functions (no RLS context exists before login).

### Sessions

- Cookie `ai_obs_session`: 256-bit random id, `HttpOnly`, `SameSite=Lax`, `Secure` when `APP_URL` is
  https, `Max-Age` 30 days. `auth_sessions` stores only its SHA-256 and the **active company**
  (`active_company_id`): validated on every request against the user's memberships (a removed membership or a suspended
  company falls back to the next active one, else the session is dead). `switchCompany` sets it (the SQL checks membership
  and company status), writes `auth.company_switch` with empty meta in the destination company only, and redirects to
  `/overview`. Switching to the company that is already active is a no-op (no audit row). The active company is shared by every tab of the session.
- Sliding expiry: the DB expiry moves to now + 30 days at most once an hour (`getCurrentUser()`),
  and `proxy.ts` re-sets the cookie's `Max-Age` on page loads.
- Redirects and e-mailed links are built from `APP_URL`; `next` accepts only same-site relative paths
  (`safeNext()`), so there are no open redirects.
- State-changing POSTs check `Origin` (or `Referer` / `Sec-Fetch-Site`) against `APP_URL`; that includes the
  magic-link confirm POST (cross-site or origin-less → 403, token untouched). The confirm page sets
  `Referrer-Policy: same-origin` so the token in its URL never leaves in a `Referer`.
- `audit_log` gets `auth.login`, `auth.logout`, `auth.signup`, `auth.invitation_accepted` (meta: login
  method only) and `auth.company_switch` (only in the destination company, empty meta, so no tenant learns another's id). Super-admin rows are platform-level (`company_id` null, written via `app_platform`).

### Using it in pages and handlers (`src/lib/auth/session.ts`)

```ts
const user = await requireUser();        // CompanyUser; no session → /login, super admin → /super
const admin = await requireAdmin();      // company admin, else → /overview
const root = await requireSuperAdmin();  // platform super admin, else → /overview
const maybe = await getCurrentUser();    // CurrentUser | null, cached per request (React cache())
await withUserDb(user, (tx) => …);       // from '@/lib/db' or '@/lib/auth/rls': RLS context as app_web
<form action={logout}>…</form>           // server action
```

`CurrentUser` carries the identity, the **active** company (`companyId`, `company`, `companyRole`, `teams`, `primaryTeamId`)
and `memberships: MembershipSummary[]` (every membership in an active company, last used first, which feeds the switcher).
`companyId` and `company` are `null` only for super admins; `requireUser()` / `requireAdmin()` return `CompanyUser`,
where both are non-null. The RLS role is the company role in the active company (`admin` | `member`); lead rights come
from `team_memberships` in the DB. Super admins hold no membership and have no company context — the console uses
`dbFor('platform')`.

`src/proxy.ts` sends requests without a session cookie to `/login?next=…` (API calls get 401).
Public: `/`, `/login*`, `/signup`, `/logout`, `/invite*`, `/api/auth/*`, `/api/v1/ingest`,
`/api/v1/collector-config`. The proxy only checks that the cookie exists; pages must still call
`requireUser()` etc.

### Environment

`APP_URL`, `SESSION_SECRET` (signs the sign-up / OAuth cookies; required in production; a missing or placeholder
value in production shows `/login?error=config` with a clear message instead of a 500, and the cause is logged once),
`SUPER_ADMIN_EMAILS` (the source of truth for super admins: the DB flag alone is not enough, and removing an e-mail
revokes the super admin at once, sessions included, because the list is checked on login and on every request;
re-listing it restores access), `TRUSTED_PROXY_HOPS` (default 1: how many proxies append to `X-Forwarded-For`, the
client IP is the n-th entry from the right; 0 = use `X-Real-IP` only; without a proxy in front the headers are
client-controlled and only the per-e-mail limit protects `/api/auth/magic`), `SMTP_*` (Mailpit in dev),
`GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET` (buttons appear only when set). OAuth callback URLs:
`${APP_URL}/api/auth/google/callback`, `${APP_URL}/api/auth/github/callback`.

### Tests

`pnpm vitest run --project web` runs `test/auth/*`: token / cookie / origin / rate-limit / route
helpers, the provisioning rules, the scanner-safe link endpoint (GET does not consume; cross-origin POST is
refused; same-origin POST logs in once), and the full magic-link flow (invitation, solo sign-up, existing
user, a user in several companies and the company switch, super admin, suspended company, logout, OAuth linking, the look-alike-invitation attack of SEC-1, SUPER_ADMIN_EMAILS revocation, the placeholder-secret redirect) against real Postgres in its own
`ai_obs_auth_test` database, which is created and dropped by the test (skipped without Postgres).

## Ingest API

Collector-facing endpoints (BRIEF §6, ADR-0005/0007/0011). Route modules in `src/app/api/v1/{ingest,collector-config}/route.ts`
are thin; the logic lives in `src/lib/ingest/` and runs as the DB role `app_ingest` (`dbFor('ingest')`).

| Endpoint | Auth | Response |
|---|---|---|
| `POST /api/v1/ingest` | `Authorization: Bearer aiobs_u_…` (user) or `aiobs_c_…` (company) | `200 { accepted, duplicates, rejected: [{ event_id, reason }] }` |
| `GET /api/v1/collector-config` | same | `{ project_naming: "plain" \| "hashed", min_collector_version, project_salt, company: { name, slug }, user: { email } \| null }` (`MIN_COLLECTOR_VERSION`, default `0.0.0`; `project_salt` is the company's stable 64-hex secret the collector HMACs hashed project keys with, ADR-0008; `company` / `user` label the token for the collector, `user` is null for a company token; cached privately for 300 s) |

Request handling, in order:

1. **Token** → SHA-256 hex → `lookup_ingest_token(hash)` (also touches `last_used_at`, at most once a minute).
   Missing / unknown / revoked / wrong-prefix token → `401`; suspended company → `403`. A user token whose user no longer has a membership in the token's company does not resolve (→ `401`). Before the lookup an `AuthGuard` answers recently
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
   Skill and MCP counts (`skills`, `mcp`; ADR-0016) are bounded at 1e6 per entry; in a company with `hashed` project
   naming a plain skill / server / tool name is hashed here (`sha256:` + SHA-256 of `skill:<name>`, `mcp:<server>`,
   `mcp:<server>/<tool>`), so it is never stored.
   Tool keys are lower-cased and restricted to `[a-z0-9_]{1,64}` (anything else → `other`, `mcp__*` → `mcp`), agent
   types to `[A-Za-z0-9_.:-]{1,64}` (else `other`) and outcome signals to the known set, so an older collector cannot
   store paths or internal names. A turn or run that started before the company's retention cutoff (plan maximum
   applied to `settings.retentionDays`, 00:00 UTC) or that starts or ends more than a day in the future is rejected.
5. **Apply** in one transaction under `withIngestContext(db, companyId)`, in chunks of 25 events per savepoint
   (a batch of 500 uses about 20 subtransaction ids, DP-14), together with the events' `ingest_events` rows, so a
   duplicate `event_id` is counted in `duplicates` and changes nothing. A failing chunk is rolled back and its events
   retried one per savepoint, so an event the DB refuses is rejected (`"could not be stored"`) alone, without being
   marked as seen. Events are applied in the order session_start → turn → run (by depth) → patches (arrival order) → session_end.
   Ledger keys are `<user id, else token:<token id>>:<event_id>`: retries de-duplicate across one user's tokens and
   machines, and nobody can pre-claim another sender's event ids (SEC-3).

Resolution rules:

- **Attribution** (per batch): user token → token user, `verified`; company token + `identity.git_email` that
  `ingest_match_user_by_email(email, company)` finds, i.e. a member of the token's company → that user,
  `matched`; otherwise `unverified`, `user_id` null (SEC-10).
- **Ownership** (SEC-3): an existing turn, run or session can be overwritten only by its current owner (any token or
  machine of that user), or while it has no owner; anything else is rejected as `conflicts with data owned by another
  user` and not recorded as seen. This includes unverified senders, and a turn cannot take over runs filed by another
  user. A parked patch remembers its sender (`pending_turn_patches.user_id`) and is applied only to an ownerless turn
  or one with the same owner.
- **Team** (per turn): project → team mapping, else the primary team of the resolved user in that company, else none (`team_id` is null).
- **Ids**: sessions and turns are stored as `<harness>:<collector id>` in `external_id`; runs keep their id
  and are keyed by `(turn_external_id, external_id)`. Unknown harnesses are accepted.
- **Machine** upserted by `machine.id`. **Project** upserted by key; the display name is only set on insert
  (admin renames stick). Hashed keys (`sha256:…`) never get a name; in a company with hashed naming a
  plain key is hashed server-side (`sha256:` + hex SHA-256 of the key, which collectors must match) and its name dropped.
- **Sessions**: a turn or `session_end` for an unknown session creates it; `session_start` sets
  `started_at`, project, version, and back-fills the project (and mapped team) of turns that came first.
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
  `outcome-patch:<turn key>` (type `marker`) in `ingest_events`, so a re-sent turn never replaces a patched
  outcome with its provisional one; a final (non-provisional) patch also writes `outcome-final:<turn key>`, after which
  a provisional patch is ignored whatever the order (DP-09). Runs before their turn never create a turn either (see above).
  Not solved: an older turn revision overwriting a newer re-send (needs a revision on the wire).
- Nothing from `ext`, and no prompts, code, diffs or paths, is stored (ADR-0008).

Library (`src/lib/ingest/`): `tokens.ts` (`generateToken('user' | 'company')` → `{ plaintext, prefix, hash }` for the admin
UI, `hashToken`, `parseBearer`), `rate-limit.ts`, `body.ts`, `handler.ts` (`handleIngest`,
`handleCollectorConfig`; DB and limiter injected), `process-batch.ts`, `apply-events.ts`, `resolve.ts`,
`usage.ts`, `usage-rows.ts`, `limits.ts`.

Tests: `pnpm vitest run --project web test/ingest`. Unit tests always run (limits, rate limit and auth guard, tokens, body); the integration suite creates its
own database `ai_obs_ingest_test` (`INGEST_TEST_DATABASE_URL`), applies all migrations, runs as `app_ingest`,
drops the database afterwards, and is skipped (reason in the suite name) when Postgres is unreachable. It also
proves patch-before-turn end to end: nothing is counted until the turn arrives, then the dashboard KPIs (both
read paths, raw and rollup) and the worker's `recomputeDay` count exactly one turn.

## Dashboard read layer

Shell, filters, queries, cost and CSV that every dashboard view builds on. Code: `src/lib/filters.ts`,
`src/lib/cost.ts`, `src/lib/csv.ts`, `src/lib/queries/*`, `src/components/*`, `src/app/api/export`.
Tests: `pnpm --filter @ai-obs/web test:shell` (or `pnpm vitest run --project web`). The query tests create
their own database `ai_obs_shell_<pid>_test`, one per test process so parallel runs cannot drop each other's (override with `SHELL_TEST_DATABASE_URL`, name must end in `_test`; a fixed override is shared by every shell test file, so run those with `--no-file-parallelism`)
and skip when Postgres is unreachable. The fixture's `daily_rollups` are built by the worker's real
`recomputeDay` (imported from `apps/worker`), and two of the four companies have mixed-model turns.

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
| lead / admin, `full` mode | tables, RLS gives led teams / company | `canSeeUsers` = true: user column and filter |
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
`agg_rollups`); so does a range that starts before `today - retentionDays` (the viewer's plan maximum applied to
`settings.retentionDays`, `QueryCtx.retentionDays`), because its raw rows may already be gone (DP-04). Turn counts,
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

- Team is optional on a turn (a company-token turn from a non-member has none): lists show "No team". Activity of a removed member shows as "former member" (their identity is hidden by RLS, ADR-0022).
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

- **Ingest** (`IngestCard.tsx`, right after the KPI tiles): what the collectors delivered, company-wide and not filtered:
  the last event received (relative, UTC in the sub line), events in the last 24 h (by type: turns, runs, patches =
  `turn_outcome` + `turn_summary`, sessions, other) and in the last 7 days. `getIngestStats` (`lib/queries/ingest-stats.ts`)
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
  (`turns/[id]/FlowSection.tsx`) per flow after the timeline: a facts card (`flowSectionFacts`: the flow's facts without
  project / turn / harness, which the turn's own card shows, plus the steps' skills and MCP calls, `usesSummary`) with
  "All agent flows", "Download PDF" and the flag button, a one-lane `AgentFlow` of the flow's steps and links, a steps
  table (stage, model, effort, offset, duration, tokens, ≈ cost, skills, MCP calls, outcome), time by stage and phases
  per step (`StackedBar100`). The turn's Facts card links to each section ("Agent flows"). The old route
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
- **Flag for later** (ADR-0024, migration 0015): a private bookmark of one flow, stored in `flow_flags` (company, user,
  turn id, flow key, a snapshot of the flow's name, optional note ≤ 500 chars; RLS = own rows only, so flags are never
  shared). The flow section's `FlagButton` posts to the server actions in `src/lib/flows/actions.ts` (`flagFlowAction`
  checks the flow is visible with `getFlowDetail` before inserting, `unflagFlowAction` deletes by id; both are bound to
  the company the page was rendered for via `_companyId`, like the admin forms, and revalidate `/flows` and `/turns`).
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
over ≥ 20 calls); the CSV adds `errors`, `denied`, `latency_ms` and the five bucket counts. Hashed names (company project-naming mode) are shortened to
`sha256:12345678…` (`formatUsageName`). Turn detail lists the turn's skills (typed / by the model) and MCP calls per server.

### Turns explorer (`/turns`, `/turns/[id]`)

`/turns` is a paged, filterable table (`?outcome=all|success|failed|abandoned|unknown&page=`; started, user (only when
`canSeeUsers`), project, harness, model, effort, duration, tokens, ≈ cost, outcome, attribution, summary). `/turns/[id]?startedMs=…`
is the single detail page of a turn and its agent flows (ADR-0025): facts (with a "provisional" badge, the number of
sub-agent runs and links to the turn's flow sections), token breakdown, per-model usage, phases, tools, skills & MCP
calls (turn and sub-agents, plus the main agent alone; always shown), outcome signals, summary, the turn as a one-lane
`AgentGraph` (`turnGraph` in `turns/_helpers.ts`: main agent as the trunk, runs as branches, no zoom), one flow section
per flow (see Agent flows) and the `RunTree`. In aggregates-only mode someone else's turn shows only the facts that
carry no person information (`limited`). An unknown id returns a real 404: the detail pages have no `loading.tsx` (a Suspense boundary above `notFound()` would send the 200 status line first), so the list pages and their skeletons live in the `(list)` route groups of `projects/` and `turns/`.

## Admin console

Company administration (BRIEF §4, §8, §9, §10). Pages in `src/app/admin/*` (sub-navigation in
`admin/layout.tsx`), the self-service token page `src/app/(dashboard)/tokens`, logic in `src/lib/admin/*`.

| Route | Who | What |
|---|---|---|
| `/admin` | admin | Company name, plan and limits with current usage (members = memberships + pending invitations, teams), settings summary; an amber notice when usage is over the plan (`planOverages`; existing usage is grandfathered after a downgrade, only new growth is refused) |
| `/admin/teams` | admin | Create / rename / delete (only empty: no members, no active tokens, no recorded turns), add / remove members, member ↔ lead, primary team |
| `/admin/members` | admin | Company role, "Last active here", remove from company, invitations (create with team + roles, 7-day expiry, e-mailed via `src/lib/mail.ts` with a link to `/login?next=/invitations`; list pending; revoke) |
| `/admin/tokens` | admin, lead | **Company tokens**: list (RLS: admins see every token of the company, members' user tokens included; leads the company tokens), creation (admins and leads), revoke |
| `/tokens` | everyone | **My tokens**: own user tokens in the active company (the page names the company), create, revoke |
| `/admin/projects` | admin | Key, display name, team mapping, turns in the last 30 days (`agg_turns_by_project`) |
| `/admin/settings` | admin | Individual visibility, project naming, retention (30 … plan max) |
| `/admin/budgets` | admin (edit), lead (read) | Monthly token / ≈ cost budgets per team or user with month-to-date progress (`getBudgetProgress`); not on Free. In aggregates-only mode alert mails for a user budget go only to that user (admins and leads are not mailed; the page says so) |
| `/admin/audit` | admin | Paged audit log; `GET /admin/audit/export.csv` (newest 10,000, writes its own `export` audit row) |

Leads only see the Tokens and Budgets tabs; members are sent to `/overview`. The main sidebar (`components/nav.ts`)
shows "My tokens" (`/tokens`) to everyone, "Admin" to admins and "Company tokens" (`/admin/tokens`) to team leads. The header
company switcher appears with two or more companies, and an "Invitations (n)" link with pending invitations for the signed-in e-mail.

### How an operation runs

- Core functions `fn(tx, actor, input)` in `src/lib/admin/{teams,members,invitations,tokens,projects,company,budgets}.ts`
  validate input (zod), check the pure rules in `permissions.ts` / `plans.ts`, write, and append an
  `audit_log` row (`team.*`, `user.*`, `invitation.*`, `token.*`, `project.*`, `settings.update`,
  `company.rename`, `budget.*`). They throw `AdminError` for user-facing refusals.
- Server actions (`src/lib/admin/actions/*`, `'use server'`) gate with `requireAdmin()` (or `requireUser()`
  for token actions, whose lead / owner rules live in the core), then run the core inside
  `withUserDb(user, tx => …)` via `runAdmin()` (`run.ts`), so RLS applies as a second check. Postgres
  errors become generic messages (`errors.ts`).
- Every mutating admin and token form is **bound to the company it was rendered for** (hidden `_companyId`, rendered by
  `CompanyField`, checked in `runAdmin` against the session's active company). The active company is session-wide, so a
  form left open in another tab after a switch is refused with "The active company changed in another tab. Reload this page."
  The company comes from a `CompanyScopeProvider` that **each page** renders from its own `requireUser()` /
  `requireAdmin…()`, never from `admin/layout.tsx`: a shared layout is not re-rendered on client navigation between
  `/admin/*` tabs, so it would keep an earlier page's company (`test/admin/forms.test.ts` guards this).
- Forms are `<form action>` + `useActionState` (`admin/_components/ActionForm.tsx`) and work without
  JavaScript. Destructive actions use a two-step `<details>` confirm (`Confirm.tsx`), no `window.confirm`.
- Plan limits come from `PLAN_LIMITS` in `@ai-obs/db` (re-exported by `src/lib/admin/plans.ts`). Limit checks
  lock the company row (`select … for update`) so concurrent requests cannot overshoot.

### Tokens

`generateToken()` / `hashToken()` from `src/lib/ingest/tokens.ts`; only the hash and the display prefix
are stored. Kinds: **company** tokens (`aiobs_c_`; created by admins and leads, match users by git e-mail among the
company's members) and **user** tokens (`aiobs_u_`; created by anyone, own only, in the active company). The plaintext,
the command `npx ai-obs init --token <token> --endpoint <APP_URL>` and, for
company tokens, a downloadable JSON for MDM / dotfiles rollout (`{endpoint, token, company, install}`, where `company` is the slug) are
returned once in the action state and never written anywhere. The collector creates its `machine_id`
on `init`, so the rollout runs `install` on each machine. Audit rows carry the prefix, never the secret.

### Removing a member

`removeMember` (members page, "Remove from company") calls the SQL function `admin_remove_member`, in one transaction: it
revokes the member's user tokens **and the company tokens they created** in that company (`token.revoke` audit rows with
`reason: 'member removed from company'`), clears the active company of their sessions, and deletes their team memberships,
per-user budgets and the membership (SEC-4). Their identity, their other companies and their **recorded activity stay**: turns,
runs, usage, machines and runaway alerts remain in this company and render as "former member" (ADR-0012 amendment). The
confirmation lists the company tokens the person created that are still active, so CI can be re-keyed. You cannot remove
yourself or the last admin.

Demoting a person (admin to member, lead to member, removal from a team) revokes the company tokens they created once they
are neither an admin nor a lead of any team in the company (`revokeStrandedCompanyTokens`); the success message and the audit
log name the revoked tokens. Revocation is one-way (a DB trigger).

### Tests

`pnpm vitest run --project web test/admin`: pure tests for plan limits, token-kind permissions, input
parsing, e-mail and audit helpers; an integration test against its own database `ai_obs_admin_test`
(override `ADMIN_TEST_DATABASE_URL`, name must end in `_test`, skipped without Postgres) covering teams,
invitations (also for an existing account), company / user token create / revoke, settings, projects, budgets, member removal and demotion revocations, company-bound forms, audit rows, and that
members (and a forged admin claim) are refused by the guard and by RLS.

## Super admin

Platform console for super admins (`is_super_admin`, no company; BRIEF §4 and §10). Code: `src/app/super/**` (pages, forms),
`src/lib/platform/**` (data layer, server actions, plan definitions), tests in `test/super`.

| Route | What |
|---|---|
| `/super` | Companies table (name, slug, plan, status, created, members and teams from `platform_company_counts()`, admin e-mails with "last active"; sortable, CSV via `/super/export`), search, "Create company" form, recent platform actions |
| `/super/companies/<id>` | Plan and limits, change plan, suspend / reactivate (with an optional reason), admins and their invitations, "Invite admin" (also re-sends a lost invitation), audit of platform actions for the company |
| `/super/plans` | Read-only plan table, built from `PLAN_LIMITS` in `@ai-obs/db` (the one source that is enforced: invites, accepting an invitation, creating teams, retention, budgets) plus display names; a test fails if they disagree. Limits are placeholders (BRIEF §10) |

- **Access.** `requireSuperAdminOr404()` (`lib/platform/guard.ts`) runs in the layout, every page, the export route and every
  server action. A signed-in non-super-admin gets **404**; an anonymous request is redirected to `/login` by `proxy.ts`.
  (`requireSuperAdmin()` in `lib/auth/session.ts` redirects instead, so the console does not use it.)
- **Database.** Everything uses `dbFor('platform')` (role `app_platform`), never `withUserDb`. That role can read and write
  `companies`, read admin contacts (memberships with the admin role, with the identity columns), insert admin `invitations` and `audit_log`, and call
  `platform_company_counts()` and `platform_invitee_status()`. Its `audit_log` access is limited to `platform.%` actions (or rows without a company), so it can neither read a tenant's audit trail nor forge an `export` row (SEC-6). It has no grants on telemetry, teams or tokens, so even a bug here cannot read a turn
  (`select … from turns` fails with `42501`; tested). The console therefore shows no member names, no teams and no telemetry.
- **Create company.** One transaction inserts the company, an admin invitation (14 days, no team) and the audit row, then the
  invitation e-mail goes out (`lib/platform/mail.ts`: a link to `${APP_URL}/login`, no secret). The invitee signs in with that
  address (magic link, Google or GitHub), sees the invitation on `/signup` and joins explicitly (`auth_accept_invitation`), which makes them the company admin. If SMTP fails, the company
  and invitation stay and the page says so; "Invite admin" sends it again. Refused: duplicate slug, a super admin's e-mail (`platform_invitee_status()`, SEC-7) or one in `SUPER_ADMIN_EMAILS`; an
  existing user of another company may become the first admin of a new one and accepts at `/invitations`. "Invite admin" says "already an admin" for a current admin of the company; for an existing member
  the invitation is not offered, and a company admin can promote them instead. An empty slug is derived from the name.
- **Change plan.** A downgrade is applied, with a warning listing what is over the new plan (`planOverages`): existing members, teams and invitations are kept, only growth is refused.
- **Suspend.** Sets `companies.status = 'suspended'`: ingest answers 403 and sign-in is refused. Data is kept; reactivating restores access.
- **Audit.** Each change inserts an `audit_log` row in the same transaction, with `company_id` of the target and the super admin as
  actor: `platform.company_created`, `platform.plan_changed` (meta `from`, `to`), `platform.company_suspended` (meta `reason`),
  `platform.company_unsuspended`, `platform.admin_invited`. Policy: only `platform.%` rows are visible to the platform role.
- **Tests.** `pnpm vitest run --project web test/super`: pure checks (plans, validation, e-mail) and an integration test in its
  own `ai_obs_super_test` database (created and dropped by the test; skipped without Postgres).
