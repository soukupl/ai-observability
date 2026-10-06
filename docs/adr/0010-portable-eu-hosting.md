# ADR-0010: Portable, EU-hosted, self-hostable deployment

- **Status:** Accepted
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
