---
spoor_id: 9cfcf62c-1c04-4d7b-822e-fee3deba5477
---
# ADR-0008: Privacy modes — project naming and individual visibility

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** privacy, compliance

## Context

EU companies, works councils and GDPR often object to per-person productivity tracking and to
sending repository URLs to a SaaS. Small teams and solo developers want full detail and zero setup.

## Decision

We will store metadata only — never prompts, responses, code, diffs or file paths — and offer two
per-company settings:

- **Project naming:** `plain` (normalized git remote, default) or `hashed` (SHA-256 of the remote,
  computed on the machine; admins name projects in the UI). The collector learns the mode from
  `GET /api/v1/collector-config`.
- **Individual visibility:** `aggregates-only` (default; leads/admins see no per-user rows, summaries
  shown without attribution) or `full` (leads see their teams' turns by person). The active mode is
  shown to every user. Each user always sees their own detail.

## Consequences

- Easier legal / HR approval; the default is the conservative choice.
- RLS policies and aggregate views must branch on the mode (ADR-0006).
- In very small teams aggregates can still identify people — open item.

## Alternatives considered

- **Single fixed policy** (always full or always aggregates) — fails one of the two audiences.

## Amendment 2026-10-06 — user-budget mails; project key salting

- **Decided by:** Claude (review-fix integration, 2026-10-06), from the security / data-correctness review of the MVP build. **Owner confirmation pending.**

- **In aggregates-only mode, a user budget's alert mails go only to that user (SEC-2).** Admins and team leads are not mailed, because
  the mail would reveal an individual's consumption that the mode hides everywhere else. In `full` mode they go to the admins, the
  team's leads and the user. The admin budgets page says so.
- **Hashed project keys are salted (SEC-11).** An unsalted `sha256(remote)` can be reversed with a dictionary of public repo
  names. The collector now HMACs: with no remote, a random per-machine secret in `~/.ai-obs/project-secret` that the server never
  sees; with a remote and `projectNaming = hashed`, the per-company `project_salt` served by `/api/v1/collector-config` (stable per
  company, readable only by that company's tokens). A server-held salt still does not protect against the operator, only against
  cross-company correlation and precomputed dictionaries. Project keys change once for both kinds of project (existing projects appear
  as new rows once).
