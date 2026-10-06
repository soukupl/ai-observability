# ADR-0007: Per-user and team ingest tokens; turn-to-team attribution

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** security, auth, schema

## Context

Tokens decide who the data belongs to. Team-only tokens let anyone claim to be anyone; user-only
tokens make company-wide rollout hard. Users can belong to several teams.

## Decision

We will support **user tokens** (`aiobs_u_…`, identify the user, created for a specific team) and
**team tokens** (`aiobs_t_…`, for rollout / CI / shared machines). Team-token events are matched to a
user by git e-mail (`matched`), else stored as `unverified`. Tokens are stored hashed, shown once,
scoped to one team, revocable, with `last_used_at`.

A turn is attributed to one team: project → team mapping, else the token's team, else the user's
primary team.

## Consequences

- Individual dashboards are trustworthy for user-token data; attribution quality is visible.
- One config file can roll out to a whole team.
- Users in several teams need either a token per team or a project mapping.

## Alternatives considered

- **User tokens only** — painful bulk rollout.
- **Team tokens only** — attribution can be spoofed.
- **Turns visible to all of a user's teams** — leaks side work to unrelated leads.

## Amendment 2026-10-06 — member removal, token validity, team-token attribution

- **Decided by:** Claude (review-fix integration, 2026-10-06), from the security / data-correctness review of the MVP build. **Owner confirmation pending.**

- **Removing a member revokes their user tokens for that team (SEC-4)**, in the same transaction, with a `token.revoke` audit row each.
  Team tokens and the user's tokens for other teams are untouched. As defence in depth, `lookup_ingest_token` returns no row for a
  user token whose user is no longer a member of the token's team.
- **A team token attributes a git e-mail only to a member of the token's team** (primary team or a membership), not to anyone in the
  company (SEC-10); otherwise the turn stays unverified.
- **Plan downgrades grandfather existing usage (dod:C2).** Existing members, teams and invitations above the new plan's limits are kept;
  only new growth is refused (invite, create team, accept invitation), retention is capped by the worker, and budgets can only be removed.
  The platform console warns before a downgrade; the admin overview shows an over-plan notice.
