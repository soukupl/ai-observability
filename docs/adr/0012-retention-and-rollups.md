# ADR-0012: Configurable raw retention with permanent daily rollups

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** database, compliance

## Context

Unlimited raw storage grows forever and is hard to justify under GDPR; long-term trends are still wanted.

## Decision

Raw rows (sessions, turns, runs, usage) are kept per company for 30 days – 24 months (limited by plan),
**default 13 months**. A worker maintains **daily rollups** (per company, team, user, project, harness,
model, effort, day) that are kept indefinitely and contain no summaries. A nightly job deletes expired raw
rows; deleting a user removes their raw rows and nulls `user_id` in rollups.

## Consequences

- Long-range charts stay fast and survive raw deletion.
- Two read paths (rollups vs raw) must give consistent numbers — needs tests.
- Detail views are limited to the retention window.

## Alternatives considered

- **Keep forever** — storage and compliance burden.
- **Fixed retention** — does not fit both strict and long-horizon customers.

## Amendment 2026-10-06 — rollup rules that make retention safe

- **Decided by:** Claude (review-fix integration, 2026-10-06), from the security / data-correctness review of the MVP build. **Owner confirmation pending.**

- **Deleted users' rollup rows are kept (DP-01).** Deleting a user nulls `user_id` on their rollup rows (ADR text above), and
  the worker's whole-day rebuild used to delete those rows as "turns without a user". Every row the worker writes now carries a
  marker in its id (UUID version digit 8; the next character is `a` when the row had a user, `0` when it had none), so a row with
  `user_id` null and an `8a` id is a deleted user's row and is kept. Rows written by anything else are rebuilt as before.
  (An explicit `had_user` column would be cleaner; not done.)
- **A day with partly deleted raw turns only gets late turns added (DP-05).** The worker first checks that the day's raw turns are
  complete; if fewer remain than the rollup counted, it never rebuilds the day and only adds turns created after the last rollup.
  Retention folds every expired day through the same check. Known limit: in that add-only mode a later change to an
  already-counted turn (outcome patch, a late run) is not picked up.
- **Ingest refuses events outside the retention window (DP-05, DP-08).** A turn or run that started before the company's retention
  cutoff (the plan maximum applied to `settings.retentionDays`, 00:00 UTC) or more than a day in the future is rejected with a reason,
  so folded days cannot be re-opened and month-to-date budgets cannot be inflated by far-future timestamps.
- **Parked patches** (`pending_turn_patches`) are pruned after 30 days by the retention pass (DP-06).
- **Retention-aware source choice (DP-04).** The dashboard reads rollups when a range starts before `today − retentionDays`
  (the raw rows may already be gone), not only for long ranges. Medians on long ranges are computed from raw turns while the
  range starts inside retention (exact on the direct path, a capped sample on the aggregate path, flagged `medianApproximate`);
  past retention they show n/a.
- **CSV exports** are capped at 50,000 rows and paged by keyset, so ties on `started_at` cannot repeat or skip rows; a capped turns
  CSV ends with a visible `TRUNCATED` row and the response carries `X-Truncated: true`.

## Amendment 2026-10-08 — members are removed from a company, not deleted (ADR-0022)

- **Decided by:** Ladislav Soukup (owner, confirmed the non-destructive removal); options proposed by Claude.

- Admins now remove a **membership**, not a user. Removing one deletes the person's team memberships and per-user budgets in
  that company and revokes their tokens there. Their raw telemetry and rollups are kept with their `user_id` and shown as
  "former member".
- The cascade above (raw rows deleted, rollups anonymised) now applies only when an operator deletes the identity itself;
  no screen does that.
