---
spoor_id: e969e498-bc08-4737-b660-d3d5eff3114a
---
# ADR-0028: One deployment = one company; the company leaves the schema

- **Status:** Accepted. Supersedes the membership part of [ADR-0022](0022-company-memberships-and-token-kinds.md) (Q1, Q6,
  D4, D5, D9, D10, D11 as far as they concern companies) and [ADR-0006](0006-tenant-isolation-with-rls.md) in part (tenant =
  company, `company_id` on every row, `app_platform`); amends [ADR-0010](0010-portable-eu-hosting.md) (no official SaaS,
  self-hosted only), [ADR-0012](0012-retention-and-rollups.md) (no plan caps on retention),
  [ADR-0013](0013-dashboard-authentication.md) (bootstrap by `ADMIN_EMAILS` / `ALLOWED_EMAIL_DOMAINS`, invitations
  auto-accepted, no `identity_providers`) and [ADR-0014](0014-db-roles-and-connections.md) (no `app_platform` role)
- **Date:** 2026-10-24
- **Deciders:** Ladislav Soukup (owner: grilling Q1-Q9 of 2026-10-24 and "go" on
  `docs/briefs/single-deployment-per-user-tokens.md`); design by Claude Fable 5.1 within the brief
- **Tags:** security, schema, auth, database, operations
- **Brief:** [single-deployment-per-user-tokens](../briefs/single-deployment-per-user-tokens.md)
- **Related:** [ADR-0029](0029-per-user-tokens-device-login-expiry.md) (tokens and device login),
  [ADR-0030](0030-project-dot-file-and-team-resolution.md) (dot file and team resolution)

## Context

ai-obs was built as a multi-tenant SaaS: a `companies` table, `company_id` on about twenty tables, plans with user and
retention caps, a super-admin console on its own DB role (`app_platform`), self-service sign-up with a solo workspace,
and, since ADR-0022, one login holding memberships in several companies with a header switcher and company-bound forms.

The owner decided to drop the SaaS: "We will remove all SaaS parts and change the tool to only work for single company
(per deployment) with multiple teams — this level will stay, but multi-company feature will be gone. You can merge data
from multiple companies to single one on the dev deployment, keep the teams separation." A developer who works for
several companies now talks to several servers (ADR-0030); one server never holds more than one company.

Everything that existed only to keep companies apart (composite `(company_id, id)` keys, the company predicate in every
policy and `agg_*` function, the active company on the session, D10 form binding, the super-admin triggers, plan checks)
becomes dead weight and a source of bugs. Teams, leads, members, project → team mapping, budgets and the two visibility
modes are the product and stay exactly as they are.

## Decision

### Owner decisions (grilling of 2026-10-24)

| # | Decision | Owner answer |
|---|---|---|
| Q1 | **The company concept leaves the schema.** `companies` and every `company_id` column are dropped; RLS is rewritten around users and teams; a one-row `deployment` table holds the name, slug, settings and project salt. | Drop entirely now |
| Q2 | **Dev merge: all four companies** into one, six teams, full visibility, runaway threshold 20 USD, plain project naming, retention 395 days (nothing is deleted). | All four, full, 395 |
| Q3 | **Only the dev DB has several companies.** The merge is a one-off script rehearsed on a `pg_dump`; migration 0018 refuses to run while more than one company exists. | Only dev |
| Q8 | **`ADMIN_EMAILS`** replaces `SUPER_ADMIN_EMAILS`: a listed e-mail becomes admin on first login. Everyone else joins by invitation, or automatically as a member when their verified e-mail domain is in **`ALLOWED_EMAIL_DOMAINS`** (empty by default). | ADMIN_EMAILS + domain auto-join |
| — | **Deployment name SPECTADO**, slug `spectado` (the dev deployment). | SPECTADO |

### Design decisions (Claude, within the brief; open for review)

- **E1, the `deployment` table.** One row (`name`, `slug`, `settings` jsonb, `project_salt`, timestamps), guarded by a
  unique-index guard so a second row cannot be inserted. `settings` keeps the keys `companies.settings`
  had: `individualVisibility` (`aggregates-only` | `full`), `projectNaming` (`plain` | `hashed`), `retentionDays` (30-730,
  default 395), the runaway thresholds. Migration 0018 creates it from the one remaining company (name, slug, settings,
  salt carried over, so hashed project names stay stable). Admins edit it in Settings; `app_web` reads it, `app_worker`
  selects the row directly, and `app_ingest` receives settings and salt from `lookup_ingest_token` / `ingest_project_salt`.
