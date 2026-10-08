# Brief: one developer, many companies — company / user tokens and per-project token choice

Status: **Accepted 2026-10-08** (owner: "yes, go!"). Owner: "I need to be able to be part of multiple companies as a
developer and multiple teams… token will be always generated on company level and/or user level… per-project
overwrite… allow user to register multiple tokens for multiple companies and select what token should be used for a
specific project. AI harness can ask him, if there is no token selected for the project yet."

Decisions below were taken by the owner in the grilling of 2026-10-08 (Q1–Q9); defaults marked *(assumed)* are
Claude's and are open for review.

## Goal

A developer with one login can belong to several companies (and several teams in each), register one collector
token per company on a machine, and have every repo report to the right company — chosen once per repo, with the
AI harness prompting for the choice when it is missing. Nothing is ever sent to the wrong company.

## Decisions

| # | Decision | Owner answer |
|---|---|---|
| Q1 | **One login, many companies.** A user account holds memberships in several companies; the dashboard gets a company switcher. | A |
| Q2 | **Token kinds: company + user, no team binding.** Company tokens (`aiobs_c_`) for bots / CI / rollout, match users by git e-mail company-wide. User tokens (`aiobs_u_`) identify the user in one company. Team tokens are dropped. Team attribution: project → team mapping, else the user's primary team in that company. | A |
| Q3 | **Hold until assigned.** With ≥ 2 registered tokens, an unassigned project's events stay in the local queue and are sent only after assignment. With one token nothing changes. | B |
| Q4 | **Assignment key = normalized git remote, else repo top-level path** (same rule as the project key, ADR-0008). Stored locally, never sent. | A |
| Q5 | **Server-provided labels, endpoint per token.** The collector-config endpoint returns company name + slug and (user token) the e-mail; the token is stored under the company slug (`--name` overrides). | A |
| Q6 | **`company_memberships` table, active company on the session.** `users` keeps identity only. Invitations to an existing e-mail add a membership; sign-up with an existing e-mail logs in. Removal from a company revokes the user's tokens there. | A |
| Q7 | **Clean break.** Migration revokes every existing token; everyone re-runs `ai-obs init`. No legacy prefix. | C |
| Q8 | **SessionStart context, once per session until assigned.** Hook returns `additionalContext` naming the project key, the registered token names and the `ai-obs use <name>` instruction. No "default token" when ≥ 2 are registered. Also shown by `ai-obs status` / `doctor`. | A |
| Q9 | **Company tokens: admins and leads.** User tokens: everyone, own only. | B |

## In scope

### Server (apps/web, packages/db, apps/worker)

- Schema: `company_memberships (company_id, user_id, company_role, primary_team_id, created_at)`, unique
  `(company_id, user_id)`; drop `users.company_id / company_role / primary_team_id`; `auth_sessions.active_company_id`;
  `ingest_tokens.kind ∈ {company, user}`, `team_id` dropped, CHECK `(kind='user') = (user_id is not null)`;
  `team_memberships` FK to `company_memberships` (a team member must be a company member). Migration revokes all
  existing tokens (`revoked_at = now()`), moves each user's company into a membership, sets `active_company_id`.
- RLS / DB roles: context from the membership of `app.user_id` in `app.company_id`; `lookup_ingest_token` returns
  company + user + primary team (no team); `ingest_match_user_by_email(email, company_id)`; policies that read
  `users.company_id` rewritten; RLS tests updated.
- Auth: `getCurrentUser()` → identity + memberships + active company; switcher in the header (sets
  `active_company_id`); magic link / OAuth: existing e-mail → login into last active company; invitation accept →
  add membership (and team membership) or create user; solo sign-up unchanged. Super admin unchanged (no memberships).
- Admin: tokens page creates **company** tokens (admin + lead), lists company tokens; "My tokens" creates user
  tokens in the active company; members / invitations / teams work per active company; removing a company member
  deletes their team memberships and revokes their user tokens in that company. Plan limits count memberships.
- Collector-config endpoint adds `company: {name, slug}` and `user: {email} | null`.
- Ingest: attribution = user token → verified; company token + git e-mail of a company member → matched; else
  unverified. Team = project mapping → primary team of the (resolved) user in that company → null.
- Seed: the demo user `alice@…` is also a member of a second demo company ("Globex", Free plan, one team) so the
  switcher has something to show *(assumed)*; `scripts/dev-token.ts` prints a user token for the active company.
