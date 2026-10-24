# ADR-0033: The server image is built by GitHub Actions and published to GitHub Container Registry

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Ladislav Soukup (owner: "please add git workflow to build docker image", 2026-10-25); registry,
  triggers, tags and platforms chosen by Claude Opus 5.5
- **Tags:** deployment, release, docker, ci
- **Related:** [ADR-0010](0010-portable-eu-hosting.md) (one image, Docker everywhere),
  [ADR-0028](0028-one-deployment-one-company.md) (every company runs its own deployment),
  [ADR-0032](0032-publish-collector-from-github-actions.md) (the collector's release workflow)

## Context

Every company runs its own deployment (ADR-0028) from the one image of ADR-0010, but until now the image existed only
where someone ran `docker compose up --build`. A self-hoster had to clone the repository and build on the server, and
nothing checked that the Dockerfile still built after a change. The repository is public, so GitHub-hosted runners,
native arm64 runners and GitHub Container Registry storage for a public package cost nothing.

## Decision

1. `.github/workflows/docker-image.yml` builds the root `Dockerfile` for `linux/amd64` and `linux/arm64` and publishes
   `ghcr.io/soukupl/ai-observability` (`ghcr.io/${{ github.repository }}`).
2. Triggers and tags: a push to `main` publishes `:main` and `:sha-<short sha>`; a pushed tag `server-v<version>`
   publishes `:<version>`, `:<major>.<minor>` and `:latest` (a prerelease version gets only `:<version>`), and the run
   fails when the version differs from `apps/web/package.json`; a pull request to `main` builds both platforms and
   pushes nothing; "Run workflow" behaves like a push to the chosen branch.
3. Each platform builds on its own native runner (`ubuntu-24.04`, `ubuntu-24.04-arm`) and pushes by digest; a merge job
   creates the multi-arch tags with `docker buildx imagetools create`. Layers are cached in the GitHub Actions cache,
   one scope per platform.
4. Authentication is the workflow's `GITHUB_TOKEN` with `packages: write`; no registry secret is stored.
5. Actions are pinned to commit SHAs, with the version in a comment, and were at least a week old when chosen (as in
   ADR-0032); `docker/login-action` therefore stays on v4.6.0, since v4.7.0 was two days old.

## Options considered

- **Docker Hub**: the default place people search, but needs an account, an access token in a repository secret and
  has pull rate limits. Rejected for now; adding it later is a second `images:` entry and a login step.
- **One job with QEMU emulation for arm64**: simpler, but the pnpm install and Next.js build run several times slower
  under emulation. Rejected for native runners.
- **amd64 only**: halves the work, but leaves out ARM servers (Graviton, Ampere) and Apple Silicon machines.
- **Tags `v<version>`**: shorter, but ambiguous next to the collector's `collector-v<version>`. Chose `server-v`.

## Consequences

- A self-hoster can run the published image instead of building: set `image: ghcr.io/soukupl/ai-observability:<tag>`
  for the compose services, or `docker run ghcr.io/soukupl/ai-observability:<tag> migrate`.
- Releasing the server is: bump `apps/web/package.json` (and `apps/worker` to match), commit,
  `git tag server-v<version>`, push the tag.
- One-time setup by the owner after the first push: in the package settings on GitHub make
  `ghcr.io/soukupl/ai-observability` public (a new GHCR package is private), and check it is linked to the repository.
- Every pull request now proves the Dockerfile builds for both platforms. The test suite still does not run in CI
  (ADR-0032 left that open).
