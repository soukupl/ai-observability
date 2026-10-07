# Brief: MCP reliability (errors and latency per tool)

Status: **Accepted 2026-10-07**. Owner: "go, implement", which accepts the recommended defaults below. Builds on [skills-and-mcp-stats.md](skills-and-mcp-stats.md) (ADR-0016).

## Goal

Show which MCP servers and tools fail or are slow: error rate and latency (median, p95) per server × tool. That
tells a team which integrations to fix, replace or remove.

## Today

- The collector counts MCP calls per server × tool (`mcp: {server: {tool: calls}}`). Errors and timing were left out
  of the skills/MCP brief.
- The data exists locally. Claude Code tool results carry `is_error`, and both the `tool_use` and the `tool_result`
  entries have timestamps. Codex has `function_call` / `function_call_output` with timestamps, and MCP errors show up
  in the output payload (the exact shape needs checking against real rollouts).

## Decisions to confirm (recommended defaults)

1. **What counts as an error:** the harness marks the call as failed (`is_error: true` in Claude Code; an error result
   in Codex). This includes a call the user refused at the permission prompt. We count refused calls separately as
   `denied` where the transcript shows it, because a denial is not an integration failure.
2. **Latency:** wall time from the tool call to its result, per call. The collector sends per server × tool the call
   count, error count, denied count, total ms and a coarse latency histogram (fixed buckets: < 1 s, 1–5 s, 5–30 s,
   30–120 s, > 120 s). The buckets give an approximate p95 on long ranges without storing every call.
3. **Wire format:** a new optional field `mcp_stats: {server: {tool: {errors, denied, ms, buckets[5]}}}` next to the
   existing `mcp` counts. It's additive to schema v1 (ADR-0005), and names are hashed the same way (ADR-0016).
   Error messages and payloads are never sent.
4. **Storage:** jsonb on turns and runs. `daily_skill_mcp_rollups` MCP rows gain `errors`, `denied`, `ms` and
   bucket columns.
5. **Dashboard:** the Skills & MCP server list gets error-rate and median / p95 latency columns per server and tool.
   We highlight tools whose error rate is ≥ 10 % with ≥ 20 calls in the range.

## In scope

- Collector: both adapters pair each MCP call with its result and measure the time between them. A call still open
  at turn end counts as "no result" (neither error nor latency).
- Protocol, ingest limits, migration, worker fold, query layer and view, CSV, ADR (amendment to ADR-0016 or a new one).
- FORMAT.md notes for the Claude Code and Codex error markers, verified against real transcripts.

## Out of scope

- Error messages or categories (they could leak internal data); per-call drill-down.
- Alerts on MCP error rates (could reuse the runaway-alert channel later).
- Latency of non-MCP tools.

## Open questions

- Should denied calls count as errors on the dashboard? Recommended: show them, but keep them out of the error rate.
- Should parallel MCP calls (several `tool_use` blocks in one response) be timed separately? Recommended: yes. Each
  call has its own `tool_use_id`.

## Done when

- Fixture tests cover both adapters: error, denied, latency buckets, an open call at turn end, and hashed names.
- A live Claude Code session with a deliberately failing MCP call shows the error on the view.
- Raw and rollup paths agree. Docs and the ADR are updated.
