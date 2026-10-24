---
spoor_id: c2f442c2-0a74-435f-9500-9eceea9517b2
---
# ADR-0006: Tenant isolation with company_id and Postgres Row-Level Security

- **Status:** Superseded in part 2026-10-24 by [ADR-0028](0028-one-deployment-one-company.md) (company tenancy and `app_platform`
  removed; RLS kept, rewritten around users and teams)
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** security, database

## Context

Many companies share one SaaS. Leaking one company's data to another is the worst possible bug.
The super admin must manage companies without being able to read their telemetry.

## Decision

We will put `company_id` on every tenant row and enforce access with **Postgres RLS**. Each request
sets `app.company_id`, `app.user_id` and role context with `SET LOCAL`; policies also implement the
member / lead / admin rules and the individual-visibility mode. Separate DB roles: `app_web`,
`app_ingest`, `app_worker`, and `app_platform` (super admin) which has **no grants** on telemetry tables.

## Consequences

- A missing `WHERE` in application code cannot leak data across companies.
- "Super admin can't see data" is enforced by the database, not the UI.
- Requires direct Postgres connections (no vendor data APIs) and RLS tests in CI.
- Connection pooling must use transaction-scoped settings (`SET LOCAL`).

## Alternatives considered

- **App-level filtering only** — one bug away from a cross-tenant leak.
- **Schema / database per company** — strongest isolation but heavy migrations and onboarding.

## Amendment 2026-10-24 — one deployment = one company (ADR-0028)

- **Decided by:** Ladislav Soukup (owner, grilling Q1-Q9 of 2026-10-24 and "go" on
  `docs/briefs/single-deployment-per-user-tokens.md`); design by Claude Fable 5.1. The body and earlier amendments are kept as history.

- There is no tenant column any more: `companies` and every `company_id` are dropped, and one deployment serves one
  company. RLS stays **enabled and forced** on every telemetry table; the context is `app.user_id` and `app.role`,
  re-checked against `memberships`, and the policies keep the own-rows / led-teams / admin and visibility-mode rules.
- `app_platform` and the super admin are gone; the roles are `app_web`, `app_ingest`, `app_worker`, `app_definer`.
- The "worst possible bug" is now one user or team reading another's rows against the visibility mode; the RLS tests
  keep those proofs and drop the cross-company ones.
