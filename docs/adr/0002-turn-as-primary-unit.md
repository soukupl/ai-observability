# ADR-0002: The turn is the primary unit of work

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** domain, schema

## Context

Outcome, duration, tokens and phases need a unit to attach to. Sessions can be very long and mix
unrelated tasks; "tasks" need someone to mark their boundaries.

## Decision

We will use the **turn** (one user prompt → agent stops) as the primary unit. Sessions group turns.
Each turn contains one or more **runs** (main agent + sub-agents) linked by `parent_run_id`, so the
spawn tree can be rebuilt. A turn is attributed to exactly one team.

## Consequences

- Clear boundaries that match the `Stop` hook in both harnesses.
- "Task"-level reporting is not available in v1; it can be added later as an optional label on turns
  (`summary` / `task` fields leave room for it).

## Alternatives considered

- **Session** — too coarse; mixes unrelated work.
- **Task** — most meaningful, but boundaries require LLM or user input.