- Worker: budgets / runaway / retention read memberships where they read `users.company_id`.

### Collector (packages/collector)

- `~/.ai-obs/config.json`: `tokens: [{name, company: {name, slug}, email?, endpoint, token, added_at}]`;
  `endpoint` stays as the default for `token add`; `machine_id`, `git_email` unchanged. `~/.ai-obs/projects.json`:
  `{ "<project key>": {token: <name>, assigned_at} }` (mode 0600).
- Commands: `init --token T [--endpoint U] [--name N]` registers / replaces the token for that company (same slug ⇒
  replace) and installs hooks as today; `token add` (same options, no hook install), `token list`, `token remove
  <name>`; `use <name> [--project-dir d]` assigns the current repo; `use --clear`; `status` / `doctor` show tokens,
  per-project assignment and "N projects waiting for a token".
- Queue / sender: each queued batch carries the project key; the sender groups by resolved token (endpoint + token)
  and skips held projects; held batches are exempt from the 30-day age cap while unassigned *(assumed)*, still
  subject to the size cap.
- Hook: `hook <harness> SessionStart` resolves the project key from `cwd` (local git calls only, no network), and when
  ≥ 2 tokens are registered and the key is unassigned, prints
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`. Codex: same if Codex hooks
  support context output; otherwise CLI-only for Codex (fact to verify in design).
- `collector-config` cache becomes per token.

### Docs

- ADR-0022 (company memberships, token kinds, per-project token choice; supersedes parts of ADR-0007 and amends
  BRIEF §4 table + §5.1), ARCHITECTURE.md (identity, token, collector files), README + packages/collector/README
  (install flow, commands), apps/web README (demo users), BRIEF.md row 7 / 8.

## Out of scope

- Per-team user tokens, team tokens, legacy prefixes.
- Committing the company choice into the repo; MDM config for user tokens (company-token MDM JSON stays).
- SSO, cross-company reporting, moving historic turns between companies.
- Any UI beyond the switcher + token pages needed to exercise the feature.

## Constraints

- RLS stays the enforcement point; super admin keeps no telemetry access.
- Hook budget < 100 ms, never fails the harness, never touches the network.
- Zero-dependency collector; tokens only in `~/.ai-obs` (0600).
- Clean-break migration is acceptable (owner Q7); seed and Docker demo must come up fresh.

## Definition of done

- A user invited to a second company logs in once, switches companies in the header, and sees only that company's
  data (RLS test).
- `ai-obs init` with a token from company A, then `ai-obs token add` with company B: a session in an unassigned repo
  injects the nudge; `ai-obs use b` sends the held events to B and nothing to A (collector tests).
- With one registered token behaviour is unchanged (existing collector tests pass).
- Company token + git e-mail of a company member ⇒ `matched`; non-member ⇒ `unverified` (ingest tests).
- `pnpm test`, `pnpm lint`, `pnpm typecheck` green; docs and ADR updated in the same change.

## Resolved during the build (2026-10-08, Claude's calls under the brief; owner review welcome)

Server design (`docs/adr/0022` records the detail):

- **Removing a member keeps their telemetry** in that company (shown as "former member"); only their team memberships,
  budgets and tokens go. Deletion would be irreversible and the brief did not ask for it.
- **Admins still see and can revoke every token** in the company, user tokens included (as before Q9, which settled
  creation only). Leads see and revoke company tokens.
- **Company tokens follow the right to mint them:** the company tokens a person created are revoked when they leave
  the company or stop being an admin or a lead there, and a company token resolves only while its creator still has
  that right.
- **`pnpm lint`** is "not applicable": the repo has no lint script. Not added in this change.

Collector design:

- **`ai-obs use --none`** marks a repo as belonging to no company (stops the nudge, keeps queued data).
- **Re-assigning a repo** moves only data recorded while it had no choice; data already recorded under another
  token stays there unless `ai-obs use <name> --move-queued` is given.
- **Pre-upgrade queue** (batches written by the 0.1.x collector) is never sent: the first `init` / `token add` moves
  it to `queue/dead/pre-upgrade/` and `status` / `doctor` say so. Tokens were reset (Q7), so no token can claim it.
- **Hook budget** counts in-process time from hook entry; git runs only early in the budget and is capped at 40 ms.
