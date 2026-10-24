---
spoor_id: 33662462-0b21-4623-89b5-c00bf4c43555
---
# ADR-0030: Project dot file and team resolution

- **Status:** Accepted. Replaces the collector design of [ADR-0022](0022-company-memberships-and-token-kinds.md)
  (Q3, Q4 assignment, Q8, routing tables A and B, C1-C27 except those listed under "What survives of C1-C27"); amends
  [ADR-0011](0011-local-queue-idempotent-delivery.md) (stream key)
- **Date:** 2026-10-24
- **Deciders:** Ladislav Soukup (owner: grilling Q1-Q9 of 2026-10-24 and "go" on
  `docs/briefs/single-deployment-per-user-tokens.md`); design by Claude Fable 5.1 within the brief
- **Tags:** collector, protocol, ingest, privacy, security
- **Brief:** [single-deployment-per-user-tokens](../briefs/single-deployment-per-user-tokens.md) (Appendix C, D, E)
- **Related:** [ADR-0028](0028-one-deployment-one-company.md), [ADR-0029](0029-per-user-tokens-device-login-expiry.md)

## Context

Under ADR-0022 a machine held one token per company and the developer chose per repository, locally, which token a
project used (`ai-obs use`, `~/.ai-obs/projects.json`); with two or more tokens an unassigned project's events were held
until the choice was made, driven by routing epochs, open / token-bound streams and a SessionStart question. The team of a
turn was the admin's project mapping, else the user's primary team, so a developer in two teams could not say which one a
repository belonged to.

With one company per deployment (ADR-0028) and per-user tokens (ADR-0029), "which company" becomes "which server", and
the useful per-project choice is the team. The owner: "team selection will be per-project based on dot file with
config … User still can bind multiple projects to multiple 'companies' — in this case remote servers."

## Decision

### Owner decisions (grilling of 2026-10-24)

| # | Decision | Owner answer |
|---|---|---|
| Q4 | **Committed `.ai-obs.json` with server URL and team slug**, optional git-ignored `.ai-obs.local.json` overriding either. Tokens never go in either file. The collector sends only to servers it holds a token for. `projects.json`, `ai-obs use` and hold-until-assigned go away. | Committed, server + team, local override |
| Q5 | **The admin's project → team mapping always wins.** The dot-file team fills in projects that are not mapped. | Admin mapping wins |

### Architect defaults (Claude, within the brief; open for review)

- **R1, the dot-file team is membership-checked** on the server. Team resolution per session, at `session_start`
  (later events of the session reuse it; the team is pinned by the first `session_start` that carries a project, and a
  later `session_start` of the same session keeps the stored project and team, so one session's turns never split across
  teams; turns that arrived before it, with no project, are back-filled):
  1. the admin's project → team mapping (`projects.team_id`) if set;
  2. else `project.team` if the user is a member of that team, checked by `ingest_team_status(user_id, slug)`
     (`SECURITY DEFINER`, owned by `app_definer`; it also returns the warning reason; `ingest_resolve_team` is the id-only variant kept for the contract); a slug the user is not a member of yields warning
     `team_not_member`, an unknown slug `team_unknown`, and resolution continues with step 3;
  3. else the user's primary team;
  4. else no team.

  The check is in the DB so no token holder can feed a team they do not belong to: `turns.team_id` drives lead visibility
  and team budgets.
- **R2, warnings travel back** in the ingest response: optional `warnings: [{ code: "team_not_member" | "team_unknown",
  team, session_id }]`, at most one per session per batch. Old collectors ignore it. The collector records the latest
  warning per project in `state/warnings.json` and shows it in `status` / `doctor`.
- **R3, no dot file.** With one registered server the collector sends without a team (the server applies mapping →
  primary team → none) and says nothing (resolved 2026-10-24: no nudge and no status hint; `status` / `doctor` only print
  "no .ai-obs.json" as information). With two or more servers it holds that
  repository's stream locally (`held: no-server`) and nudges to run `ai-obs link`; nothing is sent to a guessed server.
- **R4, team identifier.** New `teams.slug`: unique, 1-63 of `a-z0-9-`, generated from the name, editable by admins only
  while no turn references the team (DB trigger `teams_slug_immutable`, error 23514), immutable afterwards (a rename
  changes the display name only). A slug change before the first turn can strand dot files that already name it
  (`team_unknown` warnings).
- **R5, the server rule.** A dot file names a server; the collector sends to it only when `~/.ai-obs/config.json` holds a
  token whose `endpoint` has the same origin. A dot-file server without a token holds the stream and nudges `ai-obs login
  --server <url>`. A committed URL therefore never makes the collector send a token or data to an origin the user has not
  logged in to. Without `server` in the dot file the single registered server is used (two or more: held, as R3).

### Design decisions (Claude, within the brief)

- **D1, wire format (schema version stays 1).** `session_start.project` gains optional `team` (slug): the dot-file team
  in force when the session started. Absent means "no dot file" (or no `team` key in it). `header.identity.git_email`
  stays optional and ignored (ADR-0029).
- **D2, dot files.** `.ai-obs.json` at the git top level, committed: `{ "server": "https://obs.example.com", "team":
  "spectado" }`. `.ai-obs.local.json`, git-ignored, same keys, overrides per key. Both optional; unknown keys ignored; a
  malformed file counts as absent and is reported by `status` / `doctor`. Lookup walks from the working directory up to
  the directory that holds `.git` (first hit wins, no git call), inside the hook budget, cached beside the project-key
  cache.
