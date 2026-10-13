# ai-obs — collector

Zero-dependency Node CLI that records how AI coding agents are used: tokens, models, effort levels,
phases, sub-agent runs, outcomes and one-line summaries. It reads exact numbers from harness hooks and
local transcripts and sends batched, idempotent events to an ai-obs server.
Design: [BRIEF §5](../../BRIEF.md), ADR-0001, ADR-0004, ADR-0005, ADR-0008, ADR-0011, ADR-0022 (several tokens, per-repository choice).

- Node ≥ 20, **no runtime dependencies** (only `node:` built-ins).
- Harnesses: Claude Code and Codex. Each one is an adapter in `src/adapters/<name>/`.

## Install

```sh
npx @soukupl/ai-obs init --token aiobs_u_… --endpoint https://obs.example.com            # user-level hooks
npx @soukupl/ai-obs init --token aiobs_u_… --endpoint https://obs.example.com --project  # hooks in this repo only
```

A user token (`aiobs_u_`) identifies you in one company. A company token (`aiobs_c_`, made by an admin or lead) writes
into a company and matches you by git e-mail. A machine can hold several tokens (see "Several companies").

`init` does the following:

1. Checks the endpoint and token with `GET /api/v1/collector-config`, which also returns the company (name and slug)
   and, for a user token, your e-mail. A 429 is retried after `Retry-After` (at most 3 tries and 60 s in total, never
   waiting past that budget). A rejected token (401, 403, or a 429 that does not clear) aborts with no changes. An
   unreachable or old server (no company in the reply) only gives a warning, and events queue locally until it can be
   reached.
2. Stores the token in `~/.ai-obs/config.json` (mode 0600) under the company slug (`--name` overrides) and caches its
   collector-config per token. A re-run keeps the existing `machine_id`. The write runs under the worker lock.
3. Moves the batches the 0.1.x collector left in `queue/*.ndjson` to `queue/dead/pre-upgrade/` (see "Upgrading from 0.1").
4. Copies the collector (`bin/`, `dist/`, `package.json`) to `~/.ai-obs/app`, so hooks keep working
   after the npx cache is cleared.
5. Installs hooks in every detected harness. Each hook runs
   `<node> ~/.ai-obs/app/bin/ai-obs.js hook <harness> <hook>`. With `--project`, the hooks go into the
   repo's harness config, but the token is never written into the repo.
6. Prints the next steps only you can do. For Codex: **open Codex once and run `/hooks` to trust the
   new hooks**. Codex does not run untrusted hooks, so nothing is recorded until you do.

### Several companies

```sh
npx @soukupl/ai-obs init --token aiobs_u_<acme> --endpoint https://obs.example.com          # registered as "acme"
npx @soukupl/ai-obs token add --token aiobs_c_<globex> --endpoint https://obs.example.com   # registered as "globex"
cd ~/work/billing && ai-obs use acme                                               # this repository reports to acme
```

- **With one token nothing changes:** every repository reports to it and no question is asked.
- **With two or more tokens a repository must be assigned.** The key is the normalized git remote, else the
  repository top-level path (the main checkout's, so every `git worktree` of a repository shares it), else the directory
  (`ai-obs use` prints it). Until then its events stay in the local queue and
  nothing is sent. The choice lives in `~/.ai-obs/projects.json`, never leaves the machine and is written only by `use`.
- **The SessionStart question.** When a repository has no usable choice, the SessionStart hook puts a short text into the
  agent's context: the project key, the registered token names and the command `ai-obs use <name> --project-dir <dir>`. The
  agent asks you and runs it. It appears at most once per session (a changed situation is shown once more), also when the
  repository's token is rejected, suspended or unconfirmed, and once after kept events were dropped. It needs no network
  and carries only token names, company slugs, hosts, the sanitized project key and directory. The text is at most 1000
  characters: when it is longer, it drops the token details first, then writes the collector's command once (then not at
  all), then drops `--project-dir`, and only then lists fewer tokens (`… and N more`). `status` and `doctor` show the
  same facts.