- **E2, memberships.** `company_memberships` becomes `memberships` (one row per user: `user_id`, `role` admin | member,
  `primary_team_id`); `company_id` and `last_active_at` go. Team memberships (`team_memberships`, with the
  lead flag) and per-user budgets are unchanged. D1 (removal is non-destructive), D2 (tokens revoked, not deleted), D8
  (`admin_remove_member` as a definer function), the last-admin rule and the audit log survive with the company argument
  dropped.
- **E3, users.** `users` gains `kind` (`person` | `service`, ADR-0029); `email` becomes nullable for service users only (a
  check constraint). `is_super_admin` goes.
- **E4, RLS rewritten around users and teams.** The request context is `app.user_id` and `app.role` (`admin` | `member`),
  re-checked against `memberships`: a user with no membership sees nothing, `app.role = 'admin'` counts only if
  `memberships.role` agrees. Policies keep the existing rules minus the company predicate: own rows; rows of teams the user
  leads (under the visibility mode); everything for admins under the same mode rule. RLS stays enabled and forced on every
  telemetry table, so a missing `WHERE` in application code still cannot leak another user's or team's rows; the threat
  ADR-0006 guarded against (another company) is gone, the in-company privacy rules are what remains. `withRlsContext()`
  drops `companyId`. The `agg_*` definer functions lose their company argument and keep their visibility logic. The
  cross-team and visibility proofs in `rls.test.ts` are kept case by case; the cross-company proofs are deleted.
- **E5, removed outright.** `companies`, `identity_providers` (and enum `identity_provider_kind`), `companies.plan` /
  `status` and enums `plan` / `company_status`, `auth_sessions.active_company_id`, the `app_platform` role's
  policies, grants and `platform_*` functions (the cluster role object itself is left for the operator to drop), `auth_create_solo_company`, `auth_ensure_super_admin`,
  `company_has_user_capacity`, `auth_user_memberships`, `auth_set_session_company`, the super-admin triggers, every
  composite `(company_id, id)` key and FK (replaced by plain `id` FKs). In the dashboard: `app/super`, `lib/platform`, the
  sign-up page and API, `CompanySwitcher`, the D10 company-bound form machinery, `lib/admin/plans.ts` and every plan check,
  the `/invitations` page, `requireSuperAdmin`, `SUPER_ADMIN_EMAILS`. The header shows the deployment name.
- **E6, bootstrap and login provisioning (Q8).** At magic-link or OAuth login: a known user logs in; an unknown e-mail
  becomes **admin** if listed in `ADMIN_EMAILS` (comma-separated, case-insensitive), a **member** with the invited team
  and role if a pending invitation exists for it, a **member** with no team if its verified domain is in
  `ALLOWED_EMAIL_DOMAINS`; otherwise login is refused with a page that says to ask an admin for an invitation. For OAuth,
  only a provider-verified e-mail counts for the domain rule. `ADMIN_EMAILS` only grants admin at first login; removing an
  address later does not demote anyone (admins are managed in the console, the last-admin rule applies).
- **E7, invitations are auto-accepted.** A pending invitation for the logging-in e-mail is accepted at the first
  magic-link or OAuth login (team and role from the invitation), with a one-time notice naming the deployment and its
  visibility mode. SEC-1 (ADR-0013, explicit consent on `/signup` and `/invitations`) guarded against a look-alike company
  capturing an account; with one company per deployment there is no look-alike to choose, and possession of the mailbox
  or OAuth identity is the consent.
  As built (open for review, 2026-10-24): an identity whose membership was removed is refused (`reason=removed`) unless
  re-invited, even when listed in `ADMIN_EMAILS` or in an allowed domain; with several pending invitations an admin
  invitation is accepted first (the first accepted creates the membership and so decides role and primary team); an
  invitation with role admin creates an admin.
- **E8, plans are gone.** No user, team or retention caps; budgets are always allowed; retention is admin-editable within
  30-730 days, default 395 (ADR-0012 amendment). Model prices become editable by admins in the admin console (audited);
  `ensureDefaultModelPrices` keeps seeding.
- **E9, the worker** no longer iterates companies: retention, rollups, runaway thresholds and digests read
  `deployment.settings`; mails name the deployment.
- **E10, environment.** Added: `ADMIN_EMAILS`, `ALLOWED_EMAIL_DOMAINS` (empty by default). Removed:
  `SUPER_ADMIN_EMAILS`, `DATABASE_URL_PLATFORM`, `DB_APP_PLATFORM_PASSWORD`. `MIN_COLLECTOR_VERSION` goes to 0.5.0 after
  the rollout (ADR-0029).

### The dev merge (Q2, Q3)

