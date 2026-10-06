# ai-obs — collector

Zero-dependency Node CLI that records how AI coding agents are used: tokens, models, effort levels,
phases, sub-agent runs, outcomes and one-line summaries. It reads exact numbers from harness hooks and
local transcripts and sends batched, idempotent events to an ai-obs server.
Design: [BRIEF §5](../../BRIEF.md), ADR-0001, ADR-0004, ADR-0005, ADR-0008, ADR-0011.

- Node ≥ 20, **no runtime dependencies** (only `node:` built-ins).
- Harnesses: Claude Code and Codex. Each one is an adapter in `src/adapters/<name>/`.

## Install

```sh
npx ai-obs init --token aiobs_u_… --endpoint https://obs.example.com            # user-level hooks
npx ai-obs init --token aiobs_u_… --endpoint https://obs.example.com --project  # hooks in this repo only
```

`init` does the following:

1. Checks the endpoint and token. A rejected token aborts with no changes. An unreachable server
   only gives a warning, and events queue locally until it can be reached.
2. Writes `~/.ai-obs/config.json` (mode 0600). A re-run keeps the existing `machine_id`.
3. Copies the collector (`bin/`, `dist/`, `package.json`) to `~/.ai-obs/app`, so hooks keep working
   after the npx cache is cleared.
4. Installs hooks in every detected harness. Each hook runs
   `<node> ~/.ai-obs/app/bin/ai-obs.js hook <harness> <hook>`. With `--project`, the hooks go into the
   repo's harness config, but the token is never written into the repo.
5. Fetches `GET /api/v1/collector-config` to learn the company's project-naming mode (and its `project_salt`, if the server sends one).
6. Prints the next steps only you can do. For Codex: **open Codex once and run `/hooks` to trust the
   new hooks**. Codex does not run untrusted hooks, so nothing is recorded until you do.

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
| `--harness claude-code,codex` | Limit setup to these harnesses |
| `--project-dir <dir>` | Repo root for `--project`. Default: the git top level of the current directory |
| `--git-email <email>` | Override the detected `git config user.email`. It is sent only to match team tokens to users |
| `--home <dir>` | Collector home. Works with every command |

## Commands

| Command | Does |
|---|---|
| `init --token <t> --endpoint <url> [--project]` | Configure, as described above |
| `doctor` | Checks the config, the endpoint, the token, the server's minimum version, each harness (installed, version supported, hooks installed), the hook runtime, the queue and the last send. Also checks that the node binary and script baked into the installed hook commands still exist (✗ with "run `ai-obs init` again" when they do not), and for Codex whether the hooks are still waiting to be trusted via `/hooks` (`!`). Prints ✓, ! or ✗ per check and exits 1 if any check shows ✗ |
| `status` | Shows local state without using the network: endpoint, masked token, queue size and age, pending hook jobs, summaries waiting for retry, last send and last error |
| `flush [--wait <s>]` | First runs every adapter's idle-session sweep (Codex ends sessions idle for 1 h, Claude Code ones silent for 24 h) and retries pending summaries, then sends the queue now and ignores the retry backoff. Data therefore does not wait for the next hook |
| `uninstall [--purge] [--project-dir <dir>]` | Removes our hooks from user scope and from the current repo. `--purge` also deletes `~/.ai-obs`, including any unsent events |
| `hook <harness> <hook>` | Internal. Harness hooks call it. It always exits 0 |

## Files (`~/.ai-obs`, or `$AI_OBS_HOME`)

| Path | Content |
|---|---|
| `config.json` | `{endpoint, token, machine_id, created_at, git_email?}`, mode 0600 |
| `project-secret` | Random 32-byte hex secret (mode 0600, created on first use, never sent) that keys the hash of a repo with no remote |
| `queue/*.ndjson` | Event queue. Segments are named by ULID. The cap is ~50 MB / 30 days, and the oldest segments are dropped first (logged) |
| `queue/dead/` | Batches the server refused as a whole (HTTP 400), kept for inspection (max 5 MB) |
| `jobs/*.json` | Hook invocations waiting for the worker. They hold the raw hook payload and stay on this machine |
| `state/<harness>/<session>.json` | Per-session adapter state, such as transcript cursors and provisional outcomes |
| `state/summaries/<harness>.json` | Turn digests whose summary failed. They are retried for up to 5 attempts or 7 days and stay on this machine |
| `state/collector-config.json` | Cached collector-config. TTL 6 h; after a failed fetch, the next try waits 10 min |
| `state/delivery.json` | Last attempt, last success, last error and backoff |
| `log/collector.log` | Errors and warnings from hooks and the worker. Rotated at 1 MB. Prompts and paths are never logged |
| `app/` | The collector copy that hooks run |
| `worker.lock` | Held by the single worker or a `flush` |

