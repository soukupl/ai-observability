---
spoor_id: f20cd0d2-2ff0-45f8-920e-a4aaa58bd300
---
# ADR-0029: Per-user and service-user tokens, device login, fixed expiry

- **Status:** Accepted. Supersedes [ADR-0007](0007-ingest-tokens.md) and the token part of
  [ADR-0022](0022-company-memberships-and-token-kinds.md) (Q2 company tokens, Q5, Q7, Q9, D2 for company tokens, D6, D7,
  the git-e-mail match)
- **Date:** 2026-10-24
- **Deciders:** Ladislav Soukup (owner: grilling Q1-Q9 of 2026-10-24 and "go" on
  `docs/briefs/single-deployment-per-user-tokens.md`); design by Claude Fable 5.1 within the brief
- **Tags:** security, auth, collector, ingest, schema
- **Brief:** [single-deployment-per-user-tokens](../briefs/single-deployment-per-user-tokens.md) (Appendix A, B, C, F)
- **Related:** [ADR-0028](0028-one-deployment-one-company.md), [ADR-0030](0030-project-dot-file-and-team-resolution.md)

## Context

Since ADR-0022 a deployment had two token kinds: user tokens (`aiobs_u_`, one user in one company) and company tokens
(`aiobs_c_`, for rollout and CI, attributing turns to whoever's git e-mail matched a member, else `unverified`). Tokens
never expired; a developer created one in the dashboard and pasted it into `ai-obs init`.

With one company per deployment (ADR-0028) the company token has no job left except CI and shared machines, and git
e-mail attribution is spoofable by anyone holding such a token. The owner asked that "token will be per-user" and that
the CLI "support interactive login (like our spoor-memory CLI) or manual token". A user may still report to several
companies, which are now several servers, each holding its own token.

## Decision

### Owner decisions (grilling of 2026-10-24)

| # | Decision | Owner answer |
|---|---|---|
| Q6 | **Fixed 90-day expiry for device-login tokens** (spoor parity), nudge 14 days before. Manually created tokens get a lifetime chosen at creation (30 / 90 / 365 days / none), default 90. | Fixed 90, spoor parity |
| Q7 | **Carry over.** The two live user tokens stay valid (expiry set to cutover + 90 days). Collector 0.5.0 migrates its config, re-binds queued streams, ignores `projects.json`. **Collector 0.4.0 is never published**; 0.5.0 ships the live-session work of ADR-0027 too. | Carry over, skip 0.4.0 |
| Q9 | **Admin-created service users** for CI, bots and shared machines: no login, a name and a primary team, holding tokens that admins create and revoke. | Service users |

### Design decisions (Claude, within the brief; open for review)

- **T1, one token kind.** Every ingest token belongs to one user: a person or a service user. The prefix stays
  `aiobs_u_` for both; `aiobs_c_` (and the long-gone `aiobs_t_`) is answered with 401. Token kind `company` and the column
  go; `ingest_tokens.user_id` becomes NOT NULL. Tokens stay hashed, shown once, revocable one-way (trigger), with
  `last_used_at`.
- **T2, new token columns.** `expires_at` (null = no expiry, only for manual tokens created with "none"), `source`
  (`device` | `manual`), `label` (client name for device tokens, free text for manual ones). Migration 0018 sets
  `expires_at = cutover + 90 days`, `source = 'manual'` on the tokens it carries over (Q7).
- **T3, `lookup_ingest_token`** returns user id, user kind, primary team, deployment settings and project salt, and
  returns nothing unless the token is unrevoked, `expires_at` is null or in the future, and the user has a live
  membership (service users included). The 401 text is indicative: the server sends "ingest token expired or revoked, run `ai-obs login`" and, for
  `aiobs_c_` / `aiobs_t_` tokens, "company and team tokens are no longer accepted, run `ai-obs login`"; the collector
  shows its own "token expired or revoked: run ai-obs login --server <url>". The existing
  negative cache and per-IP failed-auth budget stay in front.
- **T4, device login, a copy of spoor-memory's flow** (Appendix B of the brief, fixed contract):
  - `POST /api/v1/device/code`, public, `{ client_name, client_version }` → `{ device_code (43 chars base64url),
    user_code ("XXXX-XXXX", 8 letters of ABCDEFGHJKLMNPQRSTUVWXYZ), verification_uri (<APP_URL>/device),
    expires_in: 600, interval: 5 }`. Per-IP rate limit (burst 10, 5 / min), at most 100 open codes server-wide (429
    beyond).
  - `POST /api/v1/device/token`, public, `{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code }`
    → `200 { token, expires_at, label }` or `400 { error }` with `authorization_pending`, `slow_down` (polled faster
    than `interval`), `access_denied`, `expired_token`, `invalid_grant`. A code is exchanged at most once (`consumed`).
  - `GET /device` (authenticated; anonymous visitors go to `/login?next=/device`): the user types the code (with or
    without the dash) and sees client name, requester IP and age, then Approve or Deny. Any person member may approve
    their own login; service users cannot log in. Approval only marks the code approved by that person; the next poll of
    `/device/token` mints the token for the approver through `device_exchange` (`SECURITY DEFINER`: `expires_at = now() +
    90 days`, `source = 'device'`, `label = client_name`), writes `token.create` (actor = approver) and consumes the
    code. An approved code that is never polled has no token and no audit row. The plaintext is generated by the caller
    at exchange time and never stored (amended 2026-10-24: built this way).
  - `device_codes`: `id`, `device_code_hash` (sha256; the raw code is never stored), `user_code` (unique among open
    codes), `client_name`, `client_version`, `requester_ip`, `created_at`, `expires_at`, `status` (`pending` |
    `approved` | `denied` | `consumed` | `expired`), `approved_by`, `token_id`, `last_polled_at`.
  - The routes are server-global (no team or company in the URL); the CLI builds `<server>/device` itself, prints and
    opens only that URL and ignores `verification_uri` (amended 2026-10-24: a server-supplied URL would be a phishing
    vector; a test feeds a foreign `verification_uri` to prove it is ignored).
  - One token per machine and server, named by the client name; logging in again on the same machine mints a new token
    and the CLI replaces its stored one (the old one stays listed until it expires or is revoked).
- **T5, manual tokens.** "My tokens" creates a token with a lifetime of 30, 90 (default), 365 days or none, and lists the
  user's device logins by client name with expiry and last use. `ai-obs login --token T` (or `-` for stdin) and
  `init --token --endpoint` accept such a token.
- **T6, expiry handling in the collector.** collector-config returns `token { expires_at, label, source }`; the
  collector keeps `expires_at` per server and nudges at SessionStart and in `status` / `doctor` from 14 days before
  expiry. There is no refresh token: after 90 days the developer re-runs `ai-obs login`. Time a server's batches spend
  blocked by 401 does not count against the 30-day queue age cap (ADR-0030), so an expired token does not lose data that
  a fresh login would deliver.
- **T7, service users (Q9).** `users.kind = 'service'`, a name, no e-mail, no login session, a membership with role
  `member` and a primary team (and optionally further team memberships for resolution, ADR-0030). Admins create, rename,
  re-team and disable them and create / revoke their tokens in Admin → Service users. Disable (as built, 2026-10-24) revokes every live token, removes
  the service user from all teams and clears its primary team; identity, membership and history stay. "Disabled" is
  derived (no live token and no team), not stored, and is reversible by a new primary team or a new token (open for
  review: whether creating a token for a disabled service user should be refused).
  Their turns are attributed to the service user like any person's; dashboards label them as service users.
- **T8, token visibility.** Users see and revoke their own tokens. Admins see and revoke every token, person and service
  (ADR-0022 D6 kept). Leads lose `/admin/tokens` (there are no company tokens to manage) and keep `/admin/budgets`. Only
  the owner of a person token creates it (dashboard or device approval); admins create only service-user tokens.
- **T9, ingest write guard.** The ingest context sets `app.user_id` from the token as well, and the ingest insert / update
  policies add `WITH CHECK (user_id = app_user())`, so a bug in the ingest code cannot write rows for another user.
  As built (open for review, 2026-10-24): the ingest `USING` clause is `user_id = app_user() OR user_id IS NULL`, so a
  token holder never sees another user's rows; a patch, title or run aimed at another user's turn or session finds
  nothing and is parked (or stored unlinked) under its sender and never applied to that row; every write claims an
  ownerless (company-token era) row for the sender, and a parked patch is applied only to an ownerless turn or one with
  the same owner. A repeated `session_start` that carries a project re-resolves the team with the then-current mapping
  and membership and updates the session row (see ADR-0030 R1).
- **T10, git-e-mail attribution is dropped.** `ingest_match_user_by_email` and the `matched` / `unverified` paths are
  removed; every new row is `verified`. The enum values stay for old rows. The collector may still send
  `header.identity.git_email`; the server ignores it (removing it from the wire format is out of scope).
- **T11, collector-config** (Appendix A): `project_naming`, `project_salt`, `min_collector_version` unchanged;
  `deployment { name, slug }`, `user { email (null for service users), name, kind }`, `teams [{ slug, name }]` the user
  belongs to (slug order), `primary_team` (nullable), `token { expires_at, label, source }`. `company` is gone.
- **T12, carry-over (Q7).** The two live user tokens keep working through the cutover; collector 0.5.0 migrates its v2
  config to v3 (ADR-0030), drops company-token entries with a message and re-binds queued streams. 0.4.0 is withdrawn
  from the publish queue; `MIN_COLLECTOR_VERSION` becomes 0.5.0 only after the rollout.

## Consequences

- Every turn is attributed to a real (person or service) user; "unverified" and "matched" disappear from new data.
- Developers re-run `ai-obs login` every 90 days for device tokens; a manual token can be made longer-lived (or
  non-expiring) at the cost of being a long-lived secret.
- Two new public endpoints, protected by rate limits, a server-wide cap on open codes and short-lived, hashed codes. The
  approval page shows the requester IP so a user can spot a code that is not theirs.
- CI and shared machines need an admin to create a service user; there is no self-service bulk rollout token any more.
- Leads lose the tokens page.
- Old 0.2.x / 0.3.x collectors keep working with a carried-over user token until it expires; they cannot do device
  login and do not read dot files.

## Alternatives considered

- **Keep company tokens for CI** with git-e-mail matching: spoofable attribution and a second token model; replaced by
  service users (Q9).
- **OAuth with refresh tokens for the CLI:** more moving parts and a long-lived refresh secret on disk; out of scope,
  the 90-day re-login matches spoor.
- **Sliding expiry** (extend on use): a stolen token on an active machine would never expire; rejected for spoor parity
  (Q6).
- **Revoke every token at the cutover** (ADR-0022's clean break): forces both live users to re-register for no security
  gain, since both tokens are already user tokens (Q7).
- **Device routes per team or per company:** the server has one company; global routes keep the CLI simple.
