# ai-obs

Multi-tenant SaaS that shows companies, teams and developers **how AI coding agents are used**:
projects, models and effort levels, tokens and ≈ cost, where the time goes (thinking / exploring /
coding / documenting / testing / validating), sub-agent usage and how often work succeeds.

A tiny zero-dependency collector (`ai-obs`) reads exact numbers from Claude Code and Codex hooks and
local transcripts and pushes batched, idempotent events to the ingest API. Prompts, code, diffs and
file paths never leave the developer's machine.

- Requirements: [BRIEF.md](BRIEF.md) · Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · Decisions: [docs/adr/](docs/adr/README.md)

## Quick start

Requirements: Node 22, pnpm 10, Docker.

### Local development

```sh
cp .env.example .env
docker compose --profile dev up -d postgres mailpit   # Postgres on :5432, Mailpit UI on http://localhost:8025
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev                                              # web on http://localhost:3000 + worker, packages in watch mode
```

`pnpm db:seed` also leaves `daily_rollups` filled (same fold as the worker). Run `RUN_ONCE=rollups pnpm --filter @ai-obs/worker once` to check them. `pnpm dev` builds the shared packages once and then watches them; the web app and worker read the
repo-root `.env`.

### Pre-seeded dev logins

There are no passwords anywhere: sign-in is by magic link (or Google / GitHub OAuth when configured). `pnpm db:seed` creates
the demo company **Acme** (Team plan, aggregates-only visibility, two teams, two projects, about 300 turns over 60 days) with
these accounts. Enter an e-mail at `/login` and open the link that arrives in Mailpit.

| E-mail | Role | What they see |
|---|---|---|
| `alice@acme.example` | Company admin (Platform team) | Whole company, every `/admin` page |
| `bob@acme.example` | Lead of the Platform team | Platform aggregates, team tokens and budgets |
| `carol@acme.example` | Member, Platform team | Only her own turns |
| `dave@acme.example` | Member, Mobile team | Only his own turns |
| `admin@example.com` | Super admin (listed in `SUPER_ADMIN_EMAILS`) | `/super` console only, no telemetry |

Mailpit UI: http://localhost:8025 by default. If another mail catcher such as MailHog already uses ports 1025 / 8025, set
`MAILPIT_SMTP_PORT` / `MAILPIT_UI_PORT` in `.env` (for example `MAILPIT_UI_PORT=8026`) before starting the stack. Inside
Docker Compose the apps reach Mailpit by service name, so keep `SMTP_HOST` empty in dev. Magic links expire after 15 minutes.
The Docker-only path (`docker compose up`) does not seed; run `pnpm db:seed` against it or create the first company via `/signup`.

To try the collector against your dev server:

```sh
TOKEN=$(pnpm -s dev:token)                      # ingest token for a seeded user (scripts/dev-token.ts)
pnpm --filter ai-obs build
AI_OBS_HOME=/tmp/ai-obs-dev node packages/collector/bin/ai-obs.js init --token "$TOKEN" --endpoint http://localhost:3000
```

`init` edits the real `~/.claude/settings.json` and `~/.codex/hooks.json`; point `HOME` at a scratch
directory to try it without touching them.

### Full stack in Docker

```sh
cp .env.example .env        # set SESSION_SECRET (openssl rand -base64 48), APP_URL, SMTP_*, OAuth keys
docker compose up --build   # postgres -> migrate (one-shot) -> web + worker
docker compose --profile dev up --build   # same, plus Mailpit
```

One image serves three entry points: `web` (Next.js standalone, port 3000), `worker` and `migrate`
(`docker run ai-obs:local migrate`). The image has no demo seed: open `/login`, enter your e-mail and
create the first company on `/signup` (or list the e-mail in `SUPER_ADMIN_EMAILS` for the platform
console). `SESSION_SECRET` must be a real secret in production: sign-up and OAuth cookies are signed with it, and in production the app refuses the `change-me…` placeholder: sign-up, OAuth and magic-link requests redirect to `/login?error=config` with a clear message (the cause is logged once). Without a mounted volume at `WORKER_STATE_DIR` the worker re-folds all rollups after a
restart (safe, just slower).

