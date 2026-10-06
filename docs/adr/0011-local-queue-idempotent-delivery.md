# ADR-0011: Local file queue with idempotent ingest

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** collector, api, reliability

## Context

Developers go offline, close laptops mid-session, and the SaaS can be down. Data must not be lost or
double counted, and we do not want a long-running daemon on developer machines.

## Decision

The collector appends events to `~/.ai-obs/queue/*.ndjson` and sends batches (≤ 500 events / 1 MB) on
hook triggers and `ai-obs flush`. Every event has a client-generated ULID `event_id`; the server stores
seen IDs and ignores duplicates. The queue is capped (~50 MB / 30 days, oldest dropped first).

## Consequences

- No data loss across network failures; retries are always safe.
- Dashboard latency is minutes, not seconds.
- Server keeps an `ingest_events` de-duplication table (pruned after 30 days).

## Alternatives considered

- **Best effort** — silently loses data.
- **Background daemon** — real-time, but another process to install, update and support.

## Amendment 2026-10-06 — ingest ownership, ordering and limits

- **Decided by:** Claude (review-fix integration, 2026-10-06), from the security / data-correctness review of the MVP build. **Owner confirmation pending.**

- **Ownership (SEC-3).** A turn, run or session can be overwritten only by its current owner (any token or machine of that user),
  or while it has no owner; anything else is rejected as "conflicts with data owned by another user", rolled back and not recorded as
  seen. Unverified senders never overwrite an owned row. A parked patch remembers its sender and is applied only to an ownerless
  turn or one with the same owner (otherwise dropped); another user cannot overwrite a parked patch.
- **Ledger keys are namespaced by sender** (`<user id | token:<token id>>:<event_id>`), so one sender cannot pre-claim another's
  event ids. Retries still de-duplicate across one user's tokens and machines. Rows written before this change use the old key, so old
  events replayed once are applied again (idempotent).
- **Outcome ordering (DP-09).** A final (non-provisional) outcome writes an `outcome-final` marker; a provisional patch arriving later
  is ignored whatever the order, including patches parked before their turn. Stale turn re-sends (an older revision overwriting a newer)
  are not solved: that needs a revision field on the wire (open).
- **Batch mechanics.** Events are applied in chunks of 25 per savepoint (a failing chunk is retried one event per savepoint), and
  `applyRun` takes the same turn advisory lock as turns and patches (DP-13, DP-14).
- **Limits (DP-07, SEC-12).** Out-of-range counts reject the event (never clamp); tool keys, agent types and outcome signals are
  normalised server-side so an older or third-party collector cannot store paths or internal names. A team token matches a git e-mail only
  to a member of the token's team (SEC-10).
- **Ingest guard (SEC-9).** Failed authentications are answered from a negative cache and an IP budget before any DB call; the per-token
  bucket is keyed by token id after lookup.
