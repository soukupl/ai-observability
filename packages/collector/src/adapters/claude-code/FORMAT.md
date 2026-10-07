# Claude Code: hook and transcript format (as observed)

Sources: the Claude Code hooks reference (code.claude.com/docs/en/hooks), `claude --help`, and the
local transcripts on the developer machine, which were read for structure only and never copied.
**Version seen: 2.1.289** (the macOS CLI, Oct 2026). Transcripts written by older 2.1.x builds in the
same directories had the same shape. The fixtures in `test/claude-code/fixture.ts` are synthetic
and have the same shape.

## Hooks (`settings.json`)

User scope is `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when that is set.
Project scope is `<repo>/.claude/settings.json`.

```json
{ "hooks": { "Stop": [ { "matcher": "optional", "hooks": [ { "type": "command", "command": "…", "timeout": 10 } ] } ] } }
```

- **`command`** is a shell string. The docs also list `args`, `shell`, `async`, `if` and
  `statusMessage`. We write only `type` and `command`, because the string form works in every 2.x
  version, and we write one matcher-less group per event.
- **Matchers:** `SessionStart` (source), `SessionEnd` (reason), `SubagentStop` (agent type) and
  `StopFailure` (error type) accept matchers. `Stop` and `UserPromptSubmit` always fire. Leaving
  the matcher out means "all".
- **`disableAllHooks: true`** turns every hook off, and `doctor` reports it.

### Stdin payloads

Every hook gets these common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name` and
`permission_mode`. The docs also list `prompt_id`, `effort` and `scratchpad_dir` as common fields;
the adapter does not read them today.

| Hook | Extra fields we use | Notes |
|---|---|---|
| `SessionStart` | `source`: `startup` \| `resume` \| `clear` \| `compact` \| `fork` | Also has `model` and `agent_type`. On resume / fork it has `seconds_since_last_response` and similar fields (when the transcript has a response). `fork` (`--fork-session`, `/fork`, `/branch`, moving a conversation to the background) starts a new session whose transcript begins with the parent's conversation; the adapter skips to the end of the file for a fork it has never seen, like `resume` / `compact`. A real fork transcript has not been seen yet (no shared response ids across 200 local transcripts): record whether copied entries keep the parent's `sessionId` once one is. |
| `UserPromptSubmit` | `prompt` (used locally for the correction check only) | Also has `prompt_id`. It fires for turns Claude Code starts itself, such as task notifications. The docs also list `is_continuation`, which is not read today (it could replace part of the continuation heuristic below). |
| `Stop` | — | A `Stop` or `UserPromptSubmit` payload with `agent_id` (fired inside a sub-agent) is ignored. `stop_hook_active` (true when a Stop hook already made Claude continue), `last_assistant_message`, `prompt_id` |
| `StopFailure` | `agent_id` (only inside a sub-agent) | Fires instead of `Stop` when an API error ends the turn. It has `error_type` and `error_message`, for example `{"hook_event_name":"StopFailure","error_type":"rate_limit","error_message":"…"}`. Documented `error_type` values include `rate_limit`, `authentication_failed`, `billing_error`, `model_not_found`, `cloud_credential_error` and `unknown`; the older list in this file (`overloaded`, `server_error`, `max_output_tokens`) was never confirmed, so treat the set as open (not re-verified against a live payload). Inside a sub-agent the payload also carries `agent_id` and `agent_type` (the docs: "fires when the turn ends due to an API error, including inside a subagent"). The adapter reads only `agent_id`: with it, the sub-agent's run is marked failed (`stop_failure`) and the main turn is left alone; without it, the main turn fails. The field is `error_type`, not `error`. |
| `SubagentStop` | `agent_id` | Also has `agent_type`, `agent_transcript_path` and `last_assistant_message`. |
| `SessionEnd` | `reason`: `clear` \| `resume` \| `logout` \| `prompt_input_exit` \| `other` | |

## Session transcript `~/.claude/projects/<cwd with non-alphanumerics → '-'>/<session_id>.jsonl`

The file is append-only JSONL with one entry per line. Every message entry has `type`, `uuid`,
`parentUuid`, `timestamp` (ISO), `sessionId`, `cwd`, `gitBranch`, `version` (the CLI version),
`isSidechain` and `userType`.

### Entry types

