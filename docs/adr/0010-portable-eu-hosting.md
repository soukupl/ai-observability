---
spoor_id: 9e8c1cfb-2627-4b9b-9474-6e48a7aac79f
---
# ADR-0010: Portable, EU-hosted, self-hostable deployment

- **Status:** Accepted; amended 2026-10-24 by [ADR-0028](0028-one-deployment-one-company.md) (no official SaaS, self-hosted only)
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** hosting, compliance

## Context

The owner is an EU company; buyers will ask about GDPR and data residency. Some companies will refuse
to send any telemetry to a SaaS.

## Decision

We will provision **all backend services with Docker**. A Docker Compose file is the reference
deployment (dev, SaaS, self-hosted). It runs one app image (Next.js standalone) as the `web`, `worker`
and one-shot `migrate` services, the official Postgres 16+ image, and Mailpit in the dev profile only.
We use SMTP and no vendor-specific services. Config comes from env vars and secrets are never baked
into images. (Owner note, 2026-10-05: "we will use docker to provision the backend services".) The official SaaS runs in an **EU region**; the
same image can be self-hosted by companies.

## Consequences

- Runs on any VPS, Kubernetes or PaaS; enables a self-hosted edition later.
- We cannot lean on managed conveniences (edge functions, vendor auth, vendor data APIs).
- Self-hosted installs need versioned migrations and upgrade docs.

## Alternatives considered

- **Vercel + Neon/Supabase only** — least ops, but vendor lock-in and conflicts with RLS-only access.
- **Own VPS only** — full control but no portability story.

## Amendment 2026-10-24 — self-hosted only (ADR-0028)

- **Decided by:** Ladislav Soukup (owner, grilling Q1-Q9 of 2026-10-24 and "go" on
  `docs/briefs/single-deployment-per-user-tokens.md`); design by Claude Fable 5.1. The body and earlier amendments are kept as history.

- There is **no official SaaS** and no multi-tenant edition. Each company runs its own deployment of the same image
  (one deployment = one company); the Docker Compose file stays the reference deployment. "EU region" now describes where
  the owner's own deployment runs, not a hosted offering.
- The `app_platform` service URL and password variables are removed from the configuration.