Only the owner's dev DB (`ai-obs-postgres-1`) has more than one company: four of them (`spectado-c7faa0` survives as
SPECTADO, plus the demo companies Acme and Globex and the owner's `plg`). They are collapsed by a one-off script, not a
migration: `packages/db/src/merge-companies.ts`, `mergeCompanies(url, { survivor, name, slug, settings })`, run by
`pnpm --filter @ai-obs/db db:merge-companies -- --survivor spectado-c7faa0 --name SPECTADO --slug spectado [--dry-run]`.
It runs in one transaction under `app_definer`, on the 0017 schema, before migration 0018.

**Collision rules** (Claude, open for review):

- **Same e-mail in several companies** (alice in acme and globex; the owner's gmail in plg and spectado): already one
  `users` row since ADR-0022; the memberships collapse into one. The **highest role wins** (admin over member); the
  **primary team** is taken from the company in which the user has more turns.
- **The shared `machines` row** (the same machine id registered in two companies) is merged into one row; its sessions
  (102 in dev) are re-pointed to the survivor.
- **Duplicate team names** across companies get the old company name as suffix (` (Acme)`); none exist in dev. All six teams keep their ids,
  members, leads, budgets and project mappings.
- **Rollups** (`daily_rollups` and the skill / MCP rollups) are kept as rows and re-pointed to the survivor, so
  per-day totals add up; the script asserts the sums are equal (as built, 2026-10-24: rows are not merged).
- **Projects with the same key** are merged into one.
- **Duplicate external ids:** a duplicate session, turn or run id **aborts** the merge with the offending ids; nothing
  is changed. Duplicate `ingest_events` and parked pending patches are de-duplicated (deleted), not fatal.
- **Platform audit rows** (`company_id` null) and the company-less super-admin identity are deleted; ordinary audit rows are
  kept.
- **Order:** every FK to `companies` cascades on delete, so rows are re-pointed to the survivor first and the three other
  companies are deleted last. The survivor's row gets name SPECTADO, slug `spectado` and the Q2 settings
  (`individualVisibility: full`, `retentionDays: 395`, `runawayCostUsd: 20`, `projectNaming: plain`).
- **Proof:** per-table row counts are printed before and after and asserted (equal for telemetry tables and rollups, the
  expected reduction for memberships and machines). The script refuses when the survivor is missing. It is rehearsed on a
  `pg_dump` copy before it touches the live dev DB; the expected result is six teams and all turns (1815 at the rehearsal).

Migration 0018 then refuses to run while `count(companies) > 1`, so a production database that somehow had two
companies cannot be silently collapsed; that operator must merge (or split into deployments) deliberately.

### Release order

1. Dev merge script (rehearsed on a dump, then on the dev DB).
2. Migration 0018 and the DB refactor (schema TS, drizzle snapshot, RLS, definer functions).
3. Web and ingest (the `app_platform` drop ships together with the removal of `app/super` and `lib/platform`).
4. Protocol (additive: `project.team`, response `warnings[]`, ADR-0030).
5. Collector 0.5.0 (ADR-0029, ADR-0030); 0.4.0 is never published.
6. `MIN_COLLECTOR_VERSION` 0.5.0 last.

## Consequences

- Fewer moving parts: about twenty `company_id` columns, the composite keys, one DB role, the switcher, form binding,
  plans, sign-up and the super-admin console are gone. RLS policies become shorter and are still forced.
- A company that wants ai-obs runs its own deployment; a developer in several companies registers several servers
  (ADR-0030). There is no official SaaS and no way to host several companies behind one dashboard (out of scope).
- A fresh deployment has no admin until someone in `ADMIN_EMAILS` logs in; operators must set it. With
  `ALLOWED_EMAIL_DOMAINS` empty, nobody else gets in without an invitation.
- Invitations no longer need an extra click; a mistyped invitation e-mail is accepted by whoever holds that mailbox (same
  as before for new e-mails, the inviter is responsible).
- Migration 0018 is irreversible (columns and tables dropped); the dev DB is merged once, after a rehearsal.
- Old docs and ADRs that talk about companies, plans and the super admin stay as history; their status lines point here.

## Alternatives considered

- **Keep `companies` with exactly one row** (hide the switcher, keep the columns): cheapest code change, but keeps every
  composite key, every company predicate and the dead platform role; rejected by the owner (Q1, "drop entirely now").
- **Keep multi-company and only remove plans and sign-up:** the owner wants one company per deployment; multi-company is
  replaced by multi-server on the collector side.
- **Merge the dev companies by hand in SQL without a script:** not repeatable, no rehearsal, no counts; rejected.
- **Do the merge inside migration 0018:** would run on every deployment; only dev needs it (Q3), so 0018 refuses instead.
- **Keep explicit invitation consent (SEC-1):** protects against a look-alike company that cannot exist any more; costs a
  page and a click for every invitee.
