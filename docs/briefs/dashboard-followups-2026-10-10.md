# Brief: dashboard follow-ups (flow flags + report, agents links, overview cards, early summaries, chart zoom)

Status: **Built 2026-10-10 under Claude's defaults** (owner asked for the seven items below and "when finished, rebuild,
commit and push"; the owner reviews the defaults at the end). ADRs: [0023](../adr/0023-mid-session-summaries.md),
[0024](../adr/0024-flow-flags-report-ingest-stats-zoom.md).

## Owner's items (verbatim)

1. agents flow – detail – allow to flag the flow for later, download as PDF report
2. agents – remove the agent flow "widget", add links from agents entry to agents flow detail
3. overview – we have runaway turns, let's also highlight longer/complex agent flows here
4. turns – there are quite often turns without summary… it is back-filled later but it took time
5. overview – can we add simple statistics of ingested reports and when was the last report ingested
6. agents flow – detail – can you list skills and MCP used also in this "report"
7. can you add zoom (time zoom) to all time-series graphs, please?

## Decisions (defaults shipped; flagged for owner review)

- **Flag for later** = a personal bookmark of one flow: table `flow_flags` (company, user, turn, flow key, flow name
  snapshot, optional note ≤ 500 chars, created). One per user × flow; toggled with a button on the flow detail page.
  Flagged flows are listed in a "Flagged for later" card at the top of `/flows`, **regardless of the date range** (that
  is what "later" means), newest flag first, with remove buttons. Flags are private to the user who set them (RLS:
  own rows only); they are not shared with the team. *Owner may want team-visible flags instead.*
- **PDF report** = a print-ready report page `/report/flows/<turnId>/<key>` (no app chrome, print stylesheet) with a
  "Download PDF" button that opens the browser's print dialog (Save as PDF). No PDF library is added (dependency
  safety, no server-side rendering of charts). The report holds: facts, the flow chart, the steps table, skills & MCP
  (of the steps and of the turn's main agent), time by stage, phases per step, generated-at line.
- **Skills & MCP on the detail page / report**: the card is always shown (with "none recorded" when empty) and gains a
  second line for the turn's main agent, so the reader sees what the whole turn used even when the sub-agents used
  nothing. Note: Claude Code sub-agent runs seldom carry skills (1 of ~400 runs locally); MCP calls are more common.
- **Agents page**: the "Agent flow" card is removed (it duplicates `/flows`). Links instead: every sub-agent run drawn
  on the timeline links to its flow's detail page (or its turn when it is not part of a flow); every agent group / type
  row in the table links to `/flows?group=<group>` (new list filter, keeps the other filters).
- **Overview, complex flows**: a "Long or complex agent flows" card (like "Runaway turns") lists the flows of the range
  with **≥ 5 steps or ≥ 20 minutes or ≥ 1 M tokens**, sorted by duration, at most 8, linking to the detail page and to
  `/flows`. Thresholds are constants in the overview helpers (not settings) until the owner wants them configurable.
- **Overview, ingest stats**: an "Ingest" card: last event received (relative + UTC), events in the last 24 h and
  7 days by type (turns, runs, patches, sessions). Read through `agg_ingest_stats()` over `ingest_events`
  (company-wide, no attribution, not affected by the filters; the ledger keeps 30 days).
- **Early summaries** (ADR-0023): the Claude Code adapter no longer waits for `SessionEnd`. At every hook it
  summarizes the pending digests when there are ≥ 10 of them **or the oldest has waited ≥ 10 minutes** (or the session
  ended). Codex gets the same age rule next to its existing batch-of-10 rule. One extra headless call per ~10 minutes
  of an active session at most.
- **Chart zoom**: drag on any stacked-area time-series chart (Overview, project detail, Skills & MCP) to zoom into a day
  range; a "Reset zoom" button restores the full range. Client-side only (the data is already loaded). The agent
  timeline keeps its own zoom.

## Out of scope

- Server-side PDF rendering; team-shared flags; configurable complexity thresholds; e-mail digests of flagged flows.
