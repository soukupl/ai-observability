# ADR-0032: The collector is published to npm from GitHub Actions with trusted publishing

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Ladislav Soukup (owner: "can you add publishing to npm via github workflows please?", 2026-10-25);
  trigger, authentication and checks designed by Claude Fable 5.1
- **Tags:** collector, release, npm, ci
- **Related:** [ADR-0031](0031-npm-package-name-ai-obs-cli.md) (the package name)

## Context

Until now the owner published the collector by hand (`npm publish` with the browser 2FA prompt), and the deprecate
step of ADR-0031 showed how easily such a step runs twice or out of order. The repository had no GitHub Actions
workflows.

npm offers CI two ways to publish. A granular access token stored as a repository secret works for any package, but
it is a long-lived secret to rotate and to leak, and since late 2025 a token that bypasses 2FA lives at most 90 days.
With trusted publishing the workflow proves its identity to npm with a GitHub OIDC token; npm checks it against a
trusted-publisher record on the package (owner, repository, workflow filename) and issues a short-lived credential for
that one publish. Trusted publishing needs npm 11.5.1 and Node 22.14 or newer, a `repository.url` in package.json that
matches the repository, GitHub-hosted runners, and an existing package: it cannot create one. Since May 2026 npm also
has staged publishing: `npm stage publish` parks a version until a maintainer approves it with an interactive 2FA
challenge; a trusted publisher may always stage, and direct `npm publish` is an opt-in permission on the record. For a
public repository and a public package npm attaches provenance automatically.

## Decision

1. `.github/workflows/publish-collector.yml` publishes `ai-obs-cli`. It runs on a pushed tag `collector-v<version>`
   or by hand (`workflow_dispatch`), on `ubuntu-latest` with Node 24 (which bundles npm 11.19, so no extra npm install),
   with `id-token: write` as its only write permission. It refuses a tag whose version differs from
   `packages/collector/package.json`, asserts npm 11.5.1 or newer, installs with the frozen lockfile, type-checks,
   builds, runs the collector tests (the real-process hook tests included, under their CI timing allowance) and then
   runs `npm publish` from `packages/collector`, with dist-tag `next` for a prerelease version and `latest` otherwise.
2. Authentication is npm trusted publishing. No npm token is stored in the repository; the trusted-publisher record on
   npmjs.com names this repository and `publish-collector.yml` and allows `npm publish`. Package publishing access is
   set to require 2FA and disallow tokens.
3. The first version of a new package name is published by hand (as 0.5.0 of `ai-obs-cli` must be), because trusted
   publishing cannot create a package. Everything after that goes through the workflow.
4. Actions are pinned to commit SHAs, with the version in a comment, and were at least a week old when chosen: the
   same release-age delay the repository applies to npm packages.
5. `packages/collector/package.json` gains `repository` (with `directory`) and `homepage`, which trusted publishing
   requires and the npm page shows.

## Options considered

- **Granular access token in a repository secret**: also works for a brand-new package, but is a long-lived secret
  with a 90-day cap when it bypasses 2FA. Rejected.
- **Staged publishing (`npm stage publish`)**: adds a 2FA approval by the owner to every release. Not chosen now, since
  the owner pushing the tag is already the human step; switching later is `npm stage publish` in the workflow and a
  stage-only record on npm, nothing else.
- **`pnpm publish`**: rewrites `workspace:*` and honours `publishConfig`, but 0.3.0 went out with `npm publish`, the
  registry accepted the `workspace:*` devDependency, and npm's OIDC flow is exercised with npm itself. Kept
  `npm publish`.
- **Publishing on a GitHub Release instead of a tag**: a release needs a tag anyway; the tag alone is enough and can be
  pushed from the command line.

## Consequences

- Releasing is: bump the version, commit, `git tag collector-v<version>`, push the tag (collector README,
  "Releasing").
- One-time setup by the owner on npmjs.com after 0.5.0 is published by hand: add the trusted publisher, allow
  `npm publish`, require 2FA and disallow tokens.
- A run from a fork or from another workflow file is rejected by npm (`ENEEDAUTH`), since the record names this
  repository and file name.
- The workflow does not run the test suite on pull requests; continuous integration for the whole repository is a
  separate decision.