| `type` | What it is | Used |
|---|---|---|
| `user`, string `message.content` | A typed prompt. Also slash commands (`<command-message>x</command-message><command-name>/x</command-name><command-args>…`; the name is kept as the prompt's `command`, the args never), task notifications (`<task-notification>…`, with `origin.kind = "task-notification"` and `promptSource: "system"`) and local-command output (`<local-command-stdout>`, `<local-command-caveat>`) | Prompts start turns. Local-command output is ignored. |
| `user`, content `[{type:"text"},{type:"image"}…]` | A prompt with attachments | Treated as a prompt. |
| `user`, content `[{type:"tool_result", tool_use_id, content, is_error?}]` + top-level `toolUseResult` | A tool result | Exit codes, edit stats and agent status. |
| `user` with `isMeta: true` / `isCompactSummary` / `isVisibleInTranscriptOnly` | Skill expansions, caveats, compaction summaries, queued input delivered as meta | Not prompts. Agent activity after such an entry with no prompt counts as a continuation of the previous turn. An `isMeta` entry right after a typed `/name` prompt, with no `sourceToolUseID` and not a `<local-command-…>` / `<command-…>` text, is the skill's (or custom command's) **expansion**: it counts one `user` use of that skill (slim kind `expansion`; it is not activity and does not move the turn's end). Built-in commands (`/model`, `/compact`, `/clear`, …) are followed by `<local-command-stdout>` or nothing, never by an expansion. A Skill tool call's expansion has `sourceToolUseID` and is not counted again; a skill the harness loads itself writes a meta entry with its own `<command-name>` (no slash) and is not counted. |
| `user` text `[Request interrupted by user]` / `[Request interrupted by user for tool use]` | Esc or a rejected tool. No `Stop` follows. | Marks the turn as interrupted. |
| `assistant` | **One entry per content block** (`thinking`, `text`, `tool_use`). The entries of one API response share `message.id` and `requestId`, and **each repeats the full `message.usage`**. | Tokens (de-duplicated by `message.id`), model, effort, tools, timeline. |
| `assistant` with `isApiErrorMessage: true`, `message.model: "<synthetic>"` | An API error placeholder (e.g. a 429) | Counts as activity; carries no usage. |
| `system` `subtype: "stop_hook_summary"` / `"turn_duration"` | Written at the end of a turn (`stop_hook_summary` only when Stop hooks exist; with ai-obs installed they always do) | A turn boundary for injected task notifications. |
| `system` (`compact_boundary`, `api_error`, `away_summary`, `local_command`, …), `attachment`, `file-history-snapshot`, `file-history-delta`, `queue-operation`, `last-prompt`, `custom-title`, `ai-title`, `agent-name`, `mode`, `permission-mode`, `cost-state`, `atis-latch` | Housekeeping | Ignored. |

### Assistant fields

- **`message.model`**: for example `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5` or
  `claude-haiku-4-5`. `<synthetic>` marks an error placeholder.
- **`message.usage`**: `input_tokens` (fresh input, which already excludes the cache),
  `cache_read_input_tokens`, `cache_creation_input_tokens` (split into
  `cache_creation.ephemeral_{5m,1h}_input_tokens`), `output_tokens` and
  `output_tokens_details.thinking_tokens` (part of the output → our `reasoning`). Also present but
  unused: `service_tier`, `server_tool_use`, `iterations[]`, `speed`, `inference_geo` and
  `fallback_credit`.
- **Effort:** `effort` and `perTurnEffort` are top-level entry fields (`medium`, `high`, `xhigh` or
  `max`). We use `effort`, then `perTurnEffort`, else null (no effort known). In sub-agents,
  `perTurnEffort` is often null while `effort` is set.
- **Also present:** `apiBlockIndex`, `advisorModel` and `attribution*` (skill, plugin, MCP).

### Tool inputs we read (locally; only counts and phases leave)

| Tool | Input | Result (`toolUseResult`) |
|---|---|---|
| `Bash` | `command`, `description`, `timeout?`, `run_in_background?` | `{stdout, stderr, interrupted, isImage, noOutputExpected, returnCodeInterpretation?}`. The **exit code is not a field**: a non-zero exit has `is_error: true` and content starting `Exit code N`, and success has no error. |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` | `{filePath, oldString, newString, originalFile, structuredPatch:[{oldStart, oldLines, newStart, newLines, lines:[" ctx", "-old", "+new"]}], userModified}` |
| `Write` | `file_path`, `content` | `{type: "create"\|"update", filePath, content, structuredPatch, originalFile}`. `create` has an empty patch, so its lines are the content's lines. |
| `MultiEdit` / `NotebookEdit` | `edits[]` / `notebook_path`, `new_source` | Counts are estimated from the input. |
| `Skill` | `skill` (e.g. `code-review`, `plugin:skill`), `args?` | `Launching skill: <name>`. Counts one `model` use of `input.skill`; the args are not read. |
| `mcp__<server>__<tool>` | (not read) | Counted per server × tool (`<server>` up to the first `__` after the prefix). Paired with its `tool_result` by `tool_use_id`: `is_error` → error; a refusal (`The user doesn't want to proceed with this tool use…`, `Permission for this tool use was denied…`, `[Request interrupted by user for tool use]`; from Claude Code's known texts, not yet in a recorded fixture) → `denied`; result time − call time → latency. A call without a result at turn end counts in neither. |
| `Agent` (formerly `Task`) | `description`, `prompt`, `subagent_type`, `model?`, `run_in_background?` | Sync: `{status:"completed", agentId, agentType, totalTokens, usage, …}`. Background: `{status:"async_launched", agentId, isAsync:true, outputFile}`. |

