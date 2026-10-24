# ADR-0031: The collector is published on npm as `ai-obs-cli`

- **Status:** Proposed. The owner asked for `ai-obs` or `aiobs`; neither can be published (see Context), so this ADR
  proposes the nearest free name and waits for the owner's confirmation, or another pick from "Options considered".
- **Date:** 2026-10-24
- **Deciders:** Ladislav Soukup (owner: "i need the npmjs package to be named ai-obs or aiobs instead of
  @soukupl/ai-obs", 2026-10-24; the fallback name awaits the owner's confirmation); research and proposal by
  Claude Fable 5.1
- **Tags:** collector, release, npm
- **Related:** [ADR-0027](0027-live-session-status.md) (what 0.5.0 carries),
  [sessions-view brief](../briefs/sessions-view.md) (0.3.0, the first npm release)

## Context

The collector shipped as `@soukupl/ai-obs` 0.3.0 on 2026-10-13 because npm rejected the unscoped name `ai-obs`: the
registry refuses a new name that differs from an existing package only by punctuation, and `aiobs` exists. The owner
does not want the personal scope in the install line.

What the registry allows, checked on 2026-10-24:

| Name | Status |
|---|---|
| `aiobs` | Taken: "AI Observability SDK for TypeScript" by neuralis-in (MIT, 0.0.3, January 2026, about 19 downloads a month). A real package, so npm's dispute policy does not apply: npm "does not resolve squatting claims on demand" and acts only on trademark claims. |
| `ai-obs` | Blocked as a punctuation variant of `aiobs` (rejected on 2026-10-13). |
| `ai-observability` | Taken (0.0.1). |
| `ai-obs-cli`, `ai-obs-collector` | Free, and no published package normalizes to the same letters. |
| `@ai-obs/cli` | Free as a package, but needs an npm organization named `ai-obs`; whether that organization name is free could not be checked anonymously (npmjs.com answers 403). |

0.5.0 is not published under any name yet (npm holds 0.3.0 and a `0.0.0-stage`), so the rename rides on the 0.5.0
release without an extra version. The harness hooks run the runtime copied into `~/.ai-obs/app` and never the npm
name, so a renamed package changes only the install and upgrade commands, the token command the dashboard prints and
the collector's "older than the server minimum" hint.

## Decision

1. The collector is published on npm as **`ai-obs-cli`**. The command stays `ai-obs`; `~/.ai-obs`, `.ai-obs.json`
   and the hooks are unchanged.
2. 0.5.0 is the first release under the new name. `@soukupl/ai-obs` stays at 0.3.0 and is deprecated on npm with the
   message "Renamed to ai-obs-cli": `npx @soukupl/ai-obs@latest` keeps working for 0.3 users and shows the pointer.
3. Every install, upgrade and development line in the repository (README, collector README, BRIEF, ARCHITECTURE,
   the dashboard pages, the token command, the collector's upgrade hint, tests) uses `ai-obs-cli`. The briefs that
   record what 0.3.0 was published as keep the old name as history.

## Options considered

- **`ai-obs` or `aiobs`** (the request): not obtainable, see the table. Asking npm for `aiobs` would be a trademark
  dispute, and there is no trademark.
- **`ai-obs-collector`**: free; longer, and "collector" is this repository's word, not the developer's (they type
  `login`, `init`, `link`).
- **`@ai-obs/cli`** under a new free npm organization: keeps `ai-obs` as the visible brand but puts a scope back into
  every install line, which is what the owner is moving away from; the organization name is unverified.
- **Keep `@soukupl/ai-obs`**: rejected by the owner.

## Consequences

- Release steps (owner, after `npm login`): `pnpm --filter ai-obs-cli build`, then `npm publish` in
  `packages/collector` (the first publish of the name), then `npm deprecate @soukupl/ai-obs "Renamed to ai-obs-cli"`.
- Developers on 0.3.0 upgrade with `npx ai-obs-cli@0.5.0 init` (collector README, "Upgrading to 0.5"); the old name
  would not find 0.5.0.
- `pnpm --filter` lines use `ai-obs-cli`; the workspace scope `@ai-obs/*` (db, protocol, web, worker) is unrelated and
  unchanged.
- Another pick from the options is the same substitution again plus this ADR's title.
