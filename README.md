# ai-obs

Self-hosted dashboard that shows a company, its teams and its developers **how AI coding agents are used**:
projects, models and effort levels, tokens and ≈ cost, where the time goes (thinking / exploring /
coding / documenting / testing / validating), sub-agent usage and how often work succeeds.

One deployment serves one company (ADR-0028): you run the Docker image on your own infrastructure, the company's
people are grouped into **teams**, and every developer reports with a **personal token**.

A tiny zero-dependency collector (`ai-obs`) reads exact numbers from Claude Code and Codex hooks and
local transcripts and pushes batched, idempotent events to the ingest API. Prompts, code, diffs and
file paths never leave the developer's machine.

Running sessions show live: the dashboard's **Active now** strip (`/sessions`) and the session page tell working from
idle with a ticking timer (the collector's `turn_started` event, polled every 10 s), and `ai-obs live` shows the sessions
on your own machine in a terminal, from local files only (see [packages/collector/README.md](packages/collector/README.md)).

- Requirements: [BRIEF.md](BRIEF.md) · Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) · Decisions: [docs/adr/](docs/adr/README.md)

## Quick start (self-hosting)

Requirements: Docker. (Node 22 and pnpm 10 only for development.)

```sh
cp .env.example .env     # set SESSION_SECRET (openssl rand -base64 48), APP_URL, ADMIN_EMAILS, SMTP_*, OAuth keys
docker compose up --build   # postgres -> migrate (one-shot) -> web + worker
```

1. **Set `ADMIN_EMAILS`** in `.env` to the e-mail(s) of the first administrator(s), comma-separated.
2. **First login.** Open `APP_URL`, enter that e-mail at `/login` and follow the magic link (or use Google / GitHub when
   configured). A listed e-mail becomes an admin member of the deployment at its first login. Rename the deployment and
   choose the privacy mode in Admin → Settings, then create the teams.
3. **Bring people in.** Invite them from Admin → Invitations (a team and a role each; the invitation is accepted by their
   first login), or set `ALLOWED_EMAIL_DOMAINS=example.com` so everyone with a verified address in that domain joins as a
   member by themselves. An unknown e-mail that is neither listed, invited nor in an allowed domain is refused.
4. **Connect collectors** (below). Service users for CI or shared machines are made in Admin → Service users.

One image serves three entry points: `web` (Next.js standalone, port 3000), `worker` and `migrate`
(`docker run ai-obs:local migrate`). Instead of building on the server you can use the published image `ghcr.io/soukupl/ai-observability`
(linux/amd64 and linux/arm64; `:latest` and `:<version>` from releases, `:main` from the main branch): set it as `image:`
of the `migrate`, `web` and `worker` services and run `docker compose pull && docker compose up -d`. The image has no demo seed. `SESSION_SECRET` must be a real secret in production:
OAuth cookies are signed with it, and in production the app refuses the `change-me…` placeholder: OAuth and magic-link
requests redirect to `/login?error=config` with a clear message (the cause is logged once). Without a mounted volume at
`WORKER_STATE_DIR` the worker re-folds all rollups after a restart (safe, just slower). Compose services: `postgres`,
`migrate`, `web`, `worker`, plus `mailpit` in the `dev` profile (`docker compose --profile dev up --build`).

### Connect a developer machine

```sh
npx ai-obs-cli login --server https://obs.example.com        # prints a code; approve it at <server>/device in the browser
npx ai-obs-cli init                                          # hooks for every detected harness (Claude Code, Codex)
cd path/to/repo && npx ai-obs-cli link --team platform       # once per repository: which team it reports to
git add .ai-obs.json && git commit -m "Report to the platform team"
```

`login` uses a device code like `gh auth login`: the CLI shows `ABCD-EFGH`, you open `/device`, check the client name and
approve. The token it receives is yours (not a company token), lasts 90 days and is stored in `~/.ai-obs/config.json`
(mode 0600). A machine can hold one token per server, so a developer who works for two companies logs in to both servers.
`login --token <t>` stores a token made on the dashboard's "My tokens" page instead (CI uses a service-user token).