Lines added and removed come from `structuredPatch` when it is present, and otherwise from a
multiset line diff of the input. Files touched is the number of distinct, successfully edited paths
(stored only as hashes).

## Sub-agent transcripts `<project dir>/<session_id>/subagents/agent-<agentId>.jsonl`

- **Entries:** the same entry shapes, with `isSidechain: true` and `agentId`. The first entry is a
  user prompt (the task).
- **Meta file:** `agent-<agentId>.meta.json` holds `{agentType, description, toolUseId, spawnDepth,
  parentAgentId?, model?, requestShape?, requestNonInteractive?, worktreePath?}`. `toolUseId` is the
  `Agent` tool_use id in the parent transcript, which is the main session or, when
  `parentAgentId` is set, the parent sub-agent's file. `spawnDepth` is 1 for agents the main agent
  spawns and 2 or more for nested ones.
- **Workflow sub-agents:** agents of the Workflow tool live in
  `subagents/workflows/<wf_id>/agent-<id>.jsonl` (same entry shapes, `isSidechain: true`). Their
  meta has `{agentType: "workflow-subagent", description (the label), workflowPhase, spawnDepth: 1,
  requestShape, requestNonInteractive, model?, spawnedWithWorktree?, worktreePath?}`: no `toolUseId`
  and no `parentAgentId`. Seen on this machine: 2349 agents, all `workflow-subagent` at depth 1.
- **Workflow journal:** `subagents/workflows/<wf_id>/journal.jsonl` has one JSON object per line:
  `{type: "launched"}`, `{type: "started", key, agentId, label, phase}`,
  `{type: "result", key, agentId, result}` and `{type: "failed", key, agentId}`. `result` holds the
  agent's reply and is never read. `started` without `result` / `failed` means still running.
- **Workflow run file:** `<session>/workflows/<wf_id>.json` is written when the run ends:
  `{runId, workflowName, status: "completed" | "failed" | "killed", agentCount, totalTokens, script, result, …}`.
  Only `status` is read. `<session>/workflows/scripts/` holds the script and is never read.
- **Linking to the main transcript:** the `Workflow` tool_use is answered at once with
  `toolUseResult: {status: "async_launched", taskType: "local_workflow", runId: "wf_…", workflowName,
  taskId, transcriptDir, scriptPath}`. The workflow later finishes with a `<task-notification>`
  prompt. The adapter links the agents to the turn that holds that tool result (the synthetic
  `agentCalls` key `wf:<runId>`).

## Observed quirks that shape the parser

- **Other session ids:** a file can mention another session's id (for example inside content).
  Every message entry seen carried the file's own `sessionId`; as a safety net, the parser skips
  message entries whose `sessionId` differs.
- **Several Stops per prompt:** one prompt can see several Stops. A Stop hook that blocks makes
  Claude continue, and queued input can arrive as `isMeta`. The adapter treats activity with no new
  prompt as a continuation: the turn is re-sent with the added work under a new event id
  (`idSalt rev<n>`), and the server replaces its rows.
- **Injected task notifications:** a task notification can arrive in the middle of a running turn
  (no `stop_hook_summary` since the prompt). It does not start a new turn.
- **Large files:** transcripts reach 90 MB. The reader works from a byte cursor in 4 MB chunks and
  slims every line straight away.

## Run grouping fields (`agent_group`, `orchestration_id`)

Both are optional `run` fields derived from the meta file, never from content.

- Workflow agent: `agent_group` = `workflow:<slug of workflowPhase>` (for example `workflow:build`),
  else the group the dashboard derives from the stored `agent_type` (`workflow:<verb>`: first token of the
  description's slug split on `[-:._/ ]`, lower-cased, trailing digits stripped, so `fix1-m8-brief` and
  `Fix(m8) brief` both give `workflow:fix`; `workflow` when there is none; `workflow-subagent` without a
  description). `orchestration_id` = the `wf_…` id.
- Agent-tool sub-agent: `agent_group` = the agent type (`Explore`, `general-purpose`, ...), omitted when
  unknown. No `orchestration_id`.