- **Queued data stays with the company it was recorded for.** `use <name>` sends the data that waited because the
  repository had no choice, and binds new sessions. Data recorded while the repository was assigned to another token
  stays with that token. `ai-obs use <name> --move-queued` moves it (and prints how many events). A running session keeps
  its token until it ends. A session that started while the repository had no choice sends what it records after
  `use <name>` to `<name>`; what it recorded before is open data and goes wherever the repository's choice points when it
  is sent (so if you change the choice again before it was sent, that part follows the new choice).
- `ai-obs use <name> --all-held` assigns every repository whose data is waiting. When `init` / `token add` take you from
  one token to two, they list the recently seen repositories that will now ask.
- `ai-obs use --none` marks a repository as belonging to no company: new events are not recorded and the question stops.
  Queued data is kept (shown as `opted-out`), and `--discard-queued` deletes it. `use --clear` removes any choice.
- A damaged `projects.json` is never overwritten: `use` refuses, and `use --reset-projects` sets it aside as
  `projects.json.broken-<id>` and starts an empty one.
- `token remove <name>` forgets a token. Events queued for it stay on the machine.
- Registering the same token at another endpoint (a corrected URL, `http` → `https`, a server that moved) makes it a new
  identity: events queued for the old endpoint stay on the machine and repositories assigned to it ask again. The command
  says how many; `ai-obs use <name> --move-queued` in each repository sends them to the new endpoint.

### Replace, rotate, confirm

- Same endpoint and same company slug as a registered token: the new token **replaces** it (rotation; data queued for the
  old one is sent with the new one). The output says so, and says when the kind changed (user to company).
- Same slug on another endpoint, or a name already in use: refused until you pass `--name <other>`.
- Offline, or against an old server, the company is unknown. With a single token the entry is named `default` (or your
  `--name`) and is confirmed by the first successful collector-config fetch, which renames `default` to the company slug.
  With another token already registered, `--name` is required and the token sends nothing until
  `ai-obs token confirm <name>` (or a later fetch) proves its company.

### Upgrading to 0.3

Version 0.3 adds session titles (ADR-0026): the Claude Code adapter sends the session's `/rename` title (or Claude Code's
generated one) as a `session_title` event, so the dashboard's Sessions view shows the names of the `/resume` picker.
It is the first release on npm, as `@soukupl/ai-obs` (npm refused the name `ai-obs`; the command is still `ai-obs`).
Run `npx @soukupl/ai-obs@latest init` (no `--token`: it keeps the registered tokens and only refreshes the hook runtime
and the hooks). The server must have migration 0016; `MIN_COLLECTOR_VERSION` can stay at 0.2.0, since 0.2 still
works without titles.

### Upgrading from 0.1

Version 0.2 reads a 0.1.x `config.json` but keeps no token from it: the server revoked every old token (ADR-0022), so
run `ai-obs init --token <new token>` with a user token from the dashboard or a company token from your admin.

- Any CLI command prints an upgrade banner while no valid token is registered. The 0.1.x hook runtime in `~/.ai-obs/app`
  shows nothing until `init` copies the new one (`status` / `doctor` say when the runtime is outdated). With no token,
  nothing is recorded.
- **Pre-upgrade data is never sent.** Batches written by 0.1.x (`queue/*.ndjson`) cannot be tied to any token, so the first
  successful `init` / `token add` moves them to `queue/dead/pre-upgrade/`, and `status` / `doctor` report once "N pre-upgrade
  batches kept in queue/dead/pre-upgrade, not sent: tokens were reset". Delete the directory when you no longer need them.
- Old `jobs/<id>.json` hook jobs and 0.1.x session state are still processed. A session state without a working directory
  has its events dropped (logged).
- `init` and `token add` refresh the hook runtime. `init` also reinstalls the hooks (the Claude Code SessionStart entry
  gets a 5 s timeout).
