# Brief: skill and MCP usage stats

Status: **Accepted 2026-10-07** (owner approved the brief). Decisions come from the owner's answers on 2026-10-06.
Extends [BRIEF.md](../../BRIEF.md) §5.3 (what is measured) and §8 (dashboard).

## Goal

Show which skills and MCP servers / tools developers actually use: how often, in which turns, by whom
(within the visibility rules), and whether the model picks a skill up on its own or the user has to ask.

## Today

- `turns.tools` / `runs.tools` hold call counts per tool name. Every `mcp__<server>__<tool>` is collapsed to
  `mcp` on the machine (`packages/collector/src/events.ts` `toolKey`). Skill calls count as `skill`, and the
  skill name is dropped. Skills that the user types as `/name` are not counted.
- Tool counts appear only on turn detail. They have no rollup and no aggregate view.

## Decisions (owner, 2026-10-06)

1. **Name privacy follows the company's project-naming mode.** `plain` sends names. `hashed` sends salted
   `sha256:` hashes made on the machine with the company's `project_salt` (the same mechanism as project keys).
   No new setting.
2. **MCP detail: server + tool.** Counts are kept per server and per tool.
3. **Skills: both sources, split.** The two sources are `model` (the Skill tool call) and `user` (a typed `/skill`
   slash command). Built-in commands (`/clear`, `/model`, `/compact`, …) are not skills and are not counted.
4. **Dashboard: a new view, "Skills & MCP".** It shows top skills (uses, model/user split, turns, users) and top
   MCP servers that expand into their tools, plus a chart of usage over time. It uses the global filters, and
   turn detail lists the turn's skills and MCP calls. A new daily rollup keeps long ranges fast.

## In scope

- **Protocol (schema v1, additive, optional fields):** `turn` and `run` events get
  `skills: { <name>: { model, user } }` and `mcp: { <server>: { <tool>: count } }`. Older collectors omit both
  fields, and older events show no skill or MCP data. The existing `tools` map is unchanged (`mcp` and `skill`
  stay as totals).
- **Collector:** the Claude Code and Codex adapters extract the names, apply the naming mode and enforce key and
  size limits. Codex MCP comes from the `namespace: "mcp__<server>"` field. Codex skills are counted only if
  rollouts record them. Each adapter's FORMAT.md is updated.
- **Ingest:** wire schema plus server-side limits (key length, entry counts) and storage in new jsonb columns on
  `turns` / `runs`.
- **DB + worker:** a migration with new columns and a daily rollup table for skills / MCP, keyed the same way as
  `daily_rollups`, with RLS and `agg_*` functions. The table follows the existing retention and anonymization
  rules.
- **Dashboard:** the new view, the turn-detail section and the CSV export. Per-user columns obey the
  individual-visibility mode (aggregates-only means no user breakdown).
- **Docs:** an ADR that supersedes the "MCP collapses to `mcp`" privacy rule, BRIEF §5.3 / §8,
  ARCHITECTURE (domain terms *Skill use* and *MCP call*), and the collector and web READMEs.

## Out of scope

- MCP call latency, errors or payloads. Skill content or arguments.
- Plugin attribution (which plugin a skill came from), unless it falls out of the skill name (`plugin:skill`).
- Back-filling turns that are already stored.
- Budgets or alerts on skill / MCP usage.

## Open items to settle while building

- The exact transcript markers: the Skill tool's input field, how a typed `/skill` is told apart from a
  built-in command (expected: an `isMeta` skill expansion follows it), and whether Codex rollouts record skills.
  These are verified against real transcripts and fixtures.
- Hashed mode shows hashes in the view. That is the same trade-off as hashed projects.

## Done when

- Fixture tests cover both adapters (plain and hashed, model and user skills, MCP server/tool), plus protocol
  conformance, ingest limits, the RLS / aggregate-visibility tests for the new table and the rollup job.
- A live Claude Code session against the local stack shows real skills and MCP calls in the new view and on
  turn detail.
- All existing gates are green (typecheck, lint, tests, Docker build), and docs and the ADR are updated.
