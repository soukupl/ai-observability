# ai-obs — collector

Zero-dependency Node CLI that records how AI coding agents are used: tokens, models, effort levels,
phases, sub-agent runs, outcomes and one-line summaries. It reads exact numbers from harness hooks and
local transcripts and sends batched, idempotent events to an ai-obs server.
Design: [BRIEF §5](../../BRIEF.md), ADR-0001, ADR-0004, ADR-0005, ADR-0008, ADR-0011, ADR-0028 – ADR-0030 (one
deployment per company, per-user tokens with device login, the project dot file; brief:
[`docs/briefs/single-deployment-per-user-tokens.md`](../../docs/briefs/single-deployment-per-user-tokens.md)).

- Node ≥ 20, **no runtime dependencies** (only `node:` built-ins).
- Harnesses: Claude Code and Codex. Each one is an adapter in `src/adapters/<name>/`.

## Install

```sh
npx ai-obs-cli login --server https://obs.example.com        # approve the code in the browser
npx ai-obs-cli init                                          # user-level hooks (--project: this repository only)
```

One ai-obs server is one company (a "deployment"). A token belongs to you (or to a service user an admin made) and
identifies you on that server; which **team** a repository reports to comes from a dot file in the repository (see
"The dot file"). A machine can be logged in to several servers, one token per server (see "Several servers").

### `ai-obs login`

```sh
ai-obs login --server https://obs.example.com              # device login (browser)
ai-obs login --server https://obs.example.com --no-browser # print the URL only (SSH, containers)
ai-obs login --server https://obs.example.com --token -    # paste a token made under "My tokens" (read from stdin)
```

1. **Device login** (the default): `POST <server>/api/v1/device/code` with this machine's name (`--label` overrides
   it) and the collector version. The CLI prints `Open <server>/device and enter the code XXXX-XXXX` and opens the
   browser (not over SSH, not on Linux without a display, not with `--no-browser`). The URL is always built from
   `--server`, never taken from the server's answer. On the page you see the machine name and the requester IP, and
   Approve or Deny. Meanwhile the CLI polls `/api/v1/device/token` every `interval` seconds (5 by default, 5 s more
   after each `slow_down`), keeps polling through network errors, and stops on `access_denied`, `expired_token`,
   `invalid_grant` or when the 10-minute code expires. A 429 while polling waits at least the server's `Retry-After`
   (at most 60 s between polls). A 429 on the code request ends the login with the server's reason (too many logins
   waiting for approval server-wide, or too many from this address) and its `Retry-After`. A server without device
   login (HTTP 401, 404 or 405 on `/api/v1/device/code`; a 0.3 / 0.4 server answers 401) gets the hint to paste a
   token from "My tokens" with `--token -`. A device-login token is valid for **90 days**. If the approval answer is
   lost (network error at that moment), the code is spent and the CLI says so: the token the server made then is
   never used, so revoke it under "My tokens".
2. **Pasted token** (`--token <t>` or `--token -` for stdin): a token from "My tokens" in the dashboard, with the
   lifetime chosen there (30 / 90 / 365 days or none). Only `aiobs_u_…` tokens exist; the retired company
   (`aiobs_c_`) and team (`aiobs_t_`) tokens are refused.
3. Either way the token is checked with `GET /api/v1/collector-config`, which returns the deployment, your e-mail,
   your teams, the token's expiry, label and source, and the project naming mode. A 401 / 403 changes nothing; a
   429 is retried after `Retry-After` (at most 3 tries, 60 s). If the server cannot be reached for a pasted token,
   the token is stored unchecked and nothing is sent until the server answers.
4. The token is stored in `~/.ai-obs/config.json` (mode 0600) as the entry of that server, under the worker lock.
   **Logging in to the same server again replaces its token**: events queued for the old one are sent with the new
   one (streams are keyed by server, not by token). The old token stays valid on the server until it expires or is
   revoked under "My tokens". **When the new token belongs to another account** (another e-mail, or a person
   replaced by a service user, as collector-config says), the previous account's queued events are not sent as
   the new one: they are moved to `~/.ai-obs/queue/set-aside/<ulid>/` (with an `about.json` naming both accounts)
   and kept there, unsent. `--keep-queue` sends them with the new token instead; to send a set-aside batch later,
   move the directories in its `p/` and `u/` back into `~/.ai-obs/queue/p/` and `queue/u/`. A token that could not
   be checked at login, or an entry that was never checked, cannot be compared (its queue is sent with the new
   token, as before), nor can two service users. The hook runtime in `~/.ai-obs/app` is refreshed first.
   Until collector-config answers, the entry shows as "(not checked yet)".

`--server` defaults to `AI_OBS_ENDPOINT`, else the only registered server; with several it is required.
`ai-obs init --token <t> --endpoint <url> [--label <name>]` is the non-interactive form (login with a pasted token,
then the hooks), for scripts and CI.

### `ai-obs init`

Installs the hooks of every detected harness; run it after the first login and after every upgrade.

1. Migrates an older home (see "Upgrading to 0.5") and copies the collector (`bin/`, `dist/`, `package.json`) to
   `~/.ai-obs/app`, so hooks keep working after the npx cache is cleared.
2. Installs hooks in every detected harness. Each hook runs `<node> ~/.ai-obs/app/bin/ai-obs.js hook <harness> <hook>`.
   With `--project`, the hooks go into the repository's harness config; no token is ever written there.
3. Prints the next steps only you can do. For Codex: **open Codex once and run `/hooks` to trust the new hooks**.
   Codex does not run untrusted hooks, so nothing is recorded until you do.

Without a login `init` still installs the hooks, and says that nothing is recorded until `ai-obs login`.

### The dot file (`.ai-obs.json`)

A repository says where its sessions report in a file at its git top level:

```json
{ "server": "https://obs.example.com", "team": "platform" }
```

| Key | Meaning |
|---|---|
| `server` | The ai-obs server (http/https URL) this repository's sessions go to. Optional with one registered server |
| `team` | The team slug (1–63 of `a-z`, `0-9`, `-`) the sessions are attributed to. Optional |

- **`.ai-obs.json` is committed**, so everyone working in the repository reports to the same server and team.
  **`.ai-obs.local.json`** (git-ignored) has the same keys and overrides the committed file per key, for a personal
  choice. Unknown keys are ignored. Tokens never go in either file (`link` refuses and strips them; `status` and
  `doctor` report a file that holds one with ✗: remove it and revoke the token). `server` is at most 512 characters.
- **Lookup**: from the session's working directory up to the directory that holds `.git` (no git call); the first
  directory with either file wins (so a package of a monorepo may have its own). Nothing outside a git repository is
  read. The result is cached in `state/dot-files.json` and checked with a few `stat` calls, so the hook stays inside
  its budget. A **malformed file counts as absent** and is reported by `status` and `doctor`.
