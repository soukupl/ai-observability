---
spoor_id: b874a92b-2f81-4a61-a930-1a31852595ed
---
# ADR-0005: Harness-neutral ingest format; Claude Code and Codex first

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** api, schema

## Context

The product should support all AI coding harnesses, but Claude Code and OpenAI Codex are the primary
targets. Each harness has its own hooks and transcript format.

## Decision

We will define one versioned ingest format (`schema: 1`) with event types `session_start`, `turn`,
`run`, `turn_outcome`, `turn_summary`, `session_end`. Every event carries `harness`; harness-specific
extras go into `ext`. The collector has one **adapter** per harness; v1 ships `claude-code` and `codex`.

## Consequences

- Adding a harness requires only a new adapter, no backend change.
- The common format is a lowest-common-denominator; per-harness detail lives in `ext`.
- The format is a contract with deployed collectors: changes must be additive or bump `schema`.

## Alternatives considered

- **Claude Code only** — simpler but misses a primary target.
- **Per-harness ingest endpoints** — duplicates backend logic.
