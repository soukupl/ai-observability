# Brief: "Agent flows" view

Status: **Accepted 2026-10-08**. Owner: "create a new section 'Agent flows' that will list full flows (more than one step)
with detail page for each flow… steps of sub-agents in time, tokens use, time spend, model / effort used, flow + step
phases". Built under the definitions below; flagged points are for owner review.

## Goal

Make a multi-step agent flow a first-class thing to browse: a list of flows in the filter range, and a detail page that
shows the steps in time, what each cost, which model and effort ran it, the flow's stages and each step's phase split.

## Definitions (built 2026-10-08)

- **Flow** = a set of sub-agent runs of one turn that belong together, with **≥ 2 steps**:
  - `workflow`: the runs sharing an `orchestration_id` (one Workflow-tool run); stages from `stage_index` / phase group;
  - `legacy-workflow`: all `workflow:*` runs of a turn collected before ADR-0019 (no `orchestration_id`); stages by agent
    group in first-start order (the same fallback the flow card uses);
  - `sequence`: Agent-tool runs connected through `sequence` / `item` links (stored or derived on read), one flow per
    connected component.
- **Step** = one run: stage, label, group, model, effort, start (absolute and offset), duration, tokens, ≈ cost,
  outcome, phase split (`phases_ms`), skills used and MCP calls (server × tool), incoming links.
- **Flow skills & MCP** (owner, 2026-10-08: "and mcp/skills used in the flow"): the steps' skill uses and MCP calls
  summed, shown on the detail page like the turn detail's "Skills & MCP" card, plus per step in the steps table.
- **Flow outcome**: `failed` if any step failed, else `abandoned` if any was abandoned, else `success` if every step is
  known, else `unknown`.
- **Flow ≈ cost**: per step from its tokens at the run's primary model price on that day (runs have no per-model usage
  split in the aggregate path), summed; shown as ≈ like every other cost.
- **Flow id** in URLs: `/flows/<turnId>/<key>` with `key` = the orchestration id, `workflow` (legacy) or `seq-<first run id>`
  (an orchestration id outside `[A-Za-z0-9_.:-]`, which the protocol allows, is keyed `orch-<smallest run id>` instead so
  its flow still opens);
  `?startedMs=` helps the aggregates-only lookup like turn detail.

## In scope

- Nav entry **Agent flows** after Agents. List page under the global filters: started, project, flow name, kind, steps,
  stages, duration (first start → last end), tokens, ≈ cost, models, outcome; sorted by start desc; paged; CSV export
  (`flows`). Optional `outcome` filter like the turns list.
- Detail page: facts; the flow drawn with the existing AgentFlow component; steps table (incl. skills / MCP per step);
  skills & MCP of the whole flow; time by stage (100 % bar); phases per step (100 % bars); link to the turn.
- Aggregates-only mode: a new `agg_flow_runs(range, dims, limit)` function (runs + their turn's project / start /
  summary, no user ids), detail via `agg_turn_runs` / `agg_turn_links`; `agg_turn_runs` gains `skills`, `mcp` so the
  aggregate path can show them too.
- Caps: 20,000 runs per list query (note when cut).

## Out of scope

- Cross-turn flows; flow rollups; editing flow names.

## Open questions (owner)

- Should single-step workflows (one agent) be listed too, for completeness? Not listed now ("more than one step").
- Flow name: stage names joined with arrows for workflows, step labels for sequences. Fine, or prefer the turn summary?
