# ADR-0016: Record skill and MCP usage by name, following the project-naming mode

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** Ladislav Soukup (owner, 2026-10-06/07: naming, detail, skill sources, dashboard); implementation details by Claude
- **Tags:** privacy, ingest, collector, dashboard
- **Brief:** [docs/briefs/skills-and-mcp-stats.md](../briefs/skills-and-mcp-stats.md)

## Context

Teams want to know which skills and MCP servers their developers actually use. Before this ADR, the collector
counted tool calls by tool name but folded every `mcp__<server>__<tool>` call into one `mcp` count on the machine,
because server and tool names can be internal (e.g. a private `billing-db` server). The `Skill` tool counted as
`skill`, and the skill's name was dropped. Skills that the user typed as `/name` were not counted at all.
ADR-0008 already has a per-company answer to "names may be internal": the project-naming mode.

## Decision

- **Names follow the company's project-naming mode.** In `plain` mode, skill, MCP server and MCP tool names are
  sent as they are. In `hashed` mode, the collector sends `sha256:` + HMAC-SHA256 under the company's
  `project_salt`, computed on the machine before anything reaches the queue (`ctx.queue`, `applyUsageNaming`). Without
  a salt it sends plain SHA-256. The hash inputs are namespaced: `skill:<name>`, `mcp:<server>`, `mcp:<server>/<tool>`.
  If a plain name arrives in hashed mode anyway (a stale config or a third-party collector), ingest hashes it the
  unsalted way, so the name is never stored. No new setting.
- **MCP detail: server and tool.** `mcp: { <server>: { <tool>: calls } }` on `turn` and `run` events.
- **Skills: both sources, kept apart.** `skills: { <name>: { model, user } }`. `model` counts the Claude Code `Skill`
  tool, or a Codex shell command that reads a skill's `SKILL.md`. `user` counts a typed `/name` in Claude Code that
  Claude Code expands into the skill's body (a meta entry without `sourceToolUseID`). Built-in commands (`/model`,
  `/compact`, …) have no expansion and are not counted.
- **Wire format:** both fields are optional additions to schema v1 (ADR-0005). There are at most 100 skills,
  50 servers and 100 tools per server per event, names up to 128 characters, no whitespace. Ingest bounds each
  count at 1,000,000.
- **Storage:** `turns.skills` / `turns.mcp` and `runs.skills` / `runs.mcp` (jsonb). A new `daily_skill_mcp_rollups`
  table is written by the worker in the same slice transaction as `daily_rollups`, with the same rules: no unique
  key, anonymised rows kept, append mode for expired days (ADR-0012). It has one row per day × team × user ×
  project × harness × primary model × kind × name × tool. An MCP server has a total row (`tool = ''`), so
  distinct-turn counts stay exact.
- **Dashboard:** a new **Skills & MCP** view, the turn-detail section and a CSV export. A turn and its runs count
  together. Leads and admins in aggregates-only mode read through `agg_skill_mcp` / `agg_skill_mcp_rollups`, which
  return a distinct user count but never `user_id`. Members see only their own use.

## Consequences

- Plain-mode companies see real skill and server names; hashed-mode companies see hashes (the same trade-off as
  hashed projects).
- Turns sent before this change, or by older collectors, carry no skill or MCP data. Nothing is back-filled.
- Typed skills are detected from Claude Code's transcript format. If Claude Code changes how it writes the
  expansion, typed skills stop being counted (fixtures in `packages/collector/test/claude-code/usage.test.ts`
  pin the format). Codex has no typed-skill marker, so Codex reports only `model` uses, and a command that merely
  `cat`s a SKILL.md counts as a use.
- The existing `tools` map is unchanged (`mcp` and `skill` stay as totals), so old views keep their meaning.

## Alternatives considered

- **A separate "tool naming" company setting:** more control, but one more privacy knob to explain. Rejected by the
  owner in favour of reusing project naming.
- **Always plain names:** simplest and most useful, but it drops the privacy guarantee for companies that chose
  hashing.
- **MCP server only, no tool:** less exposure, but it cannot tell which tools are really used.
- **Model-invoked skills only:** easier to parse, but it misses the "user had to ask" signal the owner wanted.

## Amendment 2026-10-07: MCP reliability (errors, denials, latency)

- **Decided by:** owner (brief [mcp-reliability](../briefs/mcp-reliability.md) accepted with "go, implement", 2026-10-07); details by Claude.
- New optional `mcp_stats` on turn and run events: `{server: {tool: {errors, denied, ms, buckets[5]}}}`. The
  buckets are < 1 s, 1–5 s, 5–30 s, 30–120 s, > 120 s. Names are hashed like `mcp`. Error texts and payloads are
  never sent.
- Claude Code: each `mcp__…` tool_use is paired with its tool_result. `is_error` counts as an error, latency is
  result time minus call time, and a refused call (Claude Code's rejection / denial text) counts as `denied`, not
  as an error and not as latency.
- Codex: the `item_completed` `McpToolCall` record gives `status` / `result.isError` and an exact `duration`. Codex
  has no denial marker.
- Storage: `turns.mcp_stats` / `runs.mcp_stats` and the counters `errors`, `denied`, `latency_ms`, `lat0`…`lat4` on
  `daily_skill_mcp_rollups` MCP rows (migration 0009). The view shows the error rate (errors / calls not refused)
  and the bucket of the median / p95. Tools with ≥ 10 % errors over ≥ 20 calls are highlighted.