## How hooks work

```
harness hook ─▶ ai-obs hook <harness> <hook>      (< 100 ms, always exit 0)
                 ├─ read stdin JSON (50 ms idle timeout)
                 ├─ write jobs/<ulid>.json  (payload, cwd, harness env vars minus secrets)
                 └─ spawn detached worker ─▶ dist/worker-main.js
                                               ├─ take worker.lock (or exit: the holder picks the job up)
                                               ├─ for each job, oldest first: adapter.handleHook(job, ctx)
                                               │     (+ adapter.sweepCrashedSessions after session-start hooks)
                                               ├─ flush queue (≤ 500 events / 1 MB, gzip, Bearer token)
                                               └─ release lock, re-scan jobs/
```

- **Recursion guard.** `bin/ai-obs.js` exits immediately when `AI_OBS_SUMMARIZING` is set. The
  summarizer sets that variable on the headless model call it starts.
- **Delivery.** A batch is acked (removed from the queue) only after a 2xx response. Server
  duplicates and per-event rejections count as delivered. On network errors, 5xx, 429 (which honours
  `Retry-After`) or 401/403, events stay queued with exponential backoff (30 s up to 1 h). Hook-triggered
  flushes respect the backoff; `ai-obs flush` ignores it. On 413 the batch size is halved; on 400 the
  batch goes to `queue/dead/`.
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
| `handleHook(invocation, ctx)` | Runs in the worker. Reads the transcript from the cursor in `ctx.state`, builds events with `src/events.ts` and calls `ctx.queue.enqueue(events)` |
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
| `src/analysis/summaries.ts` | `summarizeWithCommand`, `runSummaryCommand` (sets `AI_OBS_SUMMARIZING=1`, 120 s timeout), `buildSummaryPrompt`, `parseSummaryResponse` |
| `src/project-key.ts` / `ctx.projectKey(cwd)` | Normalized git remote, or `sha256:`, following the company's naming mode |
| `src/analysis/usage.ts` | Skill / MCP usage (ADR-0016): `parseMcpTool`, `addSkill`, `addMcp`, `mcpFromTools`, `mergeSkills` / `mergeMcp`, wire normalisation, `skillReadBy` (Codex SKILL.md reads) and `applyUsageNaming` / `hashUsageName`. Adapters pass **plain** names to `turnEvent` / `runEvent` (`skills`, `mcp`); `ctx.queue` hashes them in `hashed` mode before anything is queued |

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