- Operators: see the rollout note in the root README about the per-IP failed-auth budget, and raise
  `MIN_COLLECTOR_VERSION` to 0.2.0.

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
| `--name <name>` | Token name (`init`, `token add`): 1–63 of `a-z`, `0-9`, `-`. Default: the company slug the server reports |
| `--endpoint <url>` | Server of this token. Default for `init` / `token add`: `AI_OBS_ENDPOINT`, else the endpoint in `config.json`. When that default was used and the server answers 401 / 403, the message suggests `--endpoint` |
| `--harness claude-code,codex` | Limit setup to these harnesses |
| `--project-dir <dir>` | Repo root for `--project`. Default: the git top level of the current directory |
| `--git-email <email>` | Override the detected `git config user.email`. It is sent only so a company token (`aiobs_c_`) can match you to a member of the company (company-token matching) |
| `--home <dir>` | Collector home. Works with every command |
| `--yes` | With `uninstall --purge`: skip the confirmation |

## Commands

| Command | Does |
|---|---|
| `init [--token <t>] [--endpoint <url>] [--name <n>] [--project]` | Register the token and configure the harnesses, as described above. Without `--token` it keeps the registered tokens and only refreshes the runtime and hooks |
| `token add --token <t> [--endpoint <url>] [--name <n>]` | Register another company's token. Changes no hooks |
| `token list` | Registered tokens: name, kind, company, endpoint, state, and the repositories using each |
| `token confirm <name>` | Fetch the company of an unconfirmed token and start sending with it |
| `token remove <name>` / `token remove --invalid` | Forget a token. `--invalid` deletes malformed entries from `config.json` (nothing else deletes them) |
| `use <name> [--project-dir <dir>]` | Assign this repository (key: remote, else top level, else path) to a token. Flags: `--move-queued` (also move data recorded under its previous token), `--all-held` (every repository whose data is waiting) |
| `use --none [--discard-queued]` / `use --clear` / `use --reset-projects` | Stop recording this repository (keep or delete its queue) / remove its choice / set a damaged `projects.json` aside |
| `doctor` | Checks the config, each token (endpoint, collector-config, rejection, company), the server's minimum version, this project's token, each harness (installed, version supported, hooks installed), the hook runtime, the queue and the last send. Also checks that the node binary and script baked into the installed hook commands still exist (✗ with "run `ai-obs init` again" when they do not), and for Codex whether the hooks are still waiting to be trusted via `/hooks` (`!`). Prints ✓, ! or ✗ per check and exits 1 if any check shows ✗ |
| `status` | Shows local state without using the network: tokens and their state (a rejected or suspended token is marked), this project's token, queue size per token and what is waiting or kept (unassigned, opted out, unconfirmed, pre-upgrade), dropped events, pending hook jobs, summaries waiting for retry, last send and last error |
| `flush [--wait <s>]` | First runs every adapter's idle-session sweep (Codex ends sessions idle for 1 h, Claude Code ones silent for 24 h) and retries pending summaries, then sends the queue now, ignores the retry backoff and retries a rejected token once. Held data stays held (exit 0) |
| `uninstall [--purge [--yes]] [--project-dir <dir>]` | Removes our hooks from user scope and from the current repo. `--purge` also deletes `~/.ai-obs`, including tokens, assignments and any unsent events |
| `hook <harness> <hook>` | Internal. Harness hooks call it. It always exits 0 |

## Files (`~/.ai-obs`, or `$AI_OBS_HOME`)