- **Write it with `ai-obs link --team <slug> [--server <url>] [--local]`**. The server defaults to the one the dot
  file already names, else the only registered server. When this machine is logged in to that server, the team is
  checked against your teams in its collector-config (a team you are not in is refused); otherwise `link` warns and
  writes anyway. `--local` writes `.ai-obs.local.json` and adds it to `.gitignore`. The file goes to the git top level,
  also when `--project-dir` names a subdirectory. Events of the repository that were recorded while no server was
  chosen move to the linked server.
- **The server decides the team** (ADR-0030): an admin's project → team mapping wins; else the dot-file team if you
  are a member of it; else your primary team; else none. A team you are not in, or an unknown slug, is ignored and
  the server answers a warning (`team_not_member`, `team_unknown`) that `status`, `doctor` and the next session's
  start text show.
- **Pinned per session**: a session keeps the server and team in force at its first hook, also when the dot file
  changes while it runs; the next session takes the new values. A session that started while no server was chosen
  joins the repository's server from its next event once there is one.

### Several servers

```sh
ai-obs login --server https://obs.acme.example
ai-obs login --server https://obs.globex.example
cd ~/work/billing && ai-obs link --server https://obs.globex.example --team web
```

- **With one server nothing more is needed**: every repository without a dot-file server reports to it.
- **With two or more**, a repository reports to the server its dot file names. A repository without one keeps its
  events on this machine (nothing is sent anywhere) and the session start asks your agent to run `ai-obs link`.
- **A token is only ever sent to its own server.** A dot file naming a server this machine is not logged in to
  (a committed file from a teammate, say) never makes the collector send anything there: its events wait, and the
  session start asks you to run `ai-obs login --server <url>`.
- `ai-obs token list` shows each server with its account, deployment, label, expiry, state and the repositories
  delivered to it; `ai-obs token remove <server>` forgets a token (its queued events stay on the machine; revoke the
  token in the dashboard if it may have leaked).

### Token expiry

Device-login tokens expire after 90 days, pasted tokens when their chosen lifetime ends. The collector keeps the
expiry from collector-config in `config.json` and:

- **14 days before** it, `status` and `doctor` warn and the session start of a repository on that server says so
  once per session;
- **from the expiry on**, it sends nothing with that token (checked locally, also on `ai-obs flush`) and asks you to
  run `ai-obs login --server <url>`;
- a token the server refuses (401: expired or revoked) blocks that server with "token expired or revoked: run
  ai-obs login --server <url>"; the other servers keep sending. The next login (a new token) unblocks it.

While a server is refused or its token expired, its queued events are kept and **that time does not count** against
the 30-day queue age cap.

### The SessionStart text

The SessionStart hook puts one short text into the agent's context only when:

1. the repository has no dot-file server and two or more servers are registered: ask the user, then
   `ai-obs link --server <url> --team <team> --project-dir <repository root>`;
2. the repository's server has no token, or an expired or refused one: tell the user to run
   `ai-obs login --server <url>` (never ask for a token);
3. that server's token expires within 14 days;
4. queued events were dropped by the caps (only the ones dropped since the text last mentioned drops);
5. the server ignored this repository's dot-file team (latest warning): your primary team is used, or no team if you
   have none.

It needs no network, carries only identifiers (hosts, server URLs, team slugs, the sanitized directory), never a
token or an e-mail, is at most 1000 characters (the repeated command is written once, then plainly as `ai-obs`, then
`--project-dir` and the list of hosts are shortened, then a server URL is named by its host only) and appears at most
once per session per text. Claude Code gets
it as JSON `additionalContext`, Codex as plain text (see `src/adapters/codex/FORMAT.md`).

### Upgrading to 0.5 (from 0.3 or 0.4)

**0.4.0 was never published**: 0.5.0 is the next release after 0.3.0 on npm and also carries the live session work
(`turn_started`, `ai-obs live`, summaries after the flush; ADR-0027). Upgrade the server first (migration 0018 and the
web / ingest release); a 0.5 collector needs the device-login routes and the new collector-config.

**The package is renamed**: 0.3.0 went out as `@soukupl/ai-obs`; 0.5.0 and every later release are `ai-obs-cli`
([ADR-0031](../../docs/adr/0031-npm-package-name-ai-obs-cli.md)). The command is still `ai-obs`, the hooks and `~/.ai-obs` are
unchanged (the hooks run the runtime copied to `~/.ai-obs/app`, never the npm name), and `@soukupl/ai-obs` is deprecated on
npm with a pointer here.

```sh
npx ai-obs-cli@0.5.0 init            # refreshes the runtime and the hooks, and migrates ~/.ai-obs
npx ai-obs-cli status                # then check server, token expiry and this repository's team
```

`ai-obs` is not on PATH after `npx`, so use `npx` for the follow-up commands too.

The first 0.5 command that finds the worker lock free (or the background worker) migrates the home, once, and says
what it changed. It first refreshes an older hook runtime in `~/.ai-obs/app` (an older runtime would read the new
config as "no token" and drop every hook job); if the runtime cannot be refreshed, nothing is migrated and the
command says to run `ai-obs init`. Then:

- `config.json` version 2 → **version 3**: every user token (`aiobs_u_`) becomes the entry of its server (endpoint
  kept; deployment, e-mail and expiry are learned at the next collector-config fetch). **Company tokens (`aiobs_c_`)
  are dropped** with a message: run `ai-obs login` for that server. A server keeps one token: of two user tokens
  for one server (several companies on one dev server), the one more repositories in `projects.json` used is kept
  (on a tie, the later one). The message names both accounts (e-mail, company, repositories) and which one was
  dropped; to report as the dropped account on this machine, run `ai-obs login --server <url>` and approve with it.
  Routing epochs, `legacy`, malformed entries and rotation fingerprints are discarded. The old file is kept as
  **`config.json.v2`** (mode 0600; it holds the old tokens, so delete it when you no longer need them).
- `projects.json` and `ai-obs use` are gone: the file is renamed to `projects.json.v2` and kept for inspection. Write
  `.ai-obs.json` with `ai-obs link` instead.
- Queued streams are converted: data bound to a token goes to that token's server (no team); data recorded while a
  repository had no choice goes to the only server, or, with several, waits until you `ai-obs link` the repository.
  `queue/dead/pre-upgrade/` is left as it is.
- The kept user token stays valid after the cutover (its expiry is set by the server); there is no need to log in
  again until `status` says so, unless it is the account you did not want (see above). A token the server no longer
  accepts shows as REJECTED: run `ai-obs login --server <url>`.

