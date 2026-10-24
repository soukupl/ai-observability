# ADR-0011: Local file queue with idempotent ingest

- **Status:** Accepted; amended 2026-10-08 by [ADR-0022](0022-company-memberships-and-token-kinds.md) and 2026-10-24 by
  [ADR-0030](0030-project-dot-file-and-team-resolution.md) (see the amendments below)
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** collector, api, reliability

## Context

Developers go offline, close laptops mid-session, and the SaaS can be down. Data must not be lost or
double counted, and we do not want a long-running daemon on developer machines.

## Decision

The collector appends events to `~/.ai-obs/queue/*.ndjson` and sends batches (≤ 500 events / 1 MB) on
hook triggers and `ai-obs flush`. Every event has a client-generated ULID `event_id`; the server stores
seen IDs and ignores duplicates. The queue is capped (~50 MB / 30 days, oldest dropped first). (see the amendment of 2026-10-08)

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
  *Amended by ADR-0022: team tokens no longer exist; a company token matches a git e-mail to any member of its company (bound to the ingest company).*
- **Ingest guard (SEC-9).** Failed authentications are answered from a negative cache and an IP budget before any DB call; the per-token
  bucket is keyed by token id after lookup.

## Amendment 2026-10-08 (ADR-0022)

- **Decided by:** Claude, within the owner-approved brief `docs/briefs/multi-company-tokens.md`.
- The queue is split into streams per project and binding. Each session is bound when it is recorded to the token it resolved to (or left
  open when there was no choice) and is sent only with that token; open data is sent after `ai-obs use`. Streams that cannot be sent (held,
  rejected, unconfirmed) are exempt from the 30-day cap, which counts from when a stream became sendable; the size cap still applies and its
  drops are counted. Delivery state and backoff are
  per token. The files written by the 0.1.x collector are a frozen stream: they are moved to `queue/dead/pre-upgrade/` by the first
  registration and never sent.

## Amendment 2026-10-24 — streams keyed by server and team (ADR-0030)

- **Decided by:** Ladislav Soukup (owner, grilling Q1-Q9 of 2026-10-24 and "go" on
  `docs/briefs/single-deployment-per-user-tokens.md`); design by Claude Fable 5.1. The body and earlier amendments are kept as history.

- A stream is keyed by `(project key, server endpoint, team slug | "")` (`queue/p/s-<id>/`); a session is pinned to its
  stream at its first hook. Open and token-bound streams, `ai-obs use` and routing epochs are gone. Delivery state and
  backoff are per server. Time a server spends blocked by 401 does not count against the 30-day age cap.
