# ADR-0001: Capture telemetry via harness hooks and local transcripts

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** capture, collector

## Context

The original idea was a skill that asks the AI to report its own work. An LLM does not know its real
token counts, guesses timings, and spends tokens on every report. Claude Code and Codex both expose
hooks and write local transcripts with exact model, usage, timestamps, tool calls and sub-agent data.
Both also support OpenTelemetry, but OTel lacks sub-agent parent linkage (and, for Claude, thinking
tokens and git branch) and needs a running receiver.

## Decision

We will collect all numbers with a zero-dependency collector triggered by harness hooks that parses
the local transcripts incrementally. An LLM is used only for things a script cannot produce (turn
summaries — ADR-0004). Phases are derived from tool usage by versioned rules.

## Consequences

- Exact numbers at zero token cost; works offline.
- We depend on undocumented transcript formats that can change between harness versions — adapters
  must be versioned and tested against fixtures; `ai-obs doctor` reports unsupported versions.
- Phase classification is heuristic; `phase_rules_version` is stored so rules can improve.

## Alternatives considered

- **Skill-only self-reporting** — inaccurate numbers, costs tokens, easy for agents to forget.
- **OpenTelemetry only** — missing sub-agent tree and some fields; requires a receiver; could be added
  later as an extra input.