**Hooks.** The adapter writes `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`,
`SubagentStop` and `SessionEnd` to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`), or to
`<repo>/.claude/settings.json` with `--project`.

- It adds one group per event, `{hooks:[{type:"command", command:"<node> <bin> hook claude-code <Event>"}]}`.
- Re-running `init` replaces our entry, and `uninstall` removes only ours.
- Before each change, the previous file is copied to `settings.json.ai-obs.bak`.
- A file that is not valid JSON is never overwritten.

| Module | Role |
|---|---|
| `index.ts` | The adapter (`createClaudeCodeAdapter()` for tests) and the summary command |
| `handlers.ts` | Hook dispatch, `session_start` / `session_end`, crash sweep, summaries at session end |
| `session.ts` | Turn segmentation from the cursor, continuations, outcome patches, sub-agent runs |
| `analyze.ts` | One stretch of activity: tokens, phases, tools, edits, checks, interrupts |
| `transcript.ts` | Byte-cursor JSONL reader; slims each line to ids, numbers and phase decisions |
| `subagents.ts` | `subagents/agent-<id>.jsonl` + `.meta.json`, and `subagents/workflows/<wf_id>/agent-*.jsonl` + `journal.jsonl` → `run` events |
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
    the tool's `subagent_type`).
  - **No `main` run:** the main agent is not sent as a run, because the protocol defines
    `parent_run_id: null` / `depth: 1` as "spawned by the main agent".
  - **Delegating time:** the parent's time waiting for a sub-agent is `delegating`, which is not
    reported for the parent.
  - **Background sub-agents** that finish after `Stop` are sent at their `SubagentStop`, together
    with a re-sent turn.
- **Workflow sub-agents.** The Workflow tool runs its agents in the background, under
  `<session>/subagents/workflows/<wf_id>/agent-*.jsonl`. Without these, their tokens would be missing.
  - **Linking:** the Workflow tool result (`taskType: local_workflow`, `runId: wf_…`) ties the run to
    the turn that launched it. Each agent becomes a `run` with `parent_run_id: null` and `depth: 1`
    (spawned by the main agent), and its usage is added to that turn, which is re-sent.
  - **Fields:** `agent_type` is `workflow:<label>` (a slug of the meta `description`, ≤ 48 chars;
    `workflow-subagent` when there is no label). `ext` has `workflow_id`, `workflow_phase` and
    `workflow_label`. The script, the journal's results and the workflow `.json` are never read
    beyond the agent ids and the final `status`.
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
- **Summaries** run at `SessionEnd`: `claude -p --model haiku --output-format json
  --no-session-persistence --tools ""`, with the batched prompt on stdin and `AI_OBS_SUMMARIZING=1`.
  The command runs in the OS temp dir, and the reply's `result` field is parsed.

### Codex adapter (`src/adapters/codex/`)

The real hook and rollout format is documented in
[`src/adapters/codex/FORMAT.md`](src/adapters/codex/FORMAT.md): the fields, the versions seen, and how
sub-agents and session end show up.

**Hooks.** The adapter writes `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop` and `SessionEnd`
to `~/.codex/hooks.json`, or to `<repo>/.codex/hooks.json` with `--project`. It appends its own
matcher groups and leaves other hooks alone.

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
  the previous turn's outcome and the pending digests.
- **Idle sessions:** a session whose rollout has been idle for more than 1 h without a `SessionEnd`
  (crash or kill) is ended by the sweep with reason `crashed`.
- **Resumed sessions:** a session that started before `init` and is resumed afterwards is back-filled
  from the start of its rollout.

## Environment

| Variable | Effect |
|---|---|
| `AI_OBS_HOME` | Collector home (default `~/.ai-obs`). It is passed on to the worker |
| `AI_OBS_ENDPOINT` | Overrides the configured endpoint at runtime (not persisted). `init` also uses it as the default `--endpoint` |
| `AI_OBS_SUMMARIZING` | Set by the collector on its own summarizer process. When it is set, every `ai-obs` invocation exits 0 immediately |
| `AI_OBS_CODEX_SUMMARY_MODEL` | Model for Codex turn summaries. By default it is the smallest listed model in `$CODEX_HOME/models_cache.json` |
| `CODEX_HOME` | Codex home (default `~/.codex`). It is read from the hook environment |
| `CLAUDE_CONFIG_DIR` | Claude Code config dir (default `~/.claude`). It holds the user `settings.json` the hooks are written to, and the transcript location used when a hook payload has no `transcript_path` |

## Privacy guarantees

- **Never sent:** prompts, responses, code, diffs or file paths (ADR-0008). The only model-written text
  that leaves the machine is the ≤ 140-char turn summary. Before it is sent, it is whitespace-collapsed
  and any path in it is reduced to its last segment.
- **Project identity:** the normalized git remote, with credentials, `user@` and port stripped.
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
  - Until the server has been reached once, the collector assumes `hashed` without a salt.
- **Skill and MCP names** (ADR-0016) follow the same mode: plain skill, MCP server and tool names in `plain`, `sha256:` +
  HMAC-SHA256 under the company salt (plain sha256 without one) of `skill:<name>`, `mcp:<server>`, `mcp:<server>/<tool>` in
  `hashed`, applied in `ctx.queue` before an event reaches the queue. Skill arguments and MCP inputs / outputs are never read.
- **Hook job files** keep only harness-related env vars (`CLAUDE_*`, `CODEX_*`, `AI_OBS_*`) and drop
  any whose name suggests a secret. Job files are deleted after processing.
- **Local only:** prompt digests for summaries, edit fingerprints for revert detection (hashes only)
  and next-prompt correction checks.
- The git e-mail is sent only in the batch `identity`, to match team tokens to users.
- The token lives only in `~/.ai-obs/config.json` (0600), never in a repo.

## Development

```sh
pnpm --filter ai-obs typecheck
pnpm --filter ai-obs test     # = vitest run --project collector (no network: local http servers, temp homes)
pnpm --filter ai-obs build    # dist/; the real-process hook timing test (< 100 ms) runs only when dist exists
```

The Claude Code fixture turn ids are prefixed `cc-fixture-`, so demos that send them do not collide with
`packages/protocol/fixtures/valid-batch.json` (`turn-1`, …); a test guards this.

`src/protocol-types.ts` is a dependency-free copy of the `@ai-obs/protocol` types.
`test/protocol-conformance.test.ts` type-checks it against the package and validates the builders'
output with `validateBatch()`.