`ai-obs link --team <slug>` writes the **dot file** `.ai-obs.json` at the repository root, `{"server": "https://…", "team": "<slug>"}`:
commit it so everyone who clones the repository reports to the same server and team. `--local` writes the git-ignored
`.ai-obs.local.json` instead, which overrides the committed one key by key. Tokens never go into either file, and the collector
sends only to servers it holds a token for. The team is checked on the server: the admin's project → team mapping always
wins; otherwise the dot-file team counts if you are a member of it, else your primary team. A refused team shows in
`ai-obs status` and `doctor`. Details: [packages/collector/README.md](packages/collector/README.md), ADR-0029, ADR-0030.

### Upgrading to one deployment per company (ADR-0028 to 0030)

Order matters (the brief's release order):

1. **Server first.** Stop `web` and `worker`, back up the database, then start the new image: migration 0018 turns the
   one company into the `deployment` row, drops every `company_id`, the plans and the company tokens, strips the
   `app_platform` role of every privilege, and refuses to run while more than one company exists. Set `ADMIN_EMAILS`;
   remove the old `SUPER_ADMIN_EMAILS`, `DATABASE_URL_PLATFORM` and `DB_APP_PLATFORM_PASSWORD`. The cluster role
   `app_platform` itself stays until you drop it by hand (`DROP ROLE app_platform;`) once no database uses it. Existing user tokens stay valid and expire 90 days after the cutover.
2. **Then the collectors.** Each developer updates to **0.5.0** (`npx ai-obs-cli@latest login --server …`, then `init`); it migrates
   `~/.ai-obs/config.json` to v3, keeps queued data (re-bound to its server) and ignores the old `projects.json`. 0.4.0 was
   never published, so 0.5.0 also carries the live-session work. Run `ai-obs link --team <slug>` in each repository. The npm package is now `ai-obs-cli`
   ([ADR-0031](docs/adr/0031-npm-package-name-ai-obs-cli.md)): `@soukupl/ai-obs` stays at 0.3.0 and is deprecated, so `npx @soukupl/ai-obs@latest`
   would not find 0.5.0.
3. **Last, `MIN_COLLECTOR_VERSION=0.5.0`**, once every collector is on 0.5.0: older ones are then told to upgrade.

**Dev deployment with several companies.** Only the development database has more than one company. Merge them first,
BEFORE migration 0018, and stop `web` and `worker` while it runs (it locks the telemetry tables for about a second):

```sh
pnpm --filter @ai-obs/db db:merge-companies -- --survivor <slug> --name SPECTADO --slug spectado --dry-run   # rehearse
pnpm --filter @ai-obs/db db:merge-companies -- --survivor <slug> --name SPECTADO --slug spectado
```

It folds the other companies into the survivor in one transaction (teams stay separate, one user per e-mail with the highest
role, rollup rows kept and re-pointed with their sums checked), prints per-table row counts before and after, and aborts on a duplicate session, turn or run id (duplicate events and parked patches are
de-duplicated). It applies the dev settings **full visibility, retention 395 days, runaway 20 USD, plain project naming**
unless you pass `--visibility aggregates-only`, `--retention-days`, `--runaway-cost-usd` or `--project-naming` to keep
your mode. Point it at a `pg_dump` copy with `--url <postgres url>`; without `--url` it uses `MIGRATE_DATABASE_URL`, else
`DATABASE_URL` (the live database named in `.env`). Rehearse on a copy first. See [packages/db/README.md](packages/db/README.md).

## Local development

Requirements: Node 22, pnpm 10, Docker.

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

There are no passwords anywhere: sign-in is by magic link (or Google / GitHub OAuth when configured). `pnpm db:seed` names the
deployment **SPECTADO** (slug `spectado`, aggregates-only visibility) and creates two teams (Platform, Mobile), two projects, about 300
turns over 60 days, these accounts and a service user **Demo CI** (no login, primary team Platform) with an admin-made token.
Enter an e-mail at `/login` and open the link that arrives in Mailpit.

| E-mail | Role | What they see |
|---|---|---|
| `alice@acme.example` | Admin; member of Platform | The whole deployment, every `/admin` page |
| `bob@acme.example` | Lead of the Platform team | Platform aggregates and budgets |
| `carol@acme.example` | Member, Platform team | Only her own turns |
| `dave@acme.example` | Member, Mobile team | Only his own turns |
| `admin@example.com` (first `ADMIN_EMAILS` address) | Admin member, no team | Every `/admin` page, no telemetry of their own |

Mailpit UI: http://localhost:8025 by default. If another mail catcher such as MailHog already uses ports 1025 / 8025, set
`MAILPIT_SMTP_PORT` / `MAILPIT_UI_PORT` in `.env` (for example `MAILPIT_UI_PORT=8026`) before starting the stack. Inside
Docker Compose the apps reach Mailpit by service name, so keep `SMTP_HOST` empty in dev. Magic links expire after 15 minutes.
The Docker-only path (`docker compose up`) does not seed; log in with an `ADMIN_EMAILS` address, or run `pnpm db:seed` against it.

To try the collector against your dev server:

```sh
pnpm --filter ai-obs-cli build
export AI_OBS_HOME=/tmp/ai-obs-dev                # scratch state; also point HOME at a scratch dir (init edits ~/.claude and ~/.codex)
node packages/collector/bin/ai-obs.js login --server http://localhost:3000   # approve at http://localhost:3000/device as alice
node packages/collector/bin/ai-obs.js init
# or skip the browser: a seeded user's token, made by scripts/dev-token.ts
TOKEN=$(pnpm -s dev:token alice@acme.example my-laptop 30)   # [email] [label] [days|none]
node packages/collector/bin/ai-obs.js login --server http://localhost:3000 --token "$TOKEN"
```

To report to a second server, run `login --server <other>` again; in each repository `ai-obs link --team <slug> --server <url>`
picks the server and team. With two or more servers and no dot file, a repository's events stay on the machine until it is linked.

## Repository map

| Path | Package | What |
|---|---|---|
| `packages/protocol` | `@ai-obs/protocol` | Ingest schema v1: types, zod schemas, `validateBatch()`, shared constants, `fixtures/` |
| `packages/db` | `@ai-obs/db` | Drizzle schema, `migrations/` (incl. roles + RLS), `dbFor()`, `withRlsContext()`, migrate + seed — see [packages/db/README.md](packages/db/README.md) |
| `packages/collector` | `ai-obs-cli` | Zero-runtime-dependency CLI: `login`, `init`, `link`, `token`, `doctor`, `status`, `flush`, `live`, `uninstall`, `hook` |
| `apps/web` | `@ai-obs/web` | Next.js App Router + Tailwind + Recharts: dashboard, admin, device login, `/api/v1/*` |
| `apps/worker` | `@ai-obs/worker` | Rollups, budgets, retention, runaway alerts, e-mail jobs |
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
| `pnpm db:seed` | Reset and seed the demo deployment SPECTADO (~300 turns over 60 days), its people, a service user and an admin |
| `RUN_ONCE=<rollups\|budgets\|retention\|runaways> pnpm --filter @ai-obs/worker once` | Run one worker job and exit (e.g. after `pnpm db:seed` to fill `daily_rollups`) |
| `pnpm dev:token [email] [label] [days\|none]` | Dev only: create a manual user ingest token (default alice@acme.example, label `dev-token`, 90 days) and print it |
| `git tag collector-v<version> && git push origin collector-v<version>` | Publish the collector to npm from GitHub Actions (trusted publishing, no token in the repository; see [the collector README, "Releasing"](packages/collector/README.md#releasing)) |
| `git tag server-v<version> && git push origin server-v<version>` | Publish the server image `ghcr.io/soukupl/ai-observability:<version>` (and `:latest`) for amd64 and arm64 from GitHub Actions; the version must equal `apps/web/package.json`. Pushes to `main` publish `:main`, pull requests only build (ADR-0033) |

## Configuration

Every variable is listed with a comment in [.env.example](.env.example). Secrets come from the
environment only; they are never baked into the image.

Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` (login rate limits) and `INGEST_TRUSTED_PROXY_HOPS` (ingest failed-auth
budget) to the number of proxies that append to `X-Forwarded-For` (default 1; the client IP is the n-th entry from the
right). The compose file publishes the web port directly, in which case those headers are client-controlled and only
the per-e-mail and per-token limits protect you: put a proxy in front for production. `ADMIN_EMAILS` and
`ALLOWED_EMAIL_DOMAINS` only decide who may join at first login; roles are managed in Admin → Members afterwards.
Production database logins: set `DB_APP_WEB_PASSWORD`, `DB_APP_INGEST_PASSWORD`, `DB_APP_WORKER_PASSWORD` and the matching
`DATABASE_URL_WEB` / `_INGEST` / `_WORKER` (roles `app_web`, `app_ingest`, `app_worker`).

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
