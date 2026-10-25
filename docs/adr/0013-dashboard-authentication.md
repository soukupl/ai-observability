---
spoor_id: ba4eefef-d426-4ef5-86c4-88649fa6b844
---
# ADR-0013: Dashboard login via magic link and Google/GitHub OAuth

- **Status:** Accepted; amended 2026-10-24 by [ADR-0028](0028-one-deployment-one-company.md) (bootstrap by `ADMIN_EMAILS` /
  `ALLOWED_EMAIL_DOMAINS`, invitations auto-accepted, no sign-up, no super admin)
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** security, auth

## Context

Users range from solo developers to companies that will eventually require SSO.

## Decision

We will offer **magic-link e-mail** and **Google / GitHub OAuth** in v1, with no passwords. Company
admins invite users by e-mail; invitations place users into the right company and team on first login.
The schema reserves `identity_providers` per company so SAML/OIDC SSO and SCIM can be added later.

## Consequences

- No password storage, resets or breach exposure; fast onboarding.
- Depends on e-mail deliverability for magic links.
- Larger companies wait for SSO (roadmap, Business plan).

## Alternatives considered

- **Email + password (+ TOTP)** — more security surface to maintain.
- **SSO in v1** — significant effort before product fit is proven.

## Amendment 2026-10-06 — explicit invitation consent; SUPER_ADMIN_EMAILS is the authority

- **Decided by:** Claude (review-fix integration, 2026-10-06), from the security / data-correctness review of the MVP build. **Owner confirmation pending.**

- **Invitations are never auto-accepted (SEC-1).** Logging in with an e-mail that has no user used to join the
  newest pending invitation for it, so anyone able to invite an address (a look-alike company on the Free plan)
  could capture the person's account. Now a new e-mail goes to `/signup`, which lists every pending invitation
  (company, who invited, team, role) with one "Join <company>" button each, next to the solo-workspace form.
  The DB accepts only the picked invitation (`auth_accept_invitation(email, name, invitation_id)`), only for that
  e-mail, only while pending, unexpired and for an active company, and refuses a company that is already at its plan
  user limit (the limit is also checked at accept time, not only when inviting). The old "newest wins" function is dropped.
- **`SUPER_ADMIN_EMAILS` is the source of truth (SEC-5).** Super-admin rights need both the `users.is_super_admin`
  flag and the e-mail still being listed in `SUPER_ADMIN_EMAILS`, checked at login and on every request. Removing an
  address ends that person's super-admin sessions at once; re-listing restores access. The DB flag alone is not enough.
- **Client IP for rate limits (SEC-8).** The address added by our own proxy is used (`TRUSTED_PROXY_HOPS`, default 1),
  not the client-controlled first `X-Forwarded-For` entry. Without a proxy in front the headers are still client-controlled;
  the per-e-mail limit is the backstop.
- **Consequences.** One extra click for invited users; an attacker's invitation now needs the victim's consent and shows
  who sent it. A deployment must list its operators in `SUPER_ADMIN_EMAILS` and keep the list current.

## Amendment 2026-10-08 — one login, many companies (ADR-0022)

- **Decided by:** Ladislav Soukup (owner, grilling Q1 and Q6 of 2026-10-08); details by Claude.

- An invitation to an existing e-mail adds a **membership**; the invitee accepts it at `/invitations` (the e-mail links to
  `/login?next=/invitations`). New e-mails still pick it on `/signup`. Signing up with an existing e-mail logs in.
- A user with no membership goes back to the sign-up step; one whose companies are all suspended gets an invitations-only
  sign-up step when invited.
- The session carries `auth_sessions.active_company_id` (validated on every request; the header switcher changes it). The
  last active company is `company_memberships.last_active_at`, so login lands where the user last was.
- Plan limits count memberships. Consent (SEC-1) is unchanged: nothing is accepted automatically.

## Amendment 2026-10-24 — bootstrap and auto-accepted invitations (ADR-0028)

- **Decided by:** Ladislav Soukup (owner, grilling Q1-Q9 of 2026-10-24 and "go" on
  `docs/briefs/single-deployment-per-user-tokens.md`); design by Claude Fable 5.1. The body and earlier amendments are kept as history.

- **`ADMIN_EMAILS`** replaces `SUPER_ADMIN_EMAILS`: a listed e-mail becomes admin at its first login. An unknown e-mail
  becomes a member if it has a pending invitation or its verified domain is in **`ALLOWED_EMAIL_DOMAINS`** (empty by
  default); otherwise login is refused with a page asking to get an invitation. There is no sign-up and no solo workspace.
- **Invitations are auto-accepted** at the first magic-link or OAuth login, with a one-time notice naming the
  deployment's visibility mode; `/invitations` goes. SEC-1 guarded against a look-alike company, which cannot exist with
  one company per deployment.
- SEC-5 (super-admin rights tied to the env list) is moot: the super admin is gone. SEC-8 (client IP) is unchanged and now
  also applies to the public device-login routes ([ADR-0029](0029-per-user-tokens-device-login-expiry.md)).
- `identity_providers` is dropped; SSO / SAML / SCIM stay out of scope. The active company on the session and the switcher
  are gone. Magic link and Google / GitHub OAuth are unchanged.
