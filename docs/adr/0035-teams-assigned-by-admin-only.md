---
spoor_id: 04fbed1d-f16b-464a-8c22-0093a1260264
---
# ADR-0035: A project's team is set by an admin on the server, never by the collector

- **Status:** Accepted. Amends [ADR-0030](0030-project-dot-file-and-team-resolution.md) (Q4 team part, R1 step 2, R2,
  D1, D3, D6 warning, D7 warning; R4 slugs stay)
- **Date:** 2026-10-25
- **Deciders:** Ladislav Soukup (owner: "lets tweak the CLI so the teams are only assigned to project server side by
  admin", 2026-10-25; then chose: the server ignores `project.team` from older collectors too, unmapped projects use the
  user's primary team, a leftover `team` key is ignored and named by `status` / `doctor`); implementation by Claude Opus 5.5
- **Tags:** collector, protocol, ingest, admin
- **Related:** [ADR-0029](0029-per-user-tokens-device-login-expiry.md)

## Context

ADR-0030 let a repository name its team in the committed `.ai-obs.json` (`ai-obs link --team <slug>`). The server
checked that the user belongs to that team, used it when the admin had not mapped the project, and otherwise answered
with a `team_not_member` / `team_unknown` warning that the collector stored and showed in `status`, `doctor` and the
SessionStart nudge. In practice, which team a project belongs to is a decision for the company, not for whoever commits
the dot file. Admins already map projects to teams under Admin → Projects, and that mapping already won.

## Decision

- **Team resolution per session, at `session_start`:** the admin's project → team mapping (`projects.team_id`), else the
  user's primary team, else no team. The pinning rules of ADR-0030 stay: the first `session_start` with a project pins
  the team, and turns that arrived earlier are back-filled.
- **The collector never sends a team.** `session_start.project.team` is no longer sent, including for streams queued
  with one by 0.5.x. The **server ignores the field** when an older collector still sends it. The protocol schema keeps
  the field, and the `warnings` of the ingest response, as optional so old peers keep validating. Servers no longer
  produce warnings, and the collector no longer reads them (`state/warnings.json` is gone).
- **The dot file names only the server.** `ai-obs link [--server <url>] [--local]` writes `{ "server": … }` and removes a
  leftover `team` key. `--team` fails with a message that points to the admin. A `team` key in an existing dot file is
  ignored, not treated as malformed. `status` / `doctor` say it is ignored, and show how the team is set: "set on the
  server by an admin (project mapping), else your primary team (<slug>)".
- **The queue keeps the stream-key shape** `(project key, server endpoint, team)` from ADR-0030 D4, so streams that
  0.5.x queued still parse. New streams always have team `""`.
- The SessionStart nudge loses its team-warning case. With it, the bounded git call that the hook made only to look up
  that warning is gone too, so the hook makes no git call.
- Team slugs stay (R4). They identify teams in collector-config, so `login` and `doctor` can list "your teams". The
  slug-immutability trigger stays. The DB functions `ingest_team_status` / `ingest_resolve_team` are now unused by ingest
  and are left in place, so that this change needs no migration.

## Consequences

- One place decides a project's team: the admin. A committer can no longer move a project's turns to another team, and
  nobody has to keep the dot file's team in sync with the admin's view.
- An unmapped project reports to each person's own primary team, so turns in the same repository can land in different
  teams until an admin maps the project. That was already the behaviour without a dot file.
- Repositories that committed a `team` key keep working. The key is ignored, and `status` / `doctor` say so.
  `ai-obs link` removes it.
- Collectors from before this ADR still send `project.team`. The server ignores it and returns no warning, so their
  last stored warning simply stays in `status` until they upgrade.
- The hook got simpler and has no git call left.

## Alternatives considered

- **Only the CLI stops sending the team:** old collectors could still pick a team. Rejected by the owner.
- **Unmapped projects get no team:** strictly admin-only, but every new repository would drop out of team views and team
  budgets until an admin acts. Rejected by the owner in favour of the primary team.
- **Treat a `team` key as malformed:** that would make the whole dot file count as absent, and so drop the server
  choice of every repository that committed one. Rejected.
- **Drop the team from the stream key and re-hash the queue directories:** cleaner, but it would need a queue migration
  for no behavioural gain. Rejected.
