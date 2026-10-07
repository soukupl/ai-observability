# Brief: agent groups and the agent timeline

Status: **Accepted 2026-10-07**. Owner: "There is an Agents page... but info on it is not useful … group the agent
types to logical groups … timeline-like chart similar to GIT branches but for time, main thread and sub-agents and
how they work in serial / in parallel … bind each agent to project on the timeline." Built under the recommended
defaults below; open points are flagged for owner review.

## Goal

Make the Agents view answer two questions: **which kinds of sub-agents are used, how much and how well** (not one row
per throw-away label), and **how the work actually ran** (which agent spawned which, when, serial or parallel, in
which project).

## Today

- `runs.agent_type` is the only label of a sub-agent. For Claude Code's Agent tool it is the agent type
  (`Explore`, `Plan`, `general-purpose`, `code-reviewer`); for the Workflow tool the collector builds
  `workflow:<label>` from the agent's label (`workflow:impl-m08-t02b`). In the owner's data that gives **403 distinct
  types for 650 runs**; 460 of them are workflow labels used once or twice.
- The collector already knows each workflow agent's **phase** (`Review`, `Verify`, …) and **workflow run id**
  (`wf_…`) and sends them in the harness-specific `ext` field (`workflow_phase`, `workflow_id`). Ingest validates
  `ext` and drops it.
- The Agents page shows one row and one bar per `agent_type`; the only time view is the per-turn Gantt (Recharts) on
  turn detail, which shows one turn and knows nothing about projects or sessions.

## Decisions (recommended defaults, built 2026-10-07)

1. **Two harness-neutral run fields** (protocol v1, additive, optional): `agent_group` (the logical kind of agent,
   ≤ 128 chars) and `orchestration_id` (id of the batch / workflow run that launched the agent, ≤ 128 chars). Stored
   as `runs.agent_group` / `runs.orchestration_id` (nullable). No `ext` is stored (ADR-0005 stays).
2. **The collector fills them**: Claude Code Workflow agents → `agent_group = workflow:<phase slug>` (phase from the
   meta file), else `workflow:<first word of the label>`; `orchestration_id = wf_…`. Agent-tool agents →
   `agent_group = <agent type>`. Codex → `agent_group = <agent role>`.
3. **Old rows are grouped on read** by a pure function over `agent_type`: `workflow:<label>` → `workflow:<verb>`
   where the verb is the first token of the label with trailing digits stripped (`impl-m08-t02b` → `workflow:impl`,
   `fix1-m8-brief` → `workflow:fix`); anything else → the type itself. The stored `agent_group` wins when present.
   No backfill migration.
4. **Agents page groups by `agent_group`**: KPIs count groups, the token bar chart is per group, the table has one
   row per group that expands to its raw types; CSV export gains an `agent_group` column (one row per type).
5. **Agent timeline (git-graph style)** on the Agents page, under the global filters: one **lane per session**, lanes
   ordered and **coloured by project**, with a project legend. On a lane the turns are the trunk (thick segments;
   idle time thin); each sub-agent run is a branch that forks off its parent at its start and merges back at its end,
   nested sub-agents branch off their parent's branch; parallel agents stack in sub-lanes below the trunk (at most
   six, then one shared overflow row marked "+N more"), serial ones follow each other; a run too short on screen for a
   fork is a short pill on its sub-lane. Agents that keep running after their turn ended (background workflow agents)
   are drawn on the turn's lane even in later windows, with a dashed trunk tail. Branch colours follow the agent groups
   ranked by spawns in the filter range: the top eight keep their colour in every window, other groups take the
   colours left free, the rest are grey; no colour is used twice in one view. Hover shows agent type, group, project, start, duration, outcome; a turn links to its detail page.
   The window is **one UTC day** (default: the last day of the filter range that has turns), stepped with
   prev / next and zoomable to a minute range; the window lives in the URL (`day`, and `fromH` / `toH` as `HH:MM`,
   `toH` may be `24:00`; not `from` / `to`, which are the filter bar's custom date range).
6. **Turn detail** draws the same graph for its single turn and drops the Recharts Gantt.
7. **Privacy**: in aggregates-only mode leads and admins read the timeline through new `SECURITY DEFINER`
   functions (`agg_timeline_turns`, `agg_timeline_runs`) that return no `user_id` and no names, like `agg_turn_list`.
   Session ids are opaque: in aggregates-only mode `agg_timeline_turns` returns a per-window pseudonym (md5 of the
   session id and the window), never the stored id. A lane shows project, harness and the start time of its first turn
   in the window (to tell two sessions of a project apart). Members see only their own turns (RLS).
8. **Caps**: a window returns at most 1,000 turns and 5,000 runs; when cut, the page says so.

## In scope

Protocol fields + fixtures; migration 0011 (columns, `agg_agents` with `agent_group`, timeline functions, grants);
ingest; collector (Claude Code + Codex); dashboard (grouping helpers, timeline query, graph component, page,
turn detail, CSV); tests; ADR-0019; ARCHITECTURE / BRIEF / README updates.

## Out of scope

- Company-defined grouping rules (a settings UI for regexes). The built-in rule plus the collector's group cover
  the known harnesses; revisit if a harness produces ungroupable types.
- Rollups per agent group (the Agents page reads raw runs for every range today; unchanged).
- Backfilling `agent_group` for existing rows (the read-time rule covers them).

## Open questions (owner)

- **Privacy of session lanes (review finding, 2026-10-07).** In aggregates-only mode a lead or admin sees one lane per
  session: one developer's turns over the day, with times, outcomes and summaries. The pseudonymous per-window session
  key stops lanes being correlated across windows or days, but inside a window a lane is still one person's activity,
  which `agg_turn_list` never exposed (it has no session id). In a small team the project, harness and working hours
  can identify the person. Options: keep (current), lanes per project instead of per session in aggregates-only mode,
  or hide the timeline there below a minimum team size. Recorded in ADR-0019 (Privacy).
- **Long tail of groups (review finding, 2026-10-07).** On the owner's data the rule leaves 28 groups for 405 types;
  about 13 hold one or two spawns because noun-first workflow labels (`schema-rls`, `adapter-codex`) give a noun as the
  "verb". Options: fold groups with ≤ 2 spawns into `workflow:other` on the table / bars, an allow-list of known verbs
  (impl, verify, fix, review, …) with the rest as `workflow`, or rely on the collector's phase groups for new data.
  Not changed yet: it changes the grouping contract.

- Should the group of a workflow agent be its **phase** (`workflow:review`) or the label's verb (`workflow:verify`)?
  Both are shipped: phase when the collector sees one, verb otherwise. Pick one if the mix is confusing.
- Is **one lane per session** right, or should lanes be per project (sessions of a project merged)? Per session
  keeps parallel sessions in the same project visible, which seemed to be the point of "serial / in parallel".
