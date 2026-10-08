# Brief: agent flow (chained sub-agents)

Status: **Accepted 2026-10-08**. Owner: "connect plan, implementation, verification, … sub-agents to chain for better
understanding of the flow … visualize it on the timeline as linked flow — you may create a second flow timeline";
label convention `<stage>:<item>` confirmed ("yes, it should be ok… let's try it").

## Goal

Show how sub-agents hand work to each other: which agent's result fed which later agent, stage by stage, so a
workflow reads as `review:bugs → verify:bugs → fix:bugs` and an Agent-tool session reads as `Plan → general-purpose →
code-reviewer`, instead of unrelated branches on the timeline.

## What the harness records (checked 2026-10-07/08 on local transcripts)

- Workflow agents: meta `{description (label), workflowPhase}`; the journal lists `started` records in launch order, so
  the **phase order** of a workflow run is known. The journal's `key` is a hash: per-item pipeline dependencies are
  **not** recorded.
- Agent-tool agents: meta `{agentType, description, toolUseId, spawnDepth, parentAgentId?}`; the parent transcript gives
  the spawn order and end times. No agent name, so resumed agents (SendMessage) cannot be linked yet; no local transcript
  contains a SendMessage call to verify the payload.

## Decisions (built 2026-10-08)

1. **Three optional run fields** (protocol v1, additive): `stage_index` (0-based ordinal of the agent's phase inside its
   orchestration), `flow_key` (the item named by the label convention `<stage>:<item>`, slugged, ≤ 128) and `links`
   (≤ 32 incoming edges `{ from_run_id, kind }`, `kind` ∈ `item` | `sequence`; the source is a run of the same turn
   whose result fed this run). Links are carried by the **target** run so the source always exists first.
2. **Collector rule**:
   - `item`: workflow agents of one orchestration with the same `flow_key`, chained in start order (each links to the
     previous one).
   - `sequence`: Agent-tool agents with the same parent (main agent or parent agent), not in an orchestration: each
     links to the sibling with the latest end that ended before it started (parallel siblings are not chained; of two
     siblings starting at the same instant only the lower id leads, so zero-length runs never link both ways).
   - `stage_index` from the journal's phase order; Codex sends none of the three (no equivalent yet).
3. **Storage**: `runs.stage_index`, `runs.flow_key`, table `run_links` (one row per edge, unique per company × turn ×
   from × to × kind; `from_run_id` resolved late like `parent_run_id`). Visibility follows the target run (RLS policy
   via `runs`); aggregates-only mode reads through `agg_turn_links` / `agg_timeline_links`.
4. **Read-time backfill**: `sequence` links are derived on read for Agent-tool runs that have no stored incoming link
   (old rows). `item` links and `stage_index` need the collector, so old workflow runs show stages by their group
   only, without an ordinal.
5. **"Agent flow" card** on the Agents page under the timeline, same window and zoom, and on turn detail under the
   timeline: one lane per orchestration (workflow run) and one lane per turn for its direct Agent-tool spawns; rows
   inside a lane are stages (phase ordinal, labelled with the phase name), x is time; each agent is a pill from start to
   end, coloured by agent group; edges are arrows (`item` solid, `sequence` dashed) from the source's end to the target's
   start. Hovering a node highlights its whole chain and dims the rest. Lanes are capped at 40 per window ("+N more").

## Out of scope

- `continues` links for resumed agents (needs a verified SendMessage payload and an agent-name → id mapping).
- Codex chains; cross-turn links; company-defined link rules.

## Open questions (owner)

- Should the Agents-page flow replace the timeline when zoomed to one workflow, or stay a second card? Second card
  for now.
