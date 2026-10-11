# ADR-0025: One detail page for a turn and its agent flows

- **Status:** Accepted
- **Date:** 2026-10-11
- **Deciders:** Ladislav Soukup (owner: "merge those pages to single one page with all the data combined",
  2026-10-11); page shape, redirect and what was dropped by Claude
- **Tags:** dashboard
- **Brief:** [agent-flows-view](../briefs/agent-flows-view.md) (amendment 2026-10-11)

## Context

The turn detail (`/turns/<id>`) and the flow detail (`/flows/<turnId>/<key>`, ADR-0020 amendment) showed mostly the
same data: a flow is built from its turn's runs (`getFlowDetail` wraps `getTurnDetail`), both drew the runs with
`AgentFlow`, both had Facts and Skills & MCP cards, and the flow page's facts linked back to the turn. The owner asked
for one page with everything.

## Decision

- **The turn page is the single detail page.** A turn owns 0..n flows (several Workflow runs or sequences can share a
  turn), so the merge goes into the turn, not the other way round. After the turn's own cards (facts, tokens, phases,
  skills & MCP, outcome signals, timeline) the page renders one **flow section** per flow (`turnFlows(detail)` =
  `buildFlows` over the turn detail), each with the flow's facts, "Download PDF", the flag button, the flow chart, the
  steps table, time by stage and phases per step; then the run tree. The turn's Facts card links to each section.
- **URLs:** a flow's address is `/turns/<id>?startedMs=…#flow-<key>` (`flowHref`); every list, the Overview, the Agents
  timeline and the flagged list link there. `/flows/<turnId>/<key>` stays as a **permanent redirect** to that anchor
  (after the same visibility lookup, so a missing flow is still a 404), so bookmarks, flags and the report's "open in
  the dashboard" link keep working. The `/flows` list and the print report
  `/report/flows/<turnId>/<key>` (ADR-0024) are unchanged.
- **Dropped without replacement:** the turn page's former turn-wide "Flow" card (one lane per orchestration plus a
  "main agent spawns" lane, `turnFlow` / `agents/flow-view.ts`). Every multi-step run set is now a flow section, and
  single sub-agent runs are on the Timeline and in the Runs tree. Facts a flow shares with its turn (project, harness,
  the turn) are not repeated in its section; the main agent's own skills / MCP line moved into the turn's Skills & MCP
  card, which is now always shown.
- **Flags:** the turn page reads the viewer's flags of all its flows in one query (`getFlowFlags`); the flag actions
  revalidate `/turns` as well as `/flows`.

## Consequences

- One query path (`getTurnDetail`) and one page per turn; the flow helpers (`flows/_helpers.ts`) are shared by the
  turn page and the report. `flowSectionFacts` is `flowFacts` minus the turn-level facts.
- A turn with many flows is a long page; the Facts card's anchor links are the navigation. A per-flow page could return
  as a filtered view of the same section if that becomes a problem.
- The redirect route depends on the flow key being URL-safe (it is, by `FLOW_KEY_RE`).

## Alternatives considered

- **Flow page absorbs the turn data:** rejected; most turns have no flow, and a turn with two flows would show its
  data twice.
- **Keep both pages, deduplicate cards:** rejected; the owner asked for one page, and the duplication was the point.
