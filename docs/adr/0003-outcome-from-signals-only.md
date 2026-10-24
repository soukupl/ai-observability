---
spoor_id: 15035f8b-3b4f-4a0f-bc46-58bc4ca27fd7
---
# ADR-0003: Turn outcome is derived from signals only

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** domain, collector

## Context

Success/failure is a key metric. Options were LLM judgement, signals (tests, errors, interrupts,
corrections), user ratings, or a combination.

## Decision

We will derive outcome (`success / failed / abandoned / unknown`) **only from signals** computed
locally: harness errors, interrupts, exit codes of the last test/validate command, and whether the next
prompt looks like a correction or reverts the turn's edits. Signals are stored with the outcome. A turn
is sent with a provisional outcome and patched when the next turn arrives.

## Consequences

- Zero LLM cost, deterministic, explainable ("failed because tests failed").
- Many turns will be `unknown` (no tests, last turn of session); dashboards must show that share.
- Correction heuristics are language-dependent (EN + CZ first).
- Requires a `turn_outcome` patch event type.

## Alternatives considered

- **LLM judge** — costs tokens and is hard to trust; rejected by owner.
- **User rating** — sparse and adds friction.
- **Combination** — more moving parts than needed for v1.
