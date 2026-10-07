# ADR-0019: Agent groups and orchestration ids on runs; git-graph agent timeline

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** Ladislav Soukup (owner: group agent types into logical groups, draw a time / branch graph of main
  thread and sub-agents bound to projects, 2026-10-07); field names, grouping rule and lane model by Claude from the
  brief's recommended defaults
- **Tags:** protocol, schema, dashboard, privacy
- **Brief:** [agent-groups-and-timeline](../briefs/agent-groups-and-timeline.md)

## Context

`runs.agent_type` was the only classification of a sub-agent. Workflow-tool agents carry a per-agent label, so the
Agents view degenerated into hundreds of one-off rows (403 types for 650 runs on the owner's data). The collector
already knew the workflow phase and run id but only in `ext`, which ingest discards (ADR-0005: `ext` is
harness-specific and never stored). The only time view was a per-turn Gantt with no notion of project, session or
parallelism.

## Decision

- **Two optional, harness-neutral fields on the `run` event**, stored as nullable columns: `agent_group` (logical
  kind of agent) and `orchestration_id` (the batch / workflow run that launched it). They are additive to schema v1;
  old collectors omit them. `ext` is still not stored.
- **Grouping rule in one place** (`apps/web/src/lib/queries/agent-groups.ts`): stored `agent_group`, else derived
  from `agent_type` (`workflow:<label>` → `workflow:<verb>`, verb = first token of the label without trailing
  digits; anything else → the type itself). Collector and dashboard agree on the `workflow:` prefix so old and new
  rows land in the same groups. No backfill.
- **Collector**: Claude Code Workflow agents → `workflow:<phase slug>` (else `workflow:<label verb>`) and the
  `wf_…` id; Agent-tool agents → their agent type; Codex → the agent role.
- **Agents view groups by `agent_group`** (KPIs, bars, expandable table, CSV column). `agg_agents` returns
  `agent_group` and groups by type × group.
- **Timeline = git graph over time**: lanes are sessions, coloured by project; turns are the trunk; runs branch from
  their parent (nested runs from their parent run) and merge back; one UTC day window with minute-precise zoom, in the URL (`day`, `fromH` / `toH` as HH:MM).
  Turn detail reuses the same component for one turn; the Recharts Gantt is removed.
- **Privacy**: aggregates-only leads / admins read the window through `agg_timeline_turns` / `agg_timeline_runs`
  (`SECURITY DEFINER`, scoped by `agg_scope_turns`, no `user_id`, no names). Members read raw tables under RLS.
  `agg_timeline_turns` returns the session as a per-window pseudonym (`md5(session_id, p_from, p_to)`), never the
  stored id, so lanes cannot be correlated across windows, days or other reads. **Accepted trade-off, pending the
  owner's confirmation** (review finding, 2026-10-07): inside one window a session lane is still one developer's
  activity stream, which aggregates-only mode did not show before (`agg_turn_list` has no session id); in small teams
  project, harness and hours may identify the person. Alternatives (per-project lanes in aggregates-only mode, or a
  minimum team size) are listed in the brief's open questions.
- **Caps**: 1,000 turns and 5,000 runs per window, surfaced as "truncated" in the UI.
- **Background agents**: a run belongs to the window when it overlaps it, and its parent turn is returned with it even
  when the turn itself ended earlier (workflow agents outlive the turn that launched them; on the owner's data 425 of
  429 runs do). The graph draws such a turn's tail as a dashed trunk.
- **Graph readability**: branches fork downward into sub-rows below the trunk; a lane has at most six sub-rows plus one
  shared overflow row; runs too short on screen are pills without connectors; branch colours come from the agent
  groups ranked by spawns in the filter range (the top eight keep theirs, other groups take free colours, the rest are
  grey), never cycled.

## Consequences

- Migration `0011_agent_groups_timeline.sql`: two columns, `agg_agents` and `agg_turn_runs` re-created with the extra
  column, two new functions, grants to `app_web`; `app_ingest` gains insert / update on the new columns.
- Collector, protocol fixtures and conformance tests change together (ADR-0005 versioning: additive, still v1).
- Groups for old workflow rows depend on label conventions (`verb-…` / `verb:…`); unusual labels fall into a
  verb-less group that is still better than one row per label.
- The timeline reads raw runs only (runs have no rollup form); windows are one day, so the row caps are rarely hit.