| Path | Content |
|---|---|
| `config.json` | Version 2, mode 0600: `{endpoint?, machine_id, created_at, git_email?, tokens[], invalid_tokens?, routing_epochs, legacy?}`. A token entry has `name`, `company {name, slug}`, `email?`, `git_email?` (the git e-mail of the directory it was registered in; sent with that token only, else the top-level `git_email`), `endpoint`, `token`, `added_at`, `prior_fps?` (rotation) and `provisional_name?`. `routing_epochs` records when the single token changed, so a session is bound by what was in force when it started. `legacy` holds the masked 0.1.x token. Malformed entries are kept under `invalid_tokens` |
| `projects.json` | Mode 0600, written only by `ai-obs use`: project key → `{token, endpoint, company_slug?, token_fp, assigned_at}` or `{token: null, none: true}`. Never sent. Routing matches the token identity, not the name |
| `project-secret` | Random 32-byte hex secret (mode 0600, created on first use, never sent) that keys the hash of a repo with no remote |
| `queue/p/o-<id>/`, `queue/p/t-<id>/` | One stream per project and binding, each with `stream.json` (plain key, binding) and `*.ndjson` segments named by ULID. `o-` = recorded while the project had no usable choice (open); `t-` = bound to one token |
| `queue/u/…` | Streams whose project key could not be resolved when recorded (git timed out). A later flush adopts them into their project stream |
| `queue/*.ndjson` | The pre-upgrade stream written by 0.1.x: frozen, never sent, moved to `queue/dead/pre-upgrade/` by the first registration |
| `queue/dead/` | Batches the server refused as a whole (HTTP 400), kept for inspection (max 5 MB), and `pre-upgrade/` |
| | Queue caps: ~50 MB for the whole queue (oldest segment first) and 30 days for streams that can be sent now, counted from when the stream became sendable (`sendable_since` in its `stream.json`), so waiting data released by `use` or a confirmed / unblocked token gets its full 30 days. Waiting, rejected, unconfirmed and opted-out streams are exempt from the age cap. Every drop is counted in `state/dropped.json` and shown in `status`, `doctor` and `flush`, and once in the next SessionStart text (`state/dropped-shown.json`) |
| `jobs/*.v2.json` | Hook invocations waiting for the worker (0.1.x wrote `<id>.json`, still read). They hold the raw hook payload and stay on this machine |
| `state/<harness>/<session>.json` | Per-session adapter state, such as transcript cursors, provisional outcomes and the session's pinned stream |
| `state/summaries/<harness>.json` | Turn digests whose summary failed, with their stream key. They are retried for up to 5 attempts or 7 days and stay on this machine |
| `state/collector-config/<name>.json` | Cached collector-config per token. TTL 6 h; after a failed fetch, the next try waits 10 min |
| `state/delivery.json` | Per token: last attempt, last success, last error, backoff and a `blocked` flag (401 / 403) |
| `state/dropped.json` | Counters of events dropped by the size cap, split into waiting and sendable |
| `state/project-keys.json` | Working directory → project key cache (500 entries) that the hook reads without running git |
| `state/nudged/<session>` | Marker that the SessionStart text was shown in a session (deleted after 7 days) |
| `state/pre-upgrade.json` | Number of batches moved to `queue/dead/pre-upgrade/` and whether it was reported |
| `log/collector.log` | Errors and warnings from hooks and the worker. Rotated at 1 MB. Prompts and paths are never logged |
| `app/` | The collector copy that hooks run |
| `worker.lock` | Held by the single worker or a `flush` |

## How hooks work

```
harness hook ─▶ ai-obs hook <harness> <hook>      (always exit 0)
                 ├─ read stdin JSON (50 ms idle timeout)
                 ├─ write jobs/<ulid>.v2.json  (payload, cwd, harness env vars minus secrets)
                 ├─ spawn detached worker ─▶ dist/worker-main.js
                 └─ SessionStart only: print the token question when there is one (local files only)

worker:  take worker.lock (or exit: the holder picks the job up)
         ├─ for each job, oldest first: adapter.handleHook(job, ctx)
         │     binds each session once, at its first event: project key + the token in force
         │     (or "open" when there was no choice) → one queue stream per project and binding
         │     (+ adapter.sweepCrashedSessions after session-start hooks)
         ├─ flush: route every stream to its token (held streams are skipped); per token
         │     ≤ 500 events / 1 MB per batch, gzip, that token's Bearer token and naming
         └─ release lock, re-scan jobs/ (and run again when config.json or projects.json changed)
```

