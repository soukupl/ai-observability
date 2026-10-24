# @ai-obs/worker

Background jobs: daily rollups, budget e-mails, runaway alerts and retention. One long-running process (the `worker`
service in docker compose). Design: [BRIEF §9, §11](../../BRIEF.md), [ADR-0012](../../docs/adr/0012-retention-and-rollups.md),
[ADR-0014](../../docs/adr/0014-db-roles-and-connections.md), [ADR-0018](../../docs/adr/0018-runaway-alerts.md),
[ADR-0028](../../docs/adr/0028-one-deployment-one-company.md).

One deployment is one company (ADR-0028): there is no company loop and there are no plan caps. Every job reads the one
`deployment` row for its name (named in every e-mail) and its settings: `retentionDays` (retention and the rollup
window), `individualVisibility` (mail recipients) and `runawayCostUsd` / `runawayHours` (runaway thresholds).

It connects with `dbFor('worker')` (role `app_worker`), bounded by grants. It can read telemetry, users, memberships,
budgets and the deployment, and write only `daily_rollups` / `daily_skill_mcp_rollups`, `runaway_alerts`, the
`budgets.notified_*` columns, `device_codes.status`, deletes of expired raw rows, stale pending patches, expired auth
sessions / magic links / device codes, and audit entries. It cannot read tokens or auth secrets.

## Jobs

| Job | Every | What |
|---|---|---|
| `rollups` | 5 min | Rebuilds `daily_rollups` slices from raw rows |
| `budgets` | 1 h | Month-to-date vs. limit per budget, e-mail at 80 % and 100 % |
| `runaways` | 5 min | Flags runaway turns, mails at most one digest per hour |
| `retention` | 1 h tick, **once per UTC day** after `RETENTION_HOUR_UTC` | Deletes expired raw rows, prunes bookkeeping tables |

All jobs run once at start-up, never overlap with themselves, and never crash the process: an error is
logged and the next tick tries again. Each run logs one health line:

```
[worker] job=rollups status=ok ms=212 days=3 rows=41
[worker] job=budgets status=ok ms=36 budgets=4 sent=1 failed=0
[worker] job=runaways status=ok ms=40 alerts=1 mails=2 failed=0
[worker] job=retention status=ok ms=480 retention_days=395 turns=310 runs=22 usage=402 sessions=40 ingest_events=1900 pending_patches=2 magic_links=3 auth_sessions=7 device_codes=4
```

On failure: `job=<name> status=error ms=<n>` plus the error.

### rollups

Each pass recomputes whole day slices, deployment-wide (delete + insert in one transaction, under
an advisory lock, as described in [packages/db/README.md](../../packages/db/README.md)). The rewrite never loses
history (`src/jobs/rollups.ts: recomputeDay`, rules in `src/rollups/slice.ts`):

- **Which slices.** Today and yesterday (UTC) always, so the job heals itself; plus every day with a turn whose
  `updated_at` / `created_at`, or a run whose `created_at`, is newer than the watermark (late-arriving offline
  queues). With no watermark (first start, or lost state) every day that has raw turns is folded once.
- **Watermark.** `rollups.watermark` in `$WORKER_STATE_DIR/worker-state.json`, moved forward only when the whole
  pass succeeded, with a 10 minute overlap. There is no state table, so losing the file only costs a full re-fold.
- **Dimensions.** day, team, user, project, harness, model, effort. `user_id` is null only for old company-token
  turns from before ADR-0029 (every token belongs to a user now).
- **Counts** (turns, runs, duration, phase ms, outcomes) belong to the turn's own model and effort. **Tokens and
  requests** come from the `usage` rows and belong to each usage row's model and effort, so a mixed-model turn
  is priced right: a model that only appears in sub-agent usage gets a row with `turns = 0`. Totals equal the raw
  sums. All-zero usage rows (a model that was only mentioned) create no row (DP-10). The pure logic is `src/rollups/aggregate.ts`.
- **Cost is not stored.** `agg_rollups` computes it at query time.
- Days outside the deployment's retention window, and days with no raw turns left, are never touched, so the
  permanent rollups cannot shrink when raw rows expire.
