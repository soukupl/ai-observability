---
spoor_id: 38ed9c73-d8f6-4b01-989b-54d637c0a67a
---
# ADR-0009: Tech stack — TypeScript, Next.js, Postgres, Drizzle, Tailwind, Recharts

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** stack

## Context

We need a dashboard, an ingest API, background jobs and a collector that runs on any developer
machine with Claude Code or Codex installed.

## Decision

We will use TypeScript end to end: **Next.js** (App Router) for dashboard and API, **Postgres** with
**Drizzle** ORM, **Tailwind** for UI, **Recharts** for charts. The collector is a **zero-runtime-dependency
Node (≥ 20)** CLI. The ingest endpoint is an isolated route module so it can become its own service.

## Consequences

- One language, one deploy, fast iteration; Node is already present wherever the harnesses run.
- Write-heavy scale may later require splitting ingest out (planned seam).
- Zero-dep collector means hand-written HTTP / file-queue code, but minimal supply-chain risk.

## Alternatives considered

- **Separate Go/Hono ingest service + Next.js** — better write scaling, more to operate now.
- **Other in-house stacks** (PHP, .NET) — no advantage for this product.
