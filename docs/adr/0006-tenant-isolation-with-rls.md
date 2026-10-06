# ADR-0006: Tenant isolation with company_id and Postgres Row-Level Security

- **Status:** Accepted
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
