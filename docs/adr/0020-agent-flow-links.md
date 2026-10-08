# ADR-0020: Agent flow — stage index, flow key and typed links between sub-agent runs

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** Ladislav Soukup (owner: chain plan / implementation / verification sub-agents and visualise the flow;
  label convention `<stage>:<item>` accepted, 2026-10-08); field shapes, link rules and the flow card by Claude
- **Tags:** protocol, schema, collector, dashboard
- **Brief:** [agent-flow](../briefs/agent-flow.md)

## Context

The timeline (ADR-0019) shows when sub-agents ran, not how work moved between them. The harness never records which
agent's result fed which call; it records phase order for Workflow runs, labels, and the spawn order of Agent-tool
agents. The owner labels workflow agents `<stage>:<item>`, which names the chain explicitly without reading prompts
(ADR-0001 forbids reading prompt content).

## Decision

- **Run event (v1, additive):** `stage_index` (int ≥ 0), `flow_key` (≤ 128, the slugged `<item>`), `links`
  (≤ 32 × `{ from_run_id, kind: 'item' | 'sequence' }`, incoming edges on the target run).
- **Collector rules:** `item` = same orchestration + same `flow_key`, chained in start order; `sequence` = same parent,
  no orchestration, link to the latest sibling that ended before this run started (ties on the end: greater run id;
  of two siblings that start at the same instant only the lower run id can lead, so zero-length runs never link both
  ways). A run's links use the runs of its turn known when it is sent (the collector keeps their spans and the links each was sent with); a sent run whose incoming links change when a later-finishing run arrives (links follow start order, not finish order) is re-sent under a new event id. `stage_index` = order of first
  appearance of the phase in the workflow journal. Codex: none.
- **Schema:** `runs.stage_index`, `runs.flow_key`; `run_links` with company, turn (uuid + external id), from / to run
  (uuid resolved late + external ids), `kind`; unique per company × turn × from × to × kind. RLS: a link is visible
  when its target run is (`EXISTS` on `runs`, so the runs policies decide). `app_ingest` replaces the target run's
  incoming links on every run event. Aggregate functions `agg_turn_links(turn)` and `agg_timeline_links(window…)`
  for aggregates-only readers; `agg_turn_runs` / `agg_timeline_runs` gain `stage_index`, `flow_key` (appended), `agg_turn_runs` also `orchestration_id` so the aggregate turn path lays out workflow lanes like the raw one.
- **Read-time derivation:** `sequence` links are computed on read for Agent-tool runs without stored incoming links,
  so old data gets chains; `item` links are stored only.
- **Dashboard:** "Agent flow" card (Agents page, same window as the timeline; turn detail): lanes per orchestration /
  per turn's direct spawns, stage rows, time on x, pills per agent coloured by group, arrows per link, chain highlight
  on hover.

## Consequences

- Migration `0012_run_links.sql`; protocol fixtures and conformance tests; collector tests for both rules.
- The label convention is a soft contract: agents without `<stage>:<item>` labels get phase rows but no `item` edges.
- Links are intra-turn by construction (every sub-agent of a turn, workflow agents included, belongs to the turn that
  launched it), so no cross-turn joins are needed.

## Amendment 2026-10-08: the "Agent flows" view and the flow definition

- **Decided by:** owner ("create a new section Agent flows … list full flows (more than one step) with detail page",
  2026-10-08); definitions by Claude ([brief](../briefs/agent-flows-view.md)).
- A **flow** is a set of ≥ 2 sub-agent runs of one turn: one Workflow-tool run (`orchestration_id`), all legacy
  `workflow:*` runs of a turn (pre-ADR-0019 data), or a connected component of Agent-tool runs over `sequence` / `item`
  links. Steps are runs; stages come from `stage_index` or the agent-group fallback. Flow outcome is the worst step
  outcome; ≈ cost sums per-step costs at the run's primary model price.
- New view `/flows` (list, CSV) and `/flows/<turnId>/<key>` (detail), read from raw runs (`agg_flow_runs` in
  aggregates-only mode, migration 0013). Flows are computed in the query layer, not stored.
