# syntax=docker/dockerfile:1.7
# One image, three entry points (ADR-0010): web | worker | migrate.

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
RUN npm install -g pnpm@10.33.2 && apk add --no-cache libc6-compat
WORKDIR /repo

# ---- deps: install from the lockfile only (layer cached until a manifest changes)
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/db/package.json packages/db/
COPY packages/collector/package.json packages/collector/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build: web (Next standalone), worker and db (migrations) + pruned prod bundles
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter "@ai-obs/web..." --filter "@ai-obs/worker..." build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @ai-obs/worker deploy --prod --legacy /out/worker \
 && pnpm --filter @ai-obs/db deploy --prod --legacy /out/db

# ---- runtime
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./web
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./web/apps/web/public
COPY --from=build --chown=node:node /out/worker ./worker
COPY --from=build --chown=node:node /out/db ./db
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["web"]
