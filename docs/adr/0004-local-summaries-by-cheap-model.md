# ADR-0004: Turn summaries are always on and generated locally by a cheap model

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** Ladislav Soukup (owner); options proposed by Claude
- **Tags:** privacy, collector, llm

## Context

Dashboards are much more useful with a one-line description of each turn. Generating it on the server
would require sending prompts and code; generating it inline would use the expensive working model.

## Decision

We will generate a ≤ 140-char summary for **every** turn on the developer's machine, in **one batched
headless call per session** to the harness's cheapest model (`claude -p --model haiku`,
`codex exec -m <mini>`). Only summaries are sent. Child processes get `AI_OBS_SUMMARIZING=1` and every
hook handler exits immediately when it is set, preventing recursion (works with subscription logins).

## Consequences

- Prompts and code never leave the machine; the summary itself is model-written content that does.
- Uses the developer's own plan / rate limit (tiny but non-zero).
- Summaries may arrive later than turns (patch event); failures retry on the next run.
- Summary visibility must respect the individual-visibility mode (ADR-0008).

## Alternatives considered

- **No summaries / opt-in** — less useful dashboards; owner chose always on.
- **Server-side summarization** — sensitive content leaves the machine; we pay the tokens.
- **Inline by the working agent** — expensive model, pollutes context, unreliable.
