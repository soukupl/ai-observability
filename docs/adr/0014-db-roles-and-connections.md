---
spoor_id: 54440e09-796e-4484-a03e-a94028037875
---
# ADR-0014: DB roles as NOLOGIN roles reached via SET ROLE, optional per-service logins

- **Status:** Accepted; amended 2026-10-24 by [ADR-0028](0028-one-deployment-one-company.md) (no `app_platform` role)
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner, via "start coding the project"); implemented by Claude (schema agent)
- **Tags:** security, database, operations

## Context

ADR-0006 requires separate DB roles (`app_web`, `app_ingest`, `app_worker`, `app_platform`) and RLS that
also binds the table owner. Local dev and the reference Compose stack have one owner URL; production
should not let a compromised web process use the owner's privileges. `SECURITY DEFINER` functions need
an owner that RLS lets through without making the schema owner itself bypass FORCE RLS.

## Decision

- The migration creates the four service roles plus `app_definer` as **NOLOGIN** roles and grants them to
  the migrating user.
- `dbFor('web' | 'ingest' | 'worker' | 'platform')` connects with `DATABASE_URL_<SERVICE>` (fallback
  `DATABASE_URL`) and always sets the Postgres `role` startup parameter, so every pooled connection runs
  as its `app_*` role even on the shared dev owner URL — RLS is exercised in dev exactly as in production.
- If `DB_APP_<ROLE>_PASSWORD` is set, `migrate` turns that role into a LOGIN role with the password
  (re-applied on every deploy for rotation); production points `DATABASE_URL_<SERVICE>` at it.
- `SECURITY DEFINER` functions are owned by `app_definer`, which has an explicit `USING (true)` policy;
  the schema owner gets no bypass policy.
- Roles, grants, policies and functions live in a hand-written Drizzle migration (`0001_roles_rls.sql`),
  so they are versioned and applied once, in order, like schema changes.

## Consequences

- One code path for dev and production; the RLS test suite runs against the same mechanism.
- Poolers that reject unknown startup parameters (e.g. PgBouncer without `ignore_startup_parameters`)
  need direct connections or per-service logins with the role as login user.
- With the single-URL fallback a process could `RESET ROLE` back to the owner; production should use
  per-service logins.
- New tables need grants + policies in a new migration; drizzle-kit does not generate them.

## Alternatives considered

- **LOGIN roles only** — needs four passwords even for local dev and tests.
- **`SET LOCAL ROLE` per transaction** — easy to forget outside `withRlsContext()`.
- **BYPASSRLS owner for definer functions** — requires superuser to grant; managed Postgres often forbids it.

## Amendment 2026-10-06 — platform role scope

- **Decided by:** Claude (review-fix integration, 2026-10-06), from the security / data-correctness review of the MVP build. **Owner confirmation pending.**

- **The platform role sees only `platform.*` audit rows** (and rows without a company), and cannot insert any other action (SEC-6),
  so it can neither read a tenant's audit trail nor forge `export` rows.
- **`platform_email_in_use(email)`** (SECURITY DEFINER, boolean only) answers "is this e-mail registered anywhere" for the console, because the
  platform role cannot read ordinary members through RLS (SEC-7).
  *Amended by ADR-0022: replaced by `platform_invitee_status(email, company_id)`, which returns only `super_admin`, `admin` (of that
  company) or null, so a login can be invited into, or made first admin of, another company.*
- New migration 0004 also adds `auth_pending_invitations`, `ingest_project_salt`, `company_has_user_capacity` and a changed
  `ingest_match_user_by_email(email, team)`; all are SECURITY DEFINER owned by `app_definer` with EXECUTE granted per role.

## Amendment 2026-10-24 — no app_platform (ADR-0028)

- **Decided by:** Ladislav Soukup (owner, grilling Q1-Q9 of 2026-10-24 and "go" on
  `docs/briefs/single-deployment-per-user-tokens.md`); design by Claude Fable 5.1. The body and earlier amendments are kept as history.

- Migration 0018 strips the **`app_platform`** role of its policies, grants and `platform_*` functions with `DROP OWNED`
  (the 2026-10-06 amendment above and `platform_invitee_status` are history). The cluster role object itself is left for the
  operator to drop (`DROP ROLE app_platform;`) once no database of the cluster uses it: roles are cluster-wide, and a
  per-database migration that drops one races every other database migrating at the same time. The service roles are `app_web`, `app_ingest`,
  `app_worker`, plus `app_definer`; `dbFor('platform')`, `DATABASE_URL_PLATFORM` and `DB_APP_PLATFORM_PASSWORD` are removed.
- New definer functions (`ingest_resolve_team`, device-token minting, ADR-0029 / ADR-0030) follow the same rule: owned by
  `app_definer`, EXECUTE granted per role.