- **SessionStart question.** The time budget counts in-process from hook entry (Node start-up is not counted). The hook
  reads the project key from `state/project-keys.json`, and uses a cached key only while the directory's git config is
  unchanged (a re-clone, `git init` or `git remote set-url` makes it resolve again). On a cache miss it runs git for at
  most 40 ms, and only when less than 40 ms have passed, then kills it. When git is slower than that (often the first
  session in a freshly cloned repository), this session gets no question: its events are kept, the worker caches the
  key, and the next session asks. It does no network call and prints at most once per session and text. The Claude
  Code `SessionStart` entry has `timeout: 5`. Every other hook prints nothing.
- **Recursion guard.** `bin/ai-obs.js` exits immediately when `AI_OBS_SUMMARIZING` is set. The
  summarizer sets that variable on the headless model call it starts.
- **Delivery.** A batch is acked (removed from the queue) only after a 2xx response. Server
  duplicates and per-event rejections count as delivered. State is per token: on network errors, 5xx or 429
  (which honours `Retry-After`) that token's events stay queued with exponential backoff (30 s up to 1 h), and
  the other tokens keep sending. A 401 or 403 (rejected or suspended) keeps that token's batches, stops sending
  with it, and shows in `status`, `doctor` and the SessionStart text; automatic flushes skip it and `ai-obs flush`
  tries it once. `maxBatches` per flush counts per token. Hook-triggered flushes respect the backoff;
  `ai-obs flush` ignores it. On 413 the batch size is halved; on 400 the batch goes to `queue/dead/`.
  Nothing is sent with a token whose collector-config was never fetched. Project and skill / MCP names are
  rewritten at send time with the receiving company's naming mode and salt.
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
| `summarize(digests, ctx)` | One headless call to the cheapest model. Implement it with `summarizeWithCommand()`. Never call it directly; use `ctx.summarizeTurns(digests)` |

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

**SessionStart output.** The token question is printed as JSON, `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "…"}}`, one line.

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
| `handlers.ts` | Hook dispatch, `session_start` / `session_end`, crash sweep, summaries (at session end, every 10 turns, or after 10 minutes) |
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

- **Tokens** come from the differences between cumulative `total_token_usage` snapshots. Repeated
  snapshots are skipped, and cached input is subtracted from input.
- **Session state** is stored in `state/codex/<session>.json`. It holds the byte cursor, the open turn,
  the previous turn's outcome and the pending digests. Summaries run at `SessionEnd`, once 10 turns are
  waiting, or once the first waiting turn has waited 10 minutes (same `summariesDue` rule as Claude Code,
  ADR-0023).
- **Idle sessions:** a session whose rollout has been idle for more than 1 h without a `SessionEnd`
  (crash or kill) is ended by the sweep with reason `crashed`.
- **Resumed sessions:** a session that started before `init` and is resumed afterwards is back-filled
  from the start of its rollout.

## Environment

| Variable | Effect |
|---|---|
| `AI_OBS_HOME` | Collector home (default `~/.ai-obs`). It is passed on to the worker |
| `AI_OBS_ENDPOINT` | Default `--endpoint` for `init` / `token add` only. Each token keeps its own endpoint, so it has no effect at runtime |
| `AI_OBS_SUMMARIZING` | Set by the collector on its own summarizer process. When it is set, every `ai-obs` invocation exits 0 immediately |
| `AI_OBS_CODEX_SUMMARY_MODEL` | Model for Codex turn summaries. By default it is the smallest listed model in `$CODEX_HOME/models_cache.json` |
| `CODEX_HOME` | Codex home (default `~/.codex`). It is read from the hook environment |
| `CLAUDE_CONFIG_DIR` | Claude Code config dir (default `~/.claude`). It holds the user `settings.json` the hooks are written to, and the transcript location used when a hook payload has no `transcript_path` |

## Privacy guarantees