## Repository map

| Path | Package | What |
|---|---|---|
| `packages/protocol` | `@ai-obs/protocol` | Ingest schema v1: types, zod schemas, `validateBatch()`, shared constants, `fixtures/` |
| `packages/db` | `@ai-obs/db` | Drizzle schema, `migrations/` (incl. roles + RLS), `dbFor()`, `withRlsContext()`, migrate + seed — see [packages/db/README.md](packages/db/README.md) |
| `packages/collector` | `ai-obs` | Zero-runtime-dependency CLI: `init`, `doctor`, `status`, `flush`, `uninstall`, `hook` |
| `apps/web` | `@ai-obs/web` | Next.js App Router + Tailwind + Recharts: dashboard, admin, super admin, `/api/v1/*` |
| `apps/worker` | `@ai-obs/worker` | Rollups, budgets, retention, e-mail jobs |
| `docs/adr` | – | Architecture Decision Records |

Workspace packages are consumed from source in type-checking and tests (custom export condition
`@ai-obs/source`) and from `dist/` at runtime, so `pnpm build` builds them first.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Watch-build packages, run web (`next dev`) and worker (`tsx watch`) |
| `pnpm build` | Build every package, including `next build` (standalone output) |
| `pnpm test` | Run all vitest projects (`vitest.config.ts`); RLS tests need Postgres (`docker compose up -d postgres`, or `TEST_DATABASE_URL`) and skip otherwise |
| `pnpm --filter @ai-obs/web start` | Run the built standalone web server (after `pnpm build`). It first copies `.next/static` and `public` next to `.next/standalone/apps/web` (the Dockerfile does the same), so assets are served. Configuration comes from the environment (`set -a; . ./.env; set +a`), `PORT` / `HOSTNAME` as usual |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm db:generate` | Generate a Drizzle migration from `packages/db/src/schema` |
| `pnpm db:migrate` | Apply Drizzle migrations incl. roles + RLS, default model prices, role passwords (uses `MIGRATE_DATABASE_URL`, else `DATABASE_URL`) |
| `pnpm db:seed` | Reset and seed the demo company "Acme" (~300 turns over 60 days) and a super admin |
| `RUN_ONCE=<rollups\|budgets\|retention> pnpm --filter @ai-obs/worker once` | Run one worker job and exit (e.g. after `pnpm db:seed` to fill `daily_rollups`) |
| `pnpm dev:token [email]` | Dev only: create a user ingest token for a seeded user and print it |

## Configuration

Every variable is listed with a comment in [.env.example](.env.example). Secrets come from the
environment only; they are never baked into the image.

Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` (login rate limits) and `INGEST_TRUSTED_PROXY_HOPS` (ingest failed-auth
budget) to the number of proxies that append to `X-Forwarded-For` (default 1; the client IP is the n-th entry from the
right). The compose file publishes the web port directly, in which case those headers are client-controlled and only
the per-e-mail and per-token limits protect you: put a proxy in front for production. `SUPER_ADMIN_EMAILS` is the
source of truth for super admins; removing an e-mail revokes the role at once.

## Dependencies

Exact versions only, each at least 3 days old when added (`minimum-release-age` in `.npmrc`).
The collector has no runtime dependencies at all.

### Screenshot dev tool

`scripts/screenshot.ts` captures every dashboard/admin route (light + dark, 1440x900 and 360x800) with headless
Chrome over the DevTools protocol (no dependencies) and reports horizontal overflow and console errors:

```sh
SESSION_COOKIE=<ai_obs_session value> TURN_ID=<turn uuid> node --experimental-strip-types scripts/screenshot.ts /tmp/shots
```

Start the standalone server first (`pnpm --filter @ai-obs/web start` copies `.next/static` and `public` next to
`standalone/apps/web`, as the Dockerfile does) and log in via a magic link to obtain the cookie. Env: `BASE_URL`, `CHROME`, `CDP_PORT`, `ROUTES`.
