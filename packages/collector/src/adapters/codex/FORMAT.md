# Codex: hooks and rollout format, as ai-obs reads them

Verified on 2026-10-06 against Codex CLI **0.154.0** (Homebrew cask), the strings of its binary (the
hook input JSON schemas are embedded in it), the hooks docs (developers.openai.com/codex/hooks, which
now redirects to learn.chatgpt.com/docs/hooks) and 13 local rollouts. The rollouts were written by
`cli_version` 0.94.0-alpha, 0.108.0-alpha, 0.147.0-alpha (Codex Desktop) and 0.154.0 (`codex exec`), and one
pre-2025-10 legacy file. No real content was copied: the test fixtures in `test/codex/fixtures/`
are synthetic and only have the same shape.

## Hooks

**Where they live:** `~/.codex/hooks.json` (user) and `<repo>/.codex/hooks.json` (project). Hooks can
also be set inline in `[hooks]` tables of `config.toml` and in plugins; ai-obs writes only the
`hooks.json` files.

```json
{ "hooks": { "Stop": [ { "matcher": "optional regex", "hooks": [ { "type": "command", "command": "<shell string>", "timeout": 600 } ] } ] } }
```

- `command` is **one shell string**, run with the session cwd. ai-obs writes `HookCommand.shell`.
- Event names in `hooks.json` are PascalCase. The full set: `SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`,
  `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.
- **Timeouts:** the default is 600 s. `SessionEnd` and `Interrupt` default to 1 s and allow at most 3 s, so
  ai-obs sets `timeout: 3` on its `SessionEnd` hook.
- **Trust:** Codex runs a hook only after the user has trusted it with `/hooks` inside Codex. Trust is
  stored in `config.toml` as `[hooks.state."<hooks.json path>:<snake_event>:<group idx>:<handler
  idx>"]` with `enabled` and `trusted_hash = "sha256:…"`. When the command changes, the hash changes and
  the hook needs trust again. For that reason ai-obs **appends** its matcher group, so other tools'
  indices stay valid, and updates its own entry **in place**. `detect()` lists ai-obs hooks that have no
  trust entry, and `ai-obs doctor` shows them. `codex exec --dangerously-bypass-hook-trust` skips the
  check for a single run.
- **Feature flag:** `[features] hooks` is `stable`, on by default. `-c features.hooks=false` turns it off.

**What ai-obs installs:** `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStop` and
`SessionEnd`. It does not install tool hooks, because the rollout already has every tool call and a
worker spawn per call would be wasted.

### stdin payload fields

These come from the input schemas embedded in the 0.154.0 binary.

| Event | Fields |
|---|---|
| all | `session_id`, `transcript_path` (string or null; the rollout path), `cwd`, `hook_event_name`, `model` |
| most | `permission_mode` (`default`, `plan`, …); turn-scoped events also have `turn_id` |
| tool-scoped and turn-scoped (in a sub-agent) | `agent_id`, `agent_type`, optional |
| `SessionStart` | `source`: `startup`, `resume`, `clear` or `compact` |
| `SessionEnd` | `reason`, which is always `"other"` today; no `turn_id` or `model` |
| `UserPromptSubmit` | `turn_id`, `prompt` |
| `Stop` | `turn_id`, `stop_hook_active`, `last_assistant_message` |
| `SubagentStart` | `turn_id`, `agent_id`, `agent_type` |
| `SubagentStop` | `turn_id`, `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, `last_assistant_message` |
| `Interrupt` | `turn_id` |
| `Pre/PostToolUse` | `turn_id`, `tool_name`, `tool_use_id`, `tool_input` (plus `tool_response` for Post) |

**Session end: yes, Codex has one.** `SessionEnd` fires for the main thread when Codex closes normally,
when an open conversation is archived or deleted, and after 30 minutes of idleness with no connected
client. It does **not** fire on a crash or a kill. The adapter's sweep covers those cases: it runs after
`SessionStart` and at most hourly after any other hook, and ends a session whose rollout has been idle
for more than 1 h. It emits `session_end` with reason `crashed` and the last activity time.
`ai-obs flush` does not call adapters, so it does not sweep.

**`Stop` arrives before `task_complete` is in the rollout:** stop hooks can still continue the turn,
so Codex records `task_complete` after they have run. On `Stop`, the adapter re-reads the rollout for up to
1.5 s. If the turn is still open after that, it closes the turn at the hook time with
`last_assistant_message`, and ignores the late `task_complete`. A `token_count` written after that
point counts toward the next turn.

### Hook output (the SessionStart nudge)

`ai-obs hook codex SessionStart` may print one text into the model's context (the token nudge, see
`src/nudge.ts`). Every other hook stays silent on stdout.

- **Format ai-obs uses for Codex: plain text on stdout** (`SESSION_START_OUTPUT.codex = 'text'`). Claude Code gets
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}` instead.
- **Why not JSON:** the 0.154.0 binary embeds a schema `session-start.command.output` that lists
  `hookSpecificOutput.additionalContext`, but the owner's check of codex-cli 0.154.0 found that the JSON form is
  rejected there, so Codex gets plain text. The first design checked both forms as accepted; that is superseded.
  If a later Codex accepts JSON, set `SESSION_START_OUTPUT.codex` to `'json'` (or `'none'` to turn the nudge off for Codex).
  No other change is needed.
- **Reproduce:** run `codex exec --skip-git-repo-check` (add `--dangerously-bypass-hook-trust` for a hook that is not
  trusted yet) with a temporary `CODEX_HOME` whose `hooks.json` has a `SessionStart` command that prints the text, and
  a model provider that cannot be reached (for example `127.0.0.1:9`), so no network is used. Then look at the rollout:
  accepted output is recorded as a `developer` message with `content_item_kinds: ["hooks.additional_context"]` before
  the model call. Do this with the plain text and with the JSON form and compare.
- The installed Codex hook commands are unchanged (no re-trust is needed); the nudge ships with the runtime copy
  in `<home>/app`.

## Rollout files

**Path:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`. Archived rollouts are
in `$CODEX_HOME/archived_sessions/`. The hook payload's `transcript_path` points at the file. When it is
null (the `codex exec` payload), the adapter scans newest-first for `*-<session_id>.jsonl`. Thread ids
are UUIDv7. Older ones are v4.

Each line is `{"timestamp": ISO, "ordinal"?: n, "type": …, "payload": {…}}`. The `ordinal` field
appears in migrated files and in files from 0.147 onward. These are the line types the adapter uses
(★ marks the ones that matter):

| `type` / `payload.type` | Used for |
|---|---|
| ★ `session_meta` (line 1) | `id` = `session_id` = thread id, `timestamp`, `cwd` (only for the project key), `cli_version` (sent as `harness_version`), `originator`, `source`, `thread_source` (`"user"` since 0.147) |
| ★ `event_msg/task_started` | Turn start: `turn_id`. 0.147+ also has `started_at` in epoch seconds |
| ★ `turn_context` | `turn_id`, `model`, `effort` (also `collaboration_mode.settings.reasoning_effort`); one per turn |
| ★ `event_msg/token_count` | `info.total_token_usage` (cumulative per thread) and `info.last_token_usage` (one request); `info` can be null |
| ★ `event_msg/task_complete` | Turn end: `turn_id`, `last_agent_message`. 0.147+ adds `duration_ms` and `completed_at` |
| ★ `event_msg/turn_aborted` | Turn end: `reason` is `interrupted`, `replaced` or `review_ended`. The turn's outcome is `abandoned` |
| `event_msg/error` | Fatal turn error, giving `stop_failure` |
| `event_msg/item_completed` `item.type = UserMessage / AgentMessage` | Prompt and last message (local digest and correction check only). Legacy files have `event_msg/user_message` and `event_msg/agent_message` |
| `response_item/reasoning`, `response_item/message` (assistant) | Model output, for the phase timeline |
| ★ `response_item/function_call` | `name`, `arguments` (a JSON string), `call_id`. MCP tools carry `namespace: "mcp__<server>"` |
| ★ `response_item/custom_tool_call` | `apply_patch` with freeform `input` (the patch text) |
| `response_item/function_call_output` / `custom_tool_call_output` | `call_id`, `output` (text) |
| `response_item/local_shell_call`, `web_search_call`, `tool_search_call` | Older or other tool shapes, all handled |
| ignored | `world_state`, `thread_settings_applied`, developer and user `response_item/message` (they hold injected AGENTS.md and environment context), `token_usage_record` |

### Tokens

ai-obs uses the **differences between consecutive `total_token_usage` snapshots**, not
`last_token_usage`:

- Codex repeats a snapshot with identical totals, for example after a tool call. A snapshot equal to
  the previous one is skipped.
- A delta can never be counted twice, even if a line were seen twice.
- If the totals go backwards (rare: a rewritten thread), that one step uses `last_token_usage`.

Every delta is one request. In the local data, Σ`last_token_usage` equals the final total in every file.

Codex follows the OpenAI convention: `input_tokens` **includes** `cached_input_tokens` (and
`cache_write_input_tokens`, which is always 0 so far), and `output_tokens` includes
`reasoning_output_tokens`. ai-obs stores input without cache, so the mapping is:
`input = Δinput − Δcached − Δcache_write`, `cache_read = Δcached`, `cache_write = Δcache_write`,
`output = Δoutput`, `reasoning = Δreasoning`.

Each delta is attributed to the model and effort of the current `turn_context`. Usage seen outside any
turn is carried into the next turn.

0.154 also writes `token_usage_record` lines (`response_id`, `turn_id`, `root_turn_id`, `usage`,
`turn_token_usage`, `thread_token_usage`). They agree with `token_count` but are not in older files, so
they are ignored.

### Tools and phases

| Tool (`name`) | Phase / signal |
|---|---|
| `exec_command` `{cmd, workdir?, yield_time_ms?}` (0.10x+); `shell` / `local_shell` `{command: argv}` (older) | `classifyCommand(cmd)`, so test and validate runs feed the outcome. The command text is used only locally |
| Output `Process exited with code N` (unified exec), `{"metadata":{"exit_code":N}}` or `Exit code: N` (legacy) | Exit code of the last test / validate run |
| Output `Process running with session ID N` | The process keeps running. `write_stdin {session_id: N}` inherits its phase, and its later `exited with code` output resolves the check |
| `apply_patch`: freeform `input` with `*** Begin Patch` / `*** Add|Update|Delete File: p` / `*** Move to: p` / `+` / `-` lines | coding, or documenting when every path is a doc. Gives files touched (a count of local hashes), lines added and removed, and the revert fingerprint |
| `spawn_agent`, `wait_agent` / `wait`, `followup_task`, `resume_agent` | `delegating`. This is dropped from the parent, because the time counts in the child run |
| `send_message`, `send_input`, `close_agent`, `list_agents`, `update_plan`, `request_permissions`, `tool_search` | other |
| `web_search`, `view_image` | exploring |
| MCP (`namespace mcp__…`) | other, counted as tool `mcp` and per server × tool in `mcp` (ADR-0016) |
| `event_msg` `item_completed` with `item.type = "McpToolCall"` `{server, tool, status: "completed" \| "failed", result: {isError}, duration: {secs, nanos}}` | MCP reliability (`mcp_stats`): `failed` or `isError` → error; `duration` → latency. Arguments and result content are not read. Codex writes no refusal marker, so `denied` stays 0 |
| `exec_command` / `shell` that reads `…/<name>/SKILL.md` (`cat`, `sed`, `head`, …) | Codex has no skill tool: the model opens a skill by reading its SKILL.md (the `<skills_instructions>` developer message lists them). Counted as one `model` use of skill `<name>` (the directory). Codex writes no marker for a skill the user names in a prompt, so `user` uses are never recorded for Codex |

`git checkout -- / restore / reset --hard / revert / stash` in the next turn, or removing at least 80 %
of the lines the previous turn added, marks the previous turn `next_turn_revert`.

## Sub-agents (BRIEF §13.1)

**What the data shows:** none of the 13 local rollouts contains a sub-agent, so this part is built from
the 0.154 binary (strings, hook schemas, the `state_5.sqlite` schema) and has not been checked against
a real multi-agent session:

- A sub-agent is its **own thread with its own rollout file**. `state_5.sqlite` has a
  `thread_spawn_edges(parent_thread_id, child_thread_id, status)` table, and `threads` has
  `agent_nickname`, `agent_role`, `agent_path` and `thread_source`.
- In its rollout, `session_meta.source` is `{"subagent": {"thread_spawn": {"parent_thread_id", "depth",
  "agent_nickname", "agent_role"}}}`. Other helper threads use `{"subagent": "review" | "compact" | …}`.
  The adapter treats any `source.subagent`, a `parent_thread_id`, or a `thread_source` that matches
  `subagent|spawn` as a sub-agent, and never processes such a thread as a main session.
- The parent's `spawn_agent` output returns the child's id (`agent_id` / thread id), and
  `SubagentStop` gives `agent_id` plus `agent_transcript_path`.

**How the adapter links them:** when a main turn closes, it resolves every child id from that turn's
`spawn_agent` outputs, finds each child's rollout and turns the whole child thread into one `run` with:

- `run_id` = the child thread id
- `turn_id` = the parent's turn
- `parent_run_id` = null for a direct child (depth 1); a grandchild found in the child's own
  `spawn_agent` outputs gets the child's id and depth 2, and so on up to depth 5
- `agent_type` = `agent_role`, else the hook's `agent_type`, else `default`
- `agent_group` = the same role / type; omitted when it fell back to `default`
- no `stage_index`, `flow_key` or `links` (ADR-0020): Codex records nothing to derive them from yet

The turn's `usage` = main agent + all descendants. A `SubagentStop` that arrives after the parent turn
was sent re-resolves the children, emits the `run` and re-sends the `turn` with merged usage. The resend
uses a new event id (`idSalt rev<n>`), and the server replaces the turn's usage rows.

**Limitations to verify with a real multi-agent session:**

- the exact shape of `spawn_agent` output and of `session_meta.source`;
- whether Codex also fires `SessionStart` / `Stop` for sub-agent threads (they are ignored if it does);
- that `SubagentStop.session_id` is the parent's (otherwise the adapter walks up `parent_thread_id`).

**MultiAgentV2 (unverified).** The 0.154 binary also contains a second multi-agent generation
(`features.multi_agent_v2`; strings `fork_context is not supported in MultiAgentV2`, `spawned agent is
missing a canonical task name`, `task_name`, `target_agent_path`, tool `assign_agent_task`). V2
addresses agents by a canonical task path rather than returning a UUID `agent_id` from `spawn_agent`.
What the adapter does about it:

- `assign_agent_task` counts as `delegating` time, like `spawn_agent` / `wait_agent`.
- When a `spawn_agent` output carries no UUID, the turn records no child from it; the child is linked
  later by `SubagentStop` (`agent_id`, `agent_transcript_path`, then the `parent_thread_id` walk), which
  emits its `run` and re-sends the turn. A V2 child whose `SubagentStop` never arrives is missing.
- Record the real V2 `spawn_agent` / `assign_agent_task` output and child `session_meta` here once a
  multi-agent rollout is available.

A child that gets several tasks (`followup_task`) stays **one run**, attached to the turn that spawned
it.

## Version differences seen

| Version | Notes |
|---|---|
| legacy (before `session_meta`, 2025-09) | First line is `{id, timestamp, instructions, git}`, then bare `{type: "message" …}` lines and `{record_type: "state"}`. **Not supported**: it produces no events |
| 0.94 to 0.108 | `turn_context.approval_policy` is a string. No `ordinal` and no `internal_chat_message_metadata_passthrough` in the original files (the local copies were migrated, `history_mode`) |
| 0.147+ | `thread_source`, `world_state`, `dynamic_tools`, `task_started.started_at`, `task_complete.duration_ms`, `item_completed` for MCP / FileChange / Reasoning, `thread_settings_applied` |
| 0.154 | `token_usage_record`. `codex migrate-rollouts` moves legacy sessions to "paginated thread history" (`thread_history_1.sqlite`). If a rollout shrinks under the cursor, the adapter skips to its end instead of double counting |

**Risk:** if a future Codex stops writing JSONL rollouts and keeps history only in SQLite
(`background_paginated_rollout_migration` is "under development"), the adapter sees no rollout. It logs
`rollout not found`, and the hooks alone are not enough. Watch `transcript_path` in the hook payloads.

## Summaries

The adapter makes **one** batched headless call (`codex exec` exits on its own after one turn):

```
codex exec --ephemeral --skip-git-repo-check --sandbox read-only --ignore-user-config --ignore-rules \
  -c features.hooks=false -c model_reasoning_effort="low" -m <model> -
```

- The prompt goes on stdin.
- `AI_OBS_SUMMARIZING=1` is set, `--ephemeral` writes no rollout, and `--ignore-user-config` keeps the
  user's MCP servers and plugins from starting. Auth still comes from `CODEX_HOME`. If the call fails, it
  is retried once with the user's config, for custom providers.
- **Model:** `AI_OBS_CODEX_SUMMARY_MODEL` if it is set. Otherwise the smallest *listed* model in
  `$CODEX_HOME/models_cache.json`: a `mini` / `nano` slug wins, then "affordable" / "cheap", then
  "fast" / "efficient" in the description. On this machine that is `gpt-5.6-luna`, because no `-mini`
  model is offered. The fallback is `gpt-5.4-mini`.
- **When:** at `SessionEnd`, in the sweep, and mid-session once 10 turns are waiting.