- **Deleted users.** Removing a member keeps their raw rows and rollups with their `user_id` (shown as "former member"; ADR-0012 amendment, ADR-0022), so nothing is anonymised. Only when an operator deletes the user identity itself are their raw rows deleted and `daily_rollups.user_id` set to null (ADR-0012); that is the path described below.
  Those anonymised rows are kept on every later rewrite of the day; only the other rows are rebuilt. To tell them
  apart from rows of ownerless turns (also `user_id` null), every row the worker writes has an id that records
  whether it had a user: a random UUID with version digit `8` followed by `a` (had a user) or `0` (did not). A row
  with `user_id` null and an id starting `xxxxxxxx-xxxx-8a` is anonymised. Rows with other ids (seeds, rows written
  before this rule) are treated as ordinary rows.
- **Partly deleted raw rows.** When fewer raw turns that existed at the last rewrite remain than the slice's
  (non-anonymised) rolled-up turns, raw rows of that day were deleted (retention, an interrupted retention pass, a
  window widened again). The slice is then not rebuilt; only turns created after the last rewrite are added on top
  (append). Known limit: in append mode a later change to an already added turn (an outcome patch, a run arriving
  late) is not reflected.
- Known limit: the change scan filters on `turns.updated_at` / `created_at`, which have no index. It is fine at
  v1 volumes; add an index on `turns(updated_at)` if the scan shows up in `pg_stat_statements`.

### budgets

Every budget (team and/or user, period `month`, kind `tokens` or `cost`) is evaluated; there are no plan caps
(ADR-0028):

- **Month to date** (UTC calendar month) = `daily_rollups` for the days before yesterday + raw `usage` of yesterday and
  today, which the rollups job is still refreshing. Raw turns count only when they start before the end of the month
  and no more than 1 day after now, so a skewed or bogus future `started_at` never lands in this month's budget. Team budgets match `team_id`, user budgets `user_id`, and a budget
  with both matches both.
- **tokens** = input + output + cache read + cache write (`src/lib/cost.ts: totalTokens`). Reasoning tokens are part of
  output and are not added again.