- **Never sent:** prompts, responses, code, diffs or file paths (ADR-0008). The only conversation-derived text
  that leaves the machine is the ≤ 140-char turn summary and the ≤ 140-char session title (Claude Code's `/rename` or
  generated title, ADR-0026). Before either is sent, it is whitespace-collapsed and any path in it is reduced to its
  last segment.
- **Project identity:** the normalized git remote, with credentials, `user@` and port stripped. The queue keeps the plain key and plain skill / MCP names (local files, mode 0600); they are hashed or named **at send time** with the receiving company's salt and naming mode, so each company sees only its own form. `projects.json` and the assignment key never leave the machine, and neither does a plain path key.
  - **`hashed` mode:** `sha256:` + a hash of that remote, with no name. When collector-config sends a
    per-company `project_salt` (this server does, since migration 0004), the hash is HMAC-SHA256 keyed by it (the same on every machine, so
    keys still agree). Without one (an older server) it is plain sha256, which anyone with the key (the server, DB
    access) can reverse with a dictionary of org/repo names, so treat `hashed` as protection against
    casual reading, not against the operator. A salt the server stores is still known to the server;
    it stops cross-company and precomputed dictionaries, not a determined operator.
  - **No remote (both modes):** `sha256:` + HMAC-SHA256 of the absolute path keyed by the local
    `~/.ai-obs/project-secret`, never the path itself. The server cannot reverse it to a
    home-directory path (or the OS user name in it). The key is per machine; if the secret cannot be
    created, the collector falls back to plain sha256 of the path. Keys made before this change
    (plain sha256) differ, so such a project shows up once more as a new project.
  - A token whose collector-config was never fetched sends nothing (its events wait), so no unsalted hash of a project is created.
- **Skill and MCP names** (ADR-0016) follow the same mode: plain skill, MCP server and tool names in `plain`, `sha256:` +
  HMAC-SHA256 under the company salt (plain sha256 without one) of `skill:<name>`, `mcp:<server>`, `mcp:<server>/<tool>` in
  `hashed`, applied by the sender when it sends the batch. Skill arguments and MCP inputs / outputs are never read.
  MCP reliability (`mcp_stats`: errors, refused calls, latency histogram) comes from pairing each call with its result;
  error texts are only matched locally (to tell a refusal from an error) and never sent.
- **Hook job files** keep only harness-related env vars (`CLAUDE_*`, `CODEX_*`, `AI_OBS_*`) and drop
  any whose name suggests a secret. Job files are deleted after processing.
- **Local only:** prompt digests for summaries, edit fingerprints for revert detection (hashes only)
  and next-prompt correction checks.
- The git e-mail is sent only in the batch `identity`, so a company token (`aiobs_c_`) can match you to a member of the company (user tokens `aiobs_u_` already identify you).
- The SessionStart question carries only token names, company slugs, hosts, the sanitized project key and directory, never a token.
- Tokens live only in `~/.ai-obs/config.json` (0600), never in a repo.

## Development

```sh
pnpm --filter @soukupl/ai-obs typecheck
pnpm --filter @soukupl/ai-obs test     # = vitest run --project collector (no network: local http servers, temp homes)
pnpm --filter @soukupl/ai-obs build    # dist/; the real-process hook tests (test/hook-process.test.ts) run only when dist exists
```

Test helpers (`test/helpers.ts`): `writeTestConfig` / `writeTestTokens` (registered tokens with their caches), `writeProjects`, `tokenResponder` (per-token fake server), `okResponder`, `gitRepo`, and `queueStore` (`test/queue-helpers.ts`). The multi-company definition-of-done test is `test/multi-token.integration.test.ts`: two local servers, the real CLI, hook and worker.

The Claude Code fixture turn ids are prefixed `cc-fixture-`, so demos that send them do not collide with
`packages/protocol/fixtures/valid-batch.json` (`turn-1`, …); a test guards this.

`src/protocol-types.ts` is a dependency-free copy of the `@ai-obs/protocol` types.
`test/protocol-conformance.test.ts` type-checks it against the package and validates the builders'
output with `validateBatch()`.
