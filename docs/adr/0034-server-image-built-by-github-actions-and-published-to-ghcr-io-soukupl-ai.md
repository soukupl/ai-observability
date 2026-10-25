---
spoor_id: bec7bc9b-64ec-4be3-a086-c1eb1bdd9ab2
adr: 34
title: Server image built by GitHub Actions and published to ghcr.io/soukupl/ai-observability (ADR-0033)
status: proposed
date: 2026-10-25
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m18]
tags: [ci, docker, release, deployment]
anchors: [.github/workflows/docker-image.yml, docs/adr/0033-publish-server-image-to-ghcr.md, Dockerfile]
---
# Server image built by GitHub Actions and published to ghcr.io/soukupl/ai-observability (ADR-0033)

## Context
The server image must run on both amd64 and arm64. Emulating arm64 with QEMU was rejected because the Next.js build is slow under emulation. Docker Hub was rejected because it would need a stored secret and is subject to rate limits.

## Decision
We will build the server image in `.github/workflows/docker-image.yml` on native amd64 and arm64 runners. Each platform is pushed by digest and then merged into one multi-architecture image. We will publish to `ghcr.io/soukupl/ai-observability`, authenticating with `GITHUB_TOKEN` using `packages: write`.

## Consequences
- Pushes to `main` publish `:main` and `:sha-*` tags. Pull requests build the image but do not push it.
- A `server-v<version>` tag publishes `:<version>`, `:<major>.<minor>`, and `:latest`. Prereleases do not get `:latest`. The tag version must equal the version in `apps/web/package.json`.
- No registry secret is needed beyond `GITHUB_TOKEN`.
- Trade-off: the owner must make the GHCR package public manually after the first push.

## Alternatives considered
- Docker Hub: requires a secret and is subject to rate limits.
- QEMU emulation for arm64: slow Next.js build.
- amd64-only image.
- `v<version>` tags: ambiguous with `collector-v` tags.
