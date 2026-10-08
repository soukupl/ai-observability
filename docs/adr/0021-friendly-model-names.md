# ADR-0021: Friendly model names in the UI; raw ids on machine-facing surfaces

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** Ladislav Soukup (owner: asked for friendly names across the dashboard and a provider on the Models
  page); implementation by Claude
- **Tags:** dashboard

## Context

The dashboard showed raw model ids (`claude-opus-5-5`, `us.anthropic.claude-sonnet-4-5-20250929-v1:0`) in every table,
chart and detail page. They are long, vary by provider and platform, and hide what the reader wants to see: the family and
version.

## Decision

- One pure, client-safe parser, `apps/web/src/lib/model-name.ts`, with a small provider table (Anthropic, OpenAI,
  Google), turns an id into `{ provider, name, id }`: `claude-opus-5-5` becomes "Opus 5.5" by "Anthropic".
- `DataTable` gets a column kind `model` that renders the friendly name with the raw id in a `title` tooltip. Charts,
  legends and other model labels use the same parser.
- The raw id stays everywhere it is a key: filters, `?model=` and other URL params, grouping keys, chart series keys,
  React keys and the CSV export.
- The Models page gets a Provider column.

## Consequences

- A new provider or model family needs an entry in the parser table; until then the id is shown verbatim with no
  provider (unknown ids and sentinels such as "(unknown)" never throw).
- CSV stays machine-readable and joins cleanly with the database; the screen and the file can differ on purpose.
- Two different raw ids may render the same name (a dated snapshot and its alias). A single cell shows the name with
  the raw id in its tooltip; a list shown side by side (chart bars, legends, the model filter, a flow's model list)
  goes through `modelLabels`, which falls back to the raw id for the colliding entries so no two read the same.
