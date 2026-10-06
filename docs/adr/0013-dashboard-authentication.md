# ADR-0013: Dashboard login via magic link and Google/GitHub OAuth

- **Status:** Accepted
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