- **D3, `ai-obs link --team <slug> [--server URL] [--local]`** writes `.ai-obs.json` (or `.ai-obs.local.json`, adding it
  to `.gitignore`), validating the team against the server's collector-config `teams`. It also moves this repository's queued `""` (no server) streams to the linked server and team, and refuses a token-like value in the dot file. `ai-obs login` registers servers
  (ADR-0029); `token list` / `token remove <server>` manage them. `use`, `token confirm` and `projects.json` are deleted.
- **D4, stream key `(project key, server endpoint, team slug | "")`** → `queue/p/s-<id>/` with `stream.json { key,
  endpoint, team }`. A session is pinned to its stream at its first hook; a dot file changed mid-session never retargets
  a running session.
- **D5, config v3** (`~/.ai-obs/config.json`, mode 0600): `{ version: 3, machine_id, created_at, servers: [{ endpoint,
  token, email, deployment { name, slug }, label, expires_at, source, added_at }] }`, one entry per endpoint origin. A
  token is only ever sent to its own endpoint. **Migration from v2** on first load: user-token entries become server
  entries (endpoint kept, `expires_at` unknown until the next collector-config fetch); company-token entries are dropped
  with a logged message; `routing_epochs`, `legacy`, `invalid_tokens`, `prior_fps` are discarded. `projects.json` is no
  longer read and is renamed to `projects.json.v2`. The v2 config is kept as `config.json.v2` (backup). Before anything is converted, an
  older copied hook runtime (`~/.ai-obs/app`) is refreshed, because it would read config v3 as "no token" and drop every hook job. When a
  login switches the account on a server, that server's queued streams are set aside in `queue/set-aside/<ulid>/` (never sent). Every queued `t-<id>` stream, including those of dropped company tokens, becomes an `s-` stream
  of the endpoint it was bound to with team `""` (sent with the user's token if logged in there, else held `no-server`); `o-` streams become `s-` streams of the single server, or stay held (`no-server`) when
  several servers are registered; `queue/dead/pre-upgrade` is untouched. `state/delivery.json` and
  `state/collector-config/<host>.json` are keyed by endpoint host.
- **D6, SessionStart nudge** is reduced to: no dot file with two or more servers; the repository's effective server (dot-file server, else the only registered server) without a token, or
  with an expired / rejected one; a token expiring within 14 days; dropped events; the server ignored the dot-file team (latest ingest warning `team_not_member` / `team_unknown`). Once per session per text (C11).
- **D7, `status` / `doctor`** report per server (deployment, user, token expiry and state) plus "this repository: server,
  team, token state, dot-file validity, latest warning".

### What survives of C1-C27

| Kept | As |
|---|---|
| C2 | Project key unchanged (normalized remote, else git top level, else `realpath(cwd)`; never sent). |
| C3 | Naming at send time with the receiving server's naming mode and salt. |
| C11 | Nudge once per session per text. |
| C12 / C15 | Capture-time pinning: a session's stream is fixed at its first hook (now by dot file and servers, not routing epochs). |
| C13 | Caps (30-day age, 50 MB, drop counters), **amended**: time a server spends blocked by 401 does not count against the 30-day age cap. |
| C16 | No key, no guessing (unresolved stream re-resolved by the sender; no cwd = dropped and logged). |
| C24 | Lock discipline for `login`, `link`, `token remove` (worker.lock for the write phase). |
| C25 | Job files v2. |
| C26 | Bounded git in the hook. |
| C27 | Hook budget = in-process time from hook entry; the dot-file lookup is inside it. |

Gone: C1 (open / token-bound streams, replaced by D4), C4-C10, C14 (per token, now per server implicitly), C17-C23
(routing epochs, `use`, `--none`, `--all-held`, invalid tokens, projects.json), routing tables A and B, the per-company
nudge text. C21's Codex plain-text SessionStart output stays as implemented (a harness fact, not routing).

## Consequences

- A repository's team is visible and reviewable in the repo; teammates who clone it report to the same team without any
  local step, as long as they are members of that team and logged in to that server.
- Admins keep the last word (Q5); a dot file can only choose among the user's own teams.
- A non-member or typo in the dot file does not lose data: the turn falls back to the primary team and the developer sees
  the warning in `status` / `doctor`.
- A developer in several companies runs `ai-obs login --server` once per server and commits (or locally sets) the server
  per repository; with two or more servers a repository without a dot file is held until `ai-obs link`.
- The collector loses its most complex code (routing epochs, assignments, open streams and their hold reasons).
- A committed dot file reveals the server URL and team slug of the repository; neither is a secret.

## Alternatives considered

- **Keep `projects.json` and `ai-obs use`** with a team added: local-only, every developer must repeat it, and it does not
  travel with the repository; rejected (Q4).
- **Dot-file team wins over the admin mapping:** lets any committer move a project's turns between teams; rejected (Q5).
- **Trust the dot-file team without a membership check:** lets a token holder push turns into a team they do not belong to
  (lead visibility, budgets); rejected (R1).
- **Reject batches with an invalid team:** loses data for a typo; fall back with a warning instead (R1, R2).
- **Send a dot-file repository to its server with any token:** would leak a token to an attacker-chosen origin in a
  cloned repository; tokens go only to their own endpoint (R5).