Sessions running during the upgrade keep their stream. `MIN_COLLECTOR_VERSION` is raised to 0.5.0 by the operator
after the rollout. The collector has a devDependency on `@ai-obs/db` for one test (it keeps the local price table
equal to the dashboard's); the runtime still has no dependencies.

### Upgrading from 0.1 / 0.2

A 0.1.x `config.json` (a single team token) loads with no server: run `ai-obs login`. Batches 0.1.x left in
`queue/*.ndjson` are never sent; 0.2 – 0.4 moved them to `queue/dead/pre-upgrade/`, which 0.5 leaves as it is (delete
it when you no longer need it). Old `jobs/<id>.json` hook jobs and 0.1.x session state are still processed; a
session state without a working directory has its events dropped (logged).

**Node path caveat (nvm, fnm, Volta, asdf, Homebrew).** Hooks run the absolute path of the Node that
executed `init` (`process.execPath`), so they do not depend on `PATH` at hook time. With a
version-managed Node that path contains the version (`~/.nvm/versions/node/v22.1.0/bin/node`). When
you remove or upgrade that version, the hooks silently stop working. `init` prints a warning when it
detects such a path, and `ai-obs doctor` reports a missing or non-executable node binary (or a missing
`~/.ai-obs/app` script) with the fix: run `ai-obs init` again, ideally under a Node that stays.

**Project-scope hooks (`--project`).** The hook command is the same absolute command as in user
scope, so the repo's `.claude/settings.json` or `.codex/hooks.json` holds paths of this machine. They
do not work for teammates or on CI, and `init --project` warns about it. Keep the file out of git
(for example in `.git/info/exclude`), or let every teammate run `ai-obs init --project` themselves. We
do not write a relative command such as `node ./node_modules/.bin/ai-obs …`: harnesses run hooks in
the session's working directory, which is not always the repo root, and a hook that cannot find its
script fails silently.

Options:

| Option | Purpose |
|---|---|
| `--server <url>` | `login`, `link`: the ai-obs server. Default for `login`: `AI_OBS_ENDPOINT`, else the only registered server |
| `--token <t>` / `--token -` | `login`, `init`: a pasted token (`-` reads it from stdin) instead of the device login |
| `--no-browser` | `login`: print the device URL without opening a browser |
| `--label <name>` | `login`, `init --token`: the client name shown on the approval page and in "My tokens" (default: this machine's hostname) |
| `--endpoint <url>` | `init --token`: the server of that token |
| `--keep-queue` | `login`: when the new token belongs to another account, send the previous account's queued events with it instead of setting them aside |
| `--team <slug>` | `link`: the team the repository reports to |
| `--local` | `link`: write `.ai-obs.local.json` (git-ignored) instead of `.ai-obs.json` |
| `--harness claude-code,codex` | `init`: limit setup to these harnesses |
| `--project-dir <dir>` | `init --project`, `link`, `uninstall`: the repository root (for `link`, a subdirectory is resolved to its git top level). Default: the git top level of the current directory |
| `--home <dir>` | Collector home. Works with every command |
| `--yes` | With `uninstall --purge`: skip the confirmation |

## Commands

| Command | Does |
|---|---|
| `login [--server <url>] [--token <t>\|-] [--no-browser] [--label <name>] [--keep-queue]` | Log this machine in to a server (device login or a pasted token), as described above |
| `init [--project] [--project-dir <dir>] [--harness …] [--token <t> --endpoint <url> [--label <name>]]` | Install the hooks (and, with `--token`, log in first) |
| `link --team <slug> [--server <url>] [--local] [--project-dir <dir>]` | Write the repository's dot file (server and team), checking the team on the server |
| `token list` | Servers: endpoint, e-mail, deployment, label, expiry, repositories delivered, queued events, state |
| `token remove <server>` | Forget a server's token (URL or host). Its queued events stay on this machine |
| `doctor` | Checks the config, each server (reachable, token valid or expired / revoked, expiry, your teams, minimum version, naming), this repository (dot-file validity, its server and token, its team, the server's warning), each harness (installed, version supported, hooks installed), the node binary and script baked into the hooks (✗ with "run `ai-obs init` again" when they are gone), Codex hooks waiting to be trusted (`!`), the queue and the last send per server. Prints ✓, ! or ✗ per check and exits 1 if any check shows ✗ |
| `status` | Local state without the network: servers with account, deployment, expiry and state; this repository's dot file, server, token state, team and latest warning; queue size and what is kept (no server chosen, not logged in, refused / expired, unresolved, pre-upgrade); dropped events; pending hook jobs; summaries (`<n> waiting for retry, <m> due`); last send and last error |
| `flush [--wait <s>]` | First runs every adapter's idle-session sweep (Codex ends sessions idle for 1 h, Claude Code ones silent for 24 h) and writes the staged and pending summaries (`<Harness>: summaries X of Y done, Z still waiting`; while the background worker holds `summaries.lock` it says so and skips this), then sends the queue now, per server, ignoring the retry backoff and retrying a refused server once (an expired token is never used). Kept data stays kept (exit 0); exit 1 when a server failed or refused |
| `live [--cwd] [--once]` | Watch the Claude Code and Codex sessions running on this machine: a table redrawn about once per second (alternate screen, in place; `q`, `Q` or Ctrl-C quits and restores the terminal). Local only: no network, nothing written, hook state files and offsets untouched, works without a login. `--cwd` narrows to the current git repository (or the directory itself outside one). `--once`, or a stdin or stdout that is not a terminal, prints one frame without escape codes and exits 0; on a non-terminal it is cut at 200 columns, with `--once` on a terminal at the terminal width. An unknown flag exits 2 with the usage text. Details below |
| `uninstall [--purge [--yes]] [--project-dir <dir>]` | Removes our hooks from user scope and from the current repo. `--purge` also deletes `~/.ai-obs`: tokens and queue (with all local state); it needs `--yes` while unsent events wait. Dot files in repositories are not touched |
| `hook <harness> <hook>` | Internal. Harness hooks call it. It always exits 0 |

## Files (`~/.ai-obs`, or `$AI_OBS_HOME`)

| Path | Content |
|---|---|
| `config.json` | Version 3, mode 0600: `{version: 3, machine_id, created_at, servers[]}`. A server entry: `endpoint`, `token`, `email` (null for a service user or until checked), `deployment {name, slug}`, `label`, `expires_at` (null = no expiry or not known yet), `source` (`device` \| `manual`; null until collector-config answered for the token), `added_at`. One entry per endpoint; its token is only sent there |
| `config.json.v2` | The 0.2 – 0.4 config.json (mode 0600, with its tokens), kept by the migration and no longer read; delete it when you no longer need it |
| `projects.json.v2` | The 0.2 – 0.4 per-repository choices, renamed by the migration and no longer read (the migration reads them once, to choose between two tokens of one server) |
| `project-secret` | Random 32-byte hex secret (mode 0600, created on first use, never sent) that keys the hash of a repo with no remote |
| `queue/p/s-<id>/` | One stream per (project key, server endpoint, team slug), each with `stream.json` (`{key, endpoint, team}`; `endpoint` "" = no server chosen yet, `team` "" = no dot-file team) and `*.ndjson` segments named by ULID |
| `queue/u/s-<id>/` | Streams whose project key could not be resolved when recorded (git timed out), with their server and team. A later flush adopts them into their project stream |
| `queue/p/o-…`, `queue/p/t-…` | 0.2 – 0.4 streams, converted to `s-` streams by the migration |
| `queue/*.ndjson` | The pre-upgrade stream written by 0.1.x: frozen, never sent |
| `queue/dead/` | Batches the server refused as a whole (HTTP 400), kept for inspection (max 5 MB), and `pre-upgrade/` (left as it is) |
| `queue/set-aside/<ulid>/` | Queued streams of a previous account, moved by a `login` that replaced its token with another account's (`p/`, `u/`, `about.json`). Never sent, not counted in the queue cap; move them back into `queue/p/` / `queue/u/` to send them with the current token, or delete them |
| | Queue caps: ~50 MB for the whole queue (oldest segment first) and 30 days for streams that can be sent now, counted from when the stream became sendable (`sendable_since` in its `stream.json`), so data that waited (no server chosen, not logged in, refused, expired) gets its full 30 days once it can be sent; waiting time does not count. Every drop is counted in `state/dropped.json` and shown in `status`, `doctor` and `flush`, and once in the next SessionStart text (`state/dropped-shown.json` keeps the counters it last mentioned, so the text reports only new drops) |
| `jobs/*.v2.json` | Hook invocations waiting for the worker (0.1.x wrote `<id>.json`, still read). They hold the raw hook payload and stay on this machine |
| `state/<harness>/<session>.json` | Per-session adapter state, such as transcript cursors, provisional outcomes and the session's pinned stream |
| `state/summaries/<harness>.json` | Turn digests whose summary failed or was not tried yet, with their stream key. They are retried for up to 5 attempts or 7 days (staged digests expire after 7 days too) and stay on this machine |
| `state/summaries/staged/<harness>/<ulid>.json` | Digests due for a summary (mode 0600, local only). The hook job writes them before it clears them from the session state; the summary phase deletes them after the summaries are queued |
| `state/collector-config/<host>.json` | Cached collector-config per server (`:` in the host written as `_`). TTL 6 h; after a failed fetch, the next try waits 10 min |
| `state/delivery.json` | Per server host: last attempt, last success, last error, backoff, a `blocked` flag (401 / 403) and the repositories delivered (`token list`) |
| `state/warnings.json` | Latest ingest warning per project key (`team_not_member` / `team_unknown`, team, server, session) |
| `state/dropped.json` | Counters of events dropped by the caps, split into waiting and sendable |
| `state/project-keys.json` | Working directory → project key cache (500 entries) that the hook reads without running git |
| `state/dot-files.json` | Working directory → dot-file lookup cache (500 entries), checked with `stat` calls |
| `state/nudged/<session>` | Marker that the SessionStart text was shown in a session (deleted after 7 days) |
| `log/collector.log` | Errors and warnings from hooks and the worker. Rotated at 1 MB. Prompts and paths are never logged |
| `app/` | The collector copy that hooks run |
| `worker.lock` | Held by the single worker, a `flush`, and the write phase of `login`, `init`, `link` and `token remove` |
| `summaries.lock` | Held by the worker's summary phase (or `flush`) while it runs the model call. Separate from `worker.lock`, so hooks and sends are not blocked by it |

## How hooks work

```
harness hook ─▶ ai-obs hook <harness> <hook>      (always exit 0)
                 ├─ read stdin JSON (50 ms idle timeout)
                 ├─ write jobs/<ulid>.v2.json  (payload, cwd, harness env vars minus secrets)
                 ├─ spawn detached worker ─▶ dist/worker-main.js
                 └─ SessionStart only: print the link / login / expiry text when there is one (local files only)

worker:  take worker.lock (or exit: the holder picks the job up)
         ├─ for each job, oldest first: adapter.handleHook(job, ctx)
         │     pins each session once, at its first hook: project key + the dot file's server and team
         │     (else the only server) → one queue stream per (project, server, team)
         │     (+ adapter.sweepCrashedSessions after session-start hooks)
         ├─ (first run after an upgrade: migrate config.json v2, projects.json, o- / t- streams)
         ├─ flush: send every stream to its server's entry (no entry → kept); per server
         │     ≤ 500 events / 1 MB per batch, gzip, that server's Bearer token and naming
         └─ release lock, re-scan jobs/ (and run again when config.json changed)

summary phase (after the flush, under ~/.ai-obs/summaries.lock, at most 3 passes):
         ├─ summarise the staged + pending digests (one headless call per chunk of 25; worker.lock is NOT held;
         │     no chunk starts after 5 min, the rest waits as pending)
         ├─ take worker.lock (waits up to 60 s), queue the turn_summary events, send them in a second flush
         └─ jobs that arrived meanwhile are processed in the same run
```

- **SessionStart text.** The time budget counts in-process from hook entry (Node start-up is not counted). The hook
  reads config.json, the dot file (a bounded `stat` walk, cached in `state/dot-files.json`) and the delivery state;
  it needs the project key only when a server warning exists, from `state/project-keys.json` (a cached key is used
  only while the directory's git config is unchanged). On a cache miss it runs git for at most 40 ms, and only when
  less than 40 ms have passed, then kills it; when git is slower, this session shows no warning and the next one
  does. It does no network call and prints at most once per session and text. The Claude Code `SessionStart` entry
  has `timeout: 5`. Every other hook prints nothing.
- **Summaries** (ADR-0027). When digests are due (session ended, 10 waiting, or the oldest has waited 10 minutes) the hook
  job only stages them to `state/summaries/staged/<harness>/<ulid>.json` and clears them from the session state after
  that. The worker's summary phase writes the summaries in chunks of 25; a chunk that has not finished after 130 s counts
  as a failed attempt, and after 5 minutes no further chunk starts: what was written is sent and the rest waits in
  `state/summaries/<harness>.json`. If `worker.lock` stays busy (60 s), nothing changes and the next run retries. A summary keeps its event id across retries (its time is the digest's first
  staging or failure time).
- **Recursion guard.** `bin/ai-obs.js` exits immediately when `AI_OBS_SUMMARIZING` is set. The
  summarizer sets that variable on the headless model call it starts.
- **Delivery.** A batch is acked (removed from the queue) only after a 2xx response. Server
  duplicates and per-event rejections count as delivered. State is per server (keyed by host): on network errors,
  5xx or 429 (which honours `Retry-After`) that server's events stay queued with exponential backoff (30 s up to
  1 h), and the other servers keep sending. A 401 or 403 keeps that server's batches, stops sending with its token
  ("token expired or revoked: run ai-obs login --server <url>"), and shows in `status`, `doctor` and the SessionStart
  text; automatic flushes skip it, `ai-obs flush` tries it once, a new login clears it. A token past its
  `expires_at` is never used. `maxBatches` per flush counts per server. Hook-triggered flushes respect the backoff;
  `ai-obs flush` ignores it. On 413 the batch size is halved; on 400 the batch goes to `queue/dead/`. Nothing is
  sent with a token whose collector-config was never fetched; a fresh collector-config (fetched by a send, `doctor` or
  `link`) also updates the server entry (e-mail, deployment, label, expiry). `session_start.project` is rebuilt at send time from the stream key
  with the receiving deployment's naming mode and salt, plus the stream's dot-file `team`; skill / MCP names are
  hashed the same way. An ingest response's `warnings` (`team_not_member`, `team_unknown`) are kept per project in
  `state/warnings.json`; a later batch whose sessions start without one clears it (not a batch with server-side
  duplicates: a replayed `session_start` gets no team resolution, so no warning).
- **Idempotency.** Event builders derive `event_id` from a seed plus the event time (`ulidFrom`), so
  re-processing a transcript after a crash produces the same IDs, and the server de-duplicates them.
- **Crashed jobs.** A job is renamed to `*.processing` before it is handled. If the worker dies, the
  next worker drops that job instead of retrying it forever. Adapters re-read transcripts from their
  cursor, so no data is lost.

## Writing an adapter

Create `src/adapters/<name>/index.ts` that exports `const adapter: HarnessAdapter`, then register it
in `src/adapters/index.ts`. The contract is in [`src/adapters/types.ts`](src/adapters/types.ts):

| Member | Contract |
|---|---|
| `name`, `displayName`, `sessionStartHooks` | Identity. After any hook listed in `sessionStartHooks`, the worker calls `sweepCrashedSessions` |
| `detect({projectDir?})` | Reports installed, version, versionSupported and hooksInstalled `{user, project}`. Never throws |
| `nextSteps?` | Lines `init` prints after installing this harness's hooks (Codex: trust them with `/hooks`) |
| `installedHookCommands({projectDir?})` | Optional. The shell commands of our installed hooks; `doctor` checks that their node binary and script still exist |
| `installHooks({scope, projectDir?, hookCommand})` | Writes `hookCommand(hookName).shell` (or `.argv`) for each hook. Idempotent, and keeps unrelated config |
| `uninstallHooks({scope, projectDir?})` | Removes only our entries; use `isAiObsHookCommand()` to recognize them |
| `handleHook(invocation, ctx)` | Runs in the worker. Reads the transcript from the cursor in `ctx.state`, builds events with `src/events.ts` and enqueues them into the session's pinned stream (`ctx.streamFor(holder, capturedAt)`) |
| `sweepCrashedSessions(ctx)` | Finishes sessions that never got an end hook and emits `session_end` with reason `crashed` |
| `summarize(digests, ctx)` | One headless call to the cheapest model. Implement it with `summarizeWithCommand()`. Never call it directly; use `ctx.scheduleSummaries(digests, key)`, which stages the digests for the post-flush summary phase (synchronous; `false` = the staged file could not be written, keep the digests and retry at the next due hook) |

Shared, harness-neutral helpers:

| Module | Use |
|---|---|
| `src/events.ts` | `sessionStartEvent`, `turnEvent`, `runEvent`, `turnOutcomeEvent`, `turnSummaryEvent`, `sessionEndEvent`, `countTools`, `toolKey` |
| `src/analysis/phases.ts` | `classify(tool, {command, filePaths})`, `classifyCommand`, `checkKind`, `attributeTime(timeline, endAt)`, `toPhasesMs`, `PHASE_RULES_VERSION` |
| `src/analysis/tokens.ts` | `sumUsage(records)` de-duplicates by response id and sums per model × effort. Also `mergeUsage`, `primaryModel` |
| `src/analysis/outcome.ts` | `provisionalOutcome(signals)`, `finalOutcome(provisional, followUp)`, `isRevertCommand`, `editFingerprint` / `detectRevert` |
| `src/analysis/corrections.ts` | `looksLikeCorrection(nextPrompt)`: EN and CZ heuristics |
| `src/analysis/digest.ts` | `buildDigest()`. Truncates the prompt and the last message to 300 chars. Digests are used locally only |
| `src/analysis/summaries.ts` | `summarizeWithCommand`, `runSummaryCommand` (sets `AI_OBS_SUMMARIZING=1`, 120 s timeout), `buildSummaryPrompt`, `parseSummaryResponse`, `summariesDue` (session end / `SUMMARY_BATCH` = 10 turns / `SUMMARY_MAX_WAIT_MS` = 10 min, ADR-0023) |
| `src/project-key.ts` `resolveProjectKey(cwd)` | The plain project key: normalized git remote, else git top level, else the directory. Hashing happens at send time |
| `src/analysis/usage.ts` | Skill / MCP usage (ADR-0016): `parseMcpTool`, `addSkill`, `addMcp`, `mcpFromTools`, `mergeSkills` / `mergeMcp`, wire normalisation, `skillReadBy` (Codex SKILL.md reads) and `applyUsageNaming` / `hashUsageName`. Adapters pass **plain** names to `turnEvent` / `runEvent` (`skills`, `mcp`); the sender hashes them in `hashed` mode when it sends |

Token convention (matches `packages/db`): `input` excludes cache reads and writes; `reasoning` is part
of `output`; a turn's totals are the sum of its `usage` rows.

Outcome flow:

1. At Stop, the `turn` event carries `provisionalOutcome(…)`.
2. When the next prompt arrives, the adapter sends `turnOutcomeEvent({outcome: finalOutcome(prev, {correction: looksLikeCorrection(prompt), revert}), at: promptTime})`
   for every turn still waiting for it (Claude Code: the last human turn and the task-notification
   turns after it).
3. At session end, every turn still waiting gets `finalOutcome(prev, {sessionEnded: true})`.

### Claude Code adapter (`src/adapters/claude-code/`)

The real hook and transcript format (field names, version 2.1.289) is documented in
[`src/adapters/claude-code/FORMAT.md`](src/adapters/claude-code/FORMAT.md).

**SessionStart output.** The SessionStart text is printed as JSON, `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "…"}}`, one line.

**Hooks.** The adapter writes `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`,
`SubagentStop` and `SessionEnd` to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`), or to
`<repo>/.claude/settings.json` with `--project`.

- It adds one group per event, `{hooks:[{type:"command", command:"<node> <bin> hook claude-code <Event>"}]}`.
- Re-running `init` replaces our entry, and `uninstall` removes only ours.
- The `SessionStart` entry has `timeout: 5` (seconds). Re-running `init` rewrites it, so existing installs get it.
- Before each change, the previous file is copied to `settings.json.ai-obs.bak`.
- A file that is not valid JSON is never overwritten.

| Module | Role |
|---|---|
| `index.ts` | The adapter (`createClaudeCodeAdapter()` for tests) and the summary command |
| `handlers.ts` | Hook dispatch, `session_start` / `turn_started` / `session_end`, crash sweep, staging digests for summaries (at session end, every 10 turns, or after 10 minutes) |
| `session.ts` | Turn segmentation from the cursor, continuations, outcome patches, sub-agent runs |
| `analyze.ts` | One stretch of activity: tokens, phases, tools, edits, checks, interrupts |
| `transcript.ts` | Byte-cursor JSONL reader; slims each line to ids, numbers and phase decisions |
| `subagents.ts` | `subagents/agent-<id>.jsonl` + `.meta.json`, and `subagents/workflows/<wf_id>/agent-*.jsonl` + `journal.jsonl` → `run` events |
| `run-links.ts` | Agent flow links between the runs of one turn (`item` / `sequence`, ADR-0020) |
| `settings.ts` / `detect.ts` | `settings.json` merge, version (`claude --version`, cached 6 h) |

How the adapter works:

- **Turns.** A prompt starts a turn. Prompts are typed text, slash commands and task notifications;
  tool results, meta entries, local-command output and interrupt markers do not count. The turn ends
  at the next prompt or at the `Stop` / `StopFailure` that follows. `turn_id` is the prompt entry's
  `uuid`.
  - **`turn_started`.** `UserPromptSubmit` (main agent only, task-notification prompts included) also sends a
    `turn_started` event with the hook time. Its `turn_id` is the uuid of the transcript prompt matched to the hook
    (`prompt_id` against the entry's `promptId`; without them, a prompt from 10 s before to 1 s after the hook time),
    null when the prompt is not in the transcript yet. A `UserPromptSubmit` never ends its own prompt's turn, even when
    a late worker already sees the replies; that turn is emitted at its `Stop`. Earlier interrupted turns still end at
    `UserPromptSubmit`.
  - **Late reads:** a prompt written after the hook fired stays open, so a worker that runs late
    never cuts the next turn short.
  - **Interrupted turns** get no `Stop`. They end at the next `UserPromptSubmit`, `Stop` or session
    end.
  - **Injected notifications:** a task notification that arrives inside a running turn is part of
    that turn.
- **Continuations.** Activity after a `Stop` with no new prompt (a blocking Stop hook, queued meta
  input) is added to the previous turn. The turn is then re-sent under a new event id, and the server
  replaces its usage rows.
- **Tokens.**
  - **Source:** each assistant entry's `message.usage`, de-duplicated per `message.id` (Claude Code
    writes one entry per content block, each repeating the usage). `reasoning` comes from
    `output_tokens_details.thinking_tokens`, and effort from the entry's `effort` field.
  - **What the turn reports:** the main agent plus every sub-agent run counted into it, as the
    ingest API expects.
  - **Model:** the turn's `model` is the main agent's primary model.
- **Sub-agents.** Each `subagents/agent-<id>.jsonl` becomes a `run` event, linked to the turn
  through `meta.toolUseId` → the `Agent` tool_use.
  - **Fields:** `parent_run_id` is the parent agent's id for nested agents and null for agents the
    main agent spawned. `depth` follows the nesting, and `agent_type` comes from the meta file (or
    the tool's `subagent_type`). `agent_group` is the same agent type (omitted when it is unknown).
  - **No `main` run:** the main agent is not sent as a run, because the protocol defines
    `parent_run_id: null` / `depth: 1` as "spawned by the main agent".
  - **Delegating time:** the parent's time waiting for a sub-agent is `delegating`, which is not
    reported for the parent.
  - **Background sub-agents** that finish after `Stop` are sent at their `SubagentStop`, together
    with a re-sent turn.
  - **Flow:** each run carries `links` to the sibling it followed (`sequence`: same parent, the
    sibling with the latest end not after its start; parallel siblings are not chained).
- **Workflow sub-agents.** The Workflow tool runs its agents in the background, under
  `<session>/subagents/workflows/<wf_id>/agent-*.jsonl`. Without these, their tokens would be missing.
  - **Linking:** the Workflow tool result (`taskType: local_workflow`, `runId: wf_…`) ties the run to
    the turn that launched it. Each agent becomes a `run` with `parent_run_id: null` and `depth: 1`
    (spawned by the main agent), and its usage is added to that turn, which is re-sent.
  - **Fields:** `agent_type` is `workflow:<label>` (a slug of the meta `description`, ≤ 48 chars;
    `workflow-subagent` when there is no label). `agent_group` is `workflow:<phase slug>` when the
    workflow phase is known, else `workflow:<label verb>` (first token of the label's slug, i.e. of
    the stored `agent_type`, split on `[-:._/ ]`, lower-cased, trailing digits stripped; plain
    `workflow` when empty; the same rule the dashboard applies to rows without a group), and
    `orchestration_id` is the workflow run id (`wf_…`). `ext` has `workflow_id`, `workflow_phase` and
    `workflow_label`. The script, the journal's results and the workflow `.json` are never read
    beyond the agent ids, the phases of `started` records and the final `status`.
  - **Flow (ADR-0020):** `stage_index` is the order in which the agent's phase first started in the
    journal (0-based); `flow_key` is the `<item>` of a `<stage>:<item>` label (`impl:data` → `data`,
    slugged, ≤ 64); `links` chains the agents of one workflow with the same `flow_key` in start order
    (`item`: `impl:data → verify:data → fix:data`). Links are computed over every run of the turn sent
    so far, so agents finishing in a later pass link back to earlier ones; an agent already sent whose
    incoming links change (a same-item agent that started earlier finished later) is re-sent with them
    under a new event id. Details in
    [FORMAT.md](src/adapters/claude-code/FORMAT.md#agent-flow-fields-stage_index-flow_key-links-adr-0020).
  - **When:** an agent is sent when the workflow journal (`journal.jsonl`) says it returned or
    failed, when its `SubagentStop` arrives, when the workflow is over (`<session>/workflows/<wf_id>.json`
    has a `status` other than `running`) or at `SessionEnd`. This is checked after every hook, so
    agents that finish between turns arrive with the next hook. An agent the journal lists as `failed`
    is a failed run.
- **Outcome.**
  - **At `Stop`:** the turn carries a provisional outcome: `StopFailure` → failed, an interrupt
    marker → abandoned, otherwise the last test or validate `Bash` exit code (`Exit code N` /
    `is_error`).
  - **Next human prompt** (`UserPromptSubmit`, or the next prompt in the transcript): runs the
    correction heuristics and sends a `turn_outcome` patch for every turn still waiting: the most
    recent human turn and the task-notification turns that followed it (background agents or a
    Workflow reporting back continue that turn's work). A correction fails all of them; otherwise
    they settle as usual (`unknown` → success, `no_failure_signal`).
  - **Reverts:** the next human turn reverting edits (by line hashes or a `git restore` /
    `checkout --` / `reset --hard`) fails the turns of that group that made edits, even after they
    were settled.
  - **Task notifications** do not settle anything (they only pass on a revert).
  - **Session end** (and the crash sweep): every turn still waiting becomes final (`unknown` stays
    `unknown`). Turns about to be dropped from the session state (more than 50 unsettled) are settled
    the same way first, so no turn stays provisional forever.
  - **Hooks inside a sub-agent** (payload with `agent_id`): `Stop` and `UserPromptSubmit` are
    ignored, and a `StopFailure` fails only that sub-agent's run (`failed`, `stop_failure`); the main
    turn keeps running.
- **Session state** is stored in `state/claude-code/<session>.json`. It holds the byte cursor of the
  first unprocessed prompt, the last few turns plus every unsettled turn (for continuations,
  follow-ups and late sub-agents; each with the ids of the sub-agent runs already sent for it, so a
  Workflow with hundreds of agents never re-sends one) and the pending digests. Paths, code and prompt text are not stored there, apart from the
  transcript path, the cwd and the digests' truncated text.
- **Resumed sessions:** a `SessionStart` with `source: resume|compact|fork` for a session never seen
  starts at the end of the file, so its history is not back-filled (a fork's transcript starts with a
  copy of the parent conversation, already counted under the parent). Any other first contact reads
  the transcript from the start.
- **Crash sweep** (after every `SessionStart`): a session silent for more than 24 h without
  `SessionEnd` is finished.
  - **What it sends:** the remaining turns, the outcome patches and `session_end` with reason
    `crashed`, followed by the summaries.
  - **Clean-up:** the state of ended sessions is deleted after 30 days.
- **Session title** (ADR-0026): the transcript's `custom-title` (`/rename`) and `ai-title` entries are tracked
  while it is read; after every hook the effective title (the `/rename` title wins over the generated one, the latest
  of each kind wins) is sent as a `session_title` patch when it differs from the one last sent (`title.sent` in the
  session state). A resumed session first seen mid-way starts at the end of its file, so a title written before that
  is sent only once Claude Code writes it again. Codex sends none.
- **Summaries** run at `SessionEnd`, and earlier once 10 turns are waiting or the first waiting turn
  has waited 10 minutes (`summariesDue`, ADR-0023; the wait starts at the hook that first saw the turn
  waiting, `digestsSince` in the session state): `claude -p --model haiku --output-format json
  --no-session-persistence --tools ""`, with the batched prompt on stdin and `AI_OBS_SUMMARIZING=1`.
  The command runs in the OS temp dir, and the reply's `result` field is parsed.

### Codex adapter (`src/adapters/codex/`)

The real hook and rollout format is documented in
[`src/adapters/codex/FORMAT.md`](src/adapters/codex/FORMAT.md): the fields, the versions seen, and how
sub-agents and session end show up.

**Hooks.** The adapter writes `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop` and `SessionEnd`
to `~/.codex/hooks.json`, or to `<repo>/.codex/hooks.json` with `--project`. It appends its own
matcher groups and leaves other hooks alone.

**SessionStart output.** Codex gets the question as plain text on stdout. codex-cli 0.154.0 rejected the JSON form, so the switch `SESSION_START_OUTPUT` in `src/nudge.ts` is `text` for Codex (see [FORMAT.md](src/adapters/codex/FORMAT.md), "Hook output"). The Codex hook entries are not changed by this release, so they need no new trust.

**After `init`, open Codex once and run `/hooks` to trust the new hooks.** Codex does not run untrusted
hooks. `ai-obs doctor` lists the ai-obs hooks that are still untrusted.

| Module | Role |
|---|---|
| `index.ts` | The adapter: hook dispatch, cursor sync, `SubagentStop` re-resolution, idle sweep |
| `session.ts` | Main-thread state machine: turns, outcome patches, digests, session end |
| `accumulator.ts` | Per-run accumulation: token deltas, phase timeline, tools, checks, patch facts |
| `records.ts` / `rollout.ts` | Rollout line parsing and incremental, byte-cursor reading |
| `tools.ts` | Classifying Codex tools, parsing `apply_patch` and exit codes |
| `subagents.ts` | Turning sub-agent threads (their own rollouts) into `run` events |
| `hooks-config.ts` / `detect.ts` / `locate.ts` | Merging `hooks.json`, trust and feature checks, version, finding rollouts |
| `summarize.ts` | `codex exec --ephemeral … -c features.hooks=false -m <smallest listed model> -` |

How the adapter works:

- **`turn_started`.** The `userpromptsubmit` hook (main thread only) sends `turn_started` with the hook time; `turn_id` is the hook payload's `turn_id`, or null.
- **Tokens** come from the differences between cumulative `total_token_usage` snapshots. Repeated
  snapshots are skipped, and cached input is subtracted from input.
- **Session state** is stored in `state/codex/<session>.json`. It holds the byte cursor, the open turn,
  the previous turn's outcome and the pending digests. Digests are staged for summaries at `SessionEnd`, once 10 turns are
  waiting, or once the first waiting turn has waited 10 minutes (same `summariesDue` rule as Claude Code,
  ADR-0023); the worker writes the summaries after its flush.
- **Idle sessions:** a session whose rollout has been idle for more than 1 h without a `SessionEnd`
  (crash or kill) is ended by the sweep with reason `crashed`.
- **Resumed sessions:** a session that started before `init` and is resumed afterwards is back-filled
  from the start of its rollout.

## `ai-obs live`

Lists the Claude Code and Codex sessions running on this machine (ADR-0027). **Sessions:** hook state files in
`~/.ai-obs/state/<harness>` younger than 2 h and not ended, plus Claude Code transcripts under
`$CLAUDE_CONFIG_DIR` (default `~/.claude`)`/projects/*/<uuid>.jsonl` that have no state file and were written in the last
30 minutes. **Columns:**

| Column | Meaning |
|---|---|
| STATUS | `working` or `idle`, with the time since the turn started / ended |
| HARNESS, PROJECT | Harness and the last path segment of the working directory |
| TITLE | The `/rename` title, else the generated one (Codex has none) |
| TOKENS | Input + output + cache read + cache write of the current turn while working, of the last turn while idle, main agent and sub-agents |
| ≈COST | At default list prices from a local copy of the dashboard's table (`+` = some model has no price, `n/a` = none has). Prices an operator edited are not visible locally |
| TOOLS, AGENTS, LAST TOOL | Tool calls, sub-agents launched in the turn, the tool called last (`-` when only a stored turn's tool list is known and it used several tools) |

On a narrow terminal the least important columns are dropped (LAST TOOL, then AGENTS, then TOOLS) so the title keeps room;
on a short one the sessions that do not fit are left out and counted in the footer (`N more not shown`). Control
characters in names and titles are shown as spaces.
**Order:** working (longest running first), then idle (most recent first). Stale rows are hidden and counted in the
footer. **Status rules** match the dashboard's: working until an end-of-turn record follows the last activity (a user
interrupt, an interrupted tool result or an API error also ends it); a working turn is stale after 2 h, an idle session
after 30 minutes without a signal. **How it reads:** new sessions are found every 5 s; known ones are read on every redraw
from an in-memory byte cursor (Claude Code starts at the state offset, the start of the first unfinished turn; Codex
replays the rollout into a copy of the state with the adapter's own reducer, rebuilt whenever the hook writes newer
state, which also carries the sub-agents' usage; scan-only transcripts are read from the
last 8 MB). It never writes, and never touches the hook state files or their offsets.

## Environment

| Variable | Effect |
|---|---|
| `AI_OBS_HOME` | Collector home (default `~/.ai-obs`). It is passed on to the worker |
| `AI_OBS_ENDPOINT` | Default `--server` for `login` and `init --token` only. Each token keeps its own server, so it has no effect at runtime |
| `AI_OBS_SUMMARIZING` | Set by the collector on its own summarizer process. When it is set, every `ai-obs` invocation exits 0 immediately |
| `AI_OBS_CODEX_SUMMARY_MODEL` | Model for Codex turn summaries. By default it is the smallest listed model in `$CODEX_HOME/models_cache.json` |
| `CODEX_HOME` | Codex home (default `~/.codex`). It is read from the hook environment |
| `CLAUDE_CONFIG_DIR` | Claude Code config dir (default `~/.claude`). It holds the user `settings.json` the hooks are written to, and the transcript location used when a hook payload has no `transcript_path` |

## Privacy guarantees

- **Never sent:** prompts, responses, code, diffs or file paths (ADR-0008). The only conversation-derived text
  that leaves the machine is the ≤ 140-char turn summary and the ≤ 140-char session title (Claude Code's `/rename` or
  generated title, ADR-0026). Before either is sent, it is whitespace-collapsed and any path in it is reduced to its
  last segment.
- **Project identity:** the normalized git remote, with credentials, `user@` and port stripped. The queue keeps the plain key and plain skill / MCP names (local files, mode 0600); they are hashed or named **at send time** with the receiving deployment's salt and naming mode, so each server sees only its own form. A plain path key never leaves the machine. The dot-file team slug is sent with `session_start`; the server decides whether to use it.
  - **`hashed` mode:** `sha256:` + a hash of that remote, with no name. When collector-config sends a
    per-deployment `project_salt` (this server does, since migration 0004), the hash is HMAC-SHA256 keyed by it (the same on every machine, so
    keys still agree). Without one (an older server) it is plain sha256, which anyone with the key (the server, DB
    access) can reverse with a dictionary of org/repo names, so treat `hashed` as protection against
    casual reading, not against the operator. A salt the server stores is still known to the server;
    it stops cross-deployment and precomputed dictionaries, not a determined operator.
  - **No remote (both modes):** `sha256:` + HMAC-SHA256 of the absolute path keyed by the local
    `~/.ai-obs/project-secret`, never the path itself. The server cannot reverse it to a
    home-directory path (or the OS user name in it). The key is per machine; if the secret cannot be
    created, the collector falls back to plain sha256 of the path. Keys made before this change
    (plain sha256) differ, so such a project shows up once more as a new project.
  - A token whose collector-config was never fetched sends nothing (its events wait), so no unsalted hash of a project is created.
- **Skill and MCP names** (ADR-0016) follow the same mode: plain skill, MCP server and tool names in `plain`, `sha256:` +
  HMAC-SHA256 under the deployment salt (plain sha256 without one) of `skill:<name>`, `mcp:<server>`, `mcp:<server>/<tool>` in
  `hashed`, applied by the sender when it sends the batch. Skill arguments and MCP inputs / outputs are never read.
  MCP reliability (`mcp_stats`: errors, refused calls, latency histogram) comes from pairing each call with its result;
  error texts are only matched locally (to tell a refusal from an error) and never sent.
- **Hook job files** keep only harness-related env vars (`CLAUDE_*`, `CODEX_*`, `AI_OBS_*`) and drop
  any whose name suggests a secret. Job files are deleted after processing.
- **`ai-obs live`** reads local state files and transcripts only: it sends nothing and writes nothing, and works without a login.
- **Local only:** prompt digests for summaries (including the staged files), edit fingerprints for revert detection (hashes only)
  and next-prompt correction checks.
- No git e-mail is sent: the token identifies the user (the batch `identity` is empty).
- The SessionStart text carries only hosts, server URLs, team slugs and the sanitized directory, never a token or an e-mail.
- Tokens live only in `~/.ai-obs/config.json` (0600; after an upgrade from 0.4 also in its copy `config.json.v2`, 0600), never in a repository: the dot file holds a server URL and a team slug, and a token is only ever sent to the server it was issued for.

## Development

```sh
pnpm --filter ai-obs-cli typecheck
pnpm --filter ai-obs-cli test     # = vitest run --project collector (no network: local http servers, temp homes)
pnpm --filter ai-obs-cli build    # dist/; the real-process hook tests (test/hook-process.test.ts) run only when dist exists
```

Test helpers (`test/helpers.ts`): `writeTestConfig` / `writeTestServers` (registered servers with their caches), `writeDotFile`, `ccValue` (a collector-config body), `tokenResponder` (per-token fake server), `okResponder`, `gitRepo`, and `queueStore` / `enqueueFor` (`test/queue-helpers.ts`). The definition-of-done test is `test/servers.integration.test.ts`: local servers with device login, the real CLI (`login`, `link`), hook and worker; `test/login.test.ts` drives the device flow against a `node:http` server.

The Claude Code fixture turn ids are prefixed `cc-fixture-`, so demos that send them do not collide with
`packages/protocol/fixtures/valid-batch.json` (`turn-1`, …); a test guards this.

`src/protocol-types.ts` is a dependency-free copy of the `@ai-obs/protocol` types.
`test/protocol-conformance.test.ts` type-checks it against the package and validates the builders'
output with `validateBatch()`.

## Releasing

`ai-obs-cli` is published to npm by the GitHub Actions workflow
[`.github/workflows/publish-collector.yml`](../../.github/workflows/publish-collector.yml) (ADR-0032). It type-checks,
builds and tests the collector, then runs `npm publish` with npm trusted publishing: no npm token lives in the
repository, and npm attaches provenance to the release.

1. Bump `version` in `packages/collector/package.json`, update "Upgrading" above when the release needs it, and commit
   to `main`.
2. Tag that commit `collector-v<version>` and push the tag, for example `git tag collector-v0.5.1 && git push origin
   collector-v0.5.1`. The workflow refuses a tag whose version differs from `package.json`. A prerelease version
   (`0.6.0-rc.1`) is published under the `next` dist-tag, anything else under `latest`.
3. "Run workflow" on the Actions tab publishes the version in `package.json` without a tag, with the same checks.

One-time setup on npmjs.com (owner). Trusted publishing cannot create a package, so the first version of a new name is
published by hand (`pnpm build && npm publish` in `packages/collector`, with the browser 2FA prompt). Then, on the
package's Settings page, add a trusted publisher: GitHub Actions, organization or user `soukupl`, repository
`ai-observability`, workflow filename `publish-collector.yml`, no environment, and allow `npm publish` (by default a
trusted publisher may only `npm stage publish`, which parks the version until a maintainer approves it with 2FA). Set
publishing access to "Require two-factor authentication and disallow tokens"; trusted publishing is not affected. A
new trusted-publisher record expires unless it publishes something within two days.