- **cost** = tokens x the `model_prices` row effective on each usage day (`src/lib/cost.ts`; a day before the model's earliest row uses that earliest row, DP-03), at API list prices. A
  model with no price counts as 0 and is logged.
- **Notifications.** At >= 80 % one mail, at >= 100 % one mail, each once per month. Crossing 100 % straight away sends
  only the 100 % mail and marks both. `notified_period` holds the month of the marks; when the month changes the
  marks are reset. The pure rules are `src/budgets/evaluate.ts`.
- **Exactly once.** The worker claims the mark with a conditional `UPDATE ... RETURNING` before sending, so two workers
  never double-send. If every delivery fails, the claim is released and the next hourly pass retries.
- **Recipients.** Current members only; service users have no e-mail and are never mailed. Team budget: admins
  (`memberships.role = 'admin'`) plus the leads of the budget's team. User budget: in
  `individualVisibility = 'full'` the same plus the user; in **aggregates-only mode (the default) only the user**,
  because the mail names the person and their exact usage, which admins and leads must not see in that mode
  (ADR-0008). One mail per address, de-duplicated. Plain text plus simple HTML (`src/budgets/mail.ts`) naming the
  deployment, linking to `${APP_URL}/overview`.
- Budgets never block anything.

### runaways

Every 5 minutes (docs/briefs/runaway-alerts.md, ADR-0018): turns written since the last pass (watermark, 10 minute
overlap; one day back on a cold start) and started within the last week, without an alert yet, are checked by the pure
rules in `src/runaways/decide.ts`: tokens (input + output + cache writes) far above the user's own 30-day p99, ≈ cost at or
above `deployment.settings.runawayCostUsd` (default $20), or a run of `runawayHours` (default 2) with above-normal tokens.
A flagged turn gets one `runaway_alerts` row.

At most one digest per hour (the newest `notified_at` of any alert). Recipients: the user of each turn while they are
still a member; in `full` visibility also the leads of the turn's team (named digest); in aggregates-only mode the admins
get an anonymous digest instead (no person, no links). A removed member is neither mailed nor named ("former member").
Service users have no e-mail. Alerts are claimed before sending and released when every mail failed.

### retention

Once per UTC day, with the effective window = `deployment.settings.retentionDays` clamped to 30-730 days
(`effectiveRetentionDays(settings)`, default 395; no plan caps):

1. The cutoff is `00:00 UTC` of `today - window`, so a day is deleted whole. Every expiring day with raw turns is
   first folded into `daily_rollups` with the same rules as the rollups job: rebuilt when its raw rows are complete,
   otherwise only turns that arrived after the last rewrite are added. So a late turn for a day that already expired
   (an offline queue older than the window) is added to the rollup, not lost and not overwriting it.
2. `usage`, `runs` and `turns` older than the cutoff are deleted in batches of 2000, and so are unlinked orphan
   runs / usage.
3. `agent_sessions` older than the cutoff are deleted only when no turn still references them.

Also: `ingest_events` older than 30 days, `pending_turn_patches` / `pending_session_patches` (parked patches and titles
whose turn or session never arrived, ADR-0015, ADR-0026) received more than 30 days ago, `magic_links` and `auth_sessions`
past `expires_at`, and device-login codes (ADR-0029): open codes past their expiry are marked `expired`, and codes are
deleted one day after they expired. Counts are logged (when non-zero) and in the health line. Rollups are kept forever.

## Running one job (RUN_ONCE)

```bash
RUN_ONCE=rollups pnpm --filter @ai-obs/worker once            # or: pnpm --filter @ai-obs/worker once budgets
node dist/index.js --once retention                           # also accepts --once=<job> and `once <job>`
docker compose run --rm -e RUN_ONCE=budgets worker
```

It runs the job once with `force` (skips the "retention already ran today" guard), prints the health line and exits
with 0 (ok), 1 (job failed) or 2 (unknown job). Handy for cron-style deployments, docs and tests.

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL_WORKER` / `DATABASE_URL` | | Worker DB login (role `app_worker`) |
| `WORKER_STATE_DIR` | `<tmpdir>/ai-obs-worker` | Watermark and last-retention-day marks. Mount a volume in production |
| `RETENTION_HOUR_UTC` | `3` | Retention runs once per UTC day, not before this hour |
| `RUN_ONCE` | | Job name to run once and exit |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | mailpit on `localhost:1025` | Budget and runaway e-mails |
| `APP_URL` | `http://localhost:3000` | Link target in e-mails |

## Layout

```
src/index.ts          entry: scheduler, or RUN_ONCE
src/scheduler.ts      intervals, no overlap, health lines
src/cli.ts            RUN_ONCE parsing and runner
src/context.ts        WorkerContext (db, state, config, log, mailer, clock) injected into jobs
src/jobs/*.ts         rollups, budgets, runaways, retention (DB work)
src/rollups/          pure aggregation, day planning, slice rewrite rules (anonymised rows, append mode)
src/budgets/          pure threshold logic, usage measuring, mail templates
src/runaways/         pure runaway rules, digest mail template
src/lib/              cost math, dates, retention policy, deployment row, config, state file, SMTP mailer
```

## Tests

`pnpm --filter @ai-obs/worker test` (or `pnpm vitest run --project worker`).

- Pure unit tests: rollup aggregation and day planning, cost math, budget thresholds and once-only logic, mail
  templates, retention cutoff and policy, slice rewrite mode and rollup row ids, RUN_ONCE parsing, state file, scheduler.
- `test/db.integration.test.ts` runs against real Postgres in its **own database** (dropped and re-created per run,
  migrations applied; same host and credentials as `TEST_DATABASE_URL`, default
  `postgres://ai_obs:ai_obs@localhost:5432/...`). The name is `TEST_DATABASE_URL`'s database when that already contains
  `worker` (e.g. `ai_obs_worker2_test`), else `<name>_worker_test` (default `ai_obs_worker_test`). Each test starts
  from a clean deployment (`seedDeployment` empties the tables and sets the one deployment row). It checks rollups equal
  raw sums, rollup idempotency, the watermark path, anonymised rows of a deleted user surviving recomputes, retention
  deletion with fold-first and session safety, late turns for expired days, the window from `deployment.settings`,
  pending-patch and device-code pruning, runaway detection (thresholds from the settings) and digests, and the full
  budget flow with a fake mailer (recipients per visibility mode, removed members, service users, future-dated turns).
  Without Postgres it skips with a reason.
