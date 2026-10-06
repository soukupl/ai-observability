import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { editFingerprint, isRevertCommand, type EditFingerprint } from '../../analysis/outcome.js';
import { classify, type PhaseOrDelegating } from '../../analysis/phases.js';
import type { UsageRecord } from '../../analysis/tokens.js';

/**
 * Claude Code transcript JSONL (see FORMAT.md) reduced to "slim" entries right after parsing: only
 * timestamps, ids, usage, tool names, phase decisions, counts and hashes survive. Prompt and final
 * message text is kept truncated for the LOCAL digest / correction check only; code, diffs and file
 * contents are dropped here, so they never reach state, the queue or the server.
 */

/** Max chars of prompt text kept (correction heuristics + digest; local only). */
const PROMPT_KEEP = 1000;
const MESSAGE_KEEP = 300;

export type SlimEntry =
  /** `command`: the typed slash command (`/name`, without the slash) when the prompt is one */
  | { k: 'prompt'; at: number; uuid: string; text: string; human: boolean; command: string | null }
  | { k: 'interrupt'; at: number }
  /** Meta entry that expands the typed slash command before it (a skill / custom command; built-ins have none) */
  | { k: 'expansion'; at: number }
  | { k: 'assistant'; at: number; usage: UsageRecord | null; synthetic: boolean; blocks: AssistantBlock[] }
  | { k: 'tool_result'; at: number; results: ToolResultInfo[]; userInterrupt: boolean }
  /** Claude Code's own end-of-turn records (system stop_hook_summary / turn_duration) */
  | { k: 'stop'; at: number };

export type AssistantBlock =
  | { t: 'output'; text: string | null }
  | {
      t: 'tool_use';
      id: string;
      name: string;
      phase: PhaseOrDelegating;
      /** test / validate / revert detection need the command; local only, never stored */
      command: string | null;
      /** path key used for counting distinct edited files; local only */
      filePath: string | null;
      edit: EditStats | null;
      /** Agent / Task tool: `subagent_type` and whether it was launched in the background */
      agent: { type: string | null; background: boolean } | null;
      /** Skill tool: the skill's name (`input.skill`) */
      skill: string | null;
    };

export interface EditStats {
  added: number;
  removed: number;
  fp: EditFingerprint;
}

export interface ToolResultInfo {
  id: string;
  isError: boolean;
  /** shell exit code: 0 for a successful Bash call, N from "Exit code N", null when unknown */
  exitCode: number | null;
  interrupted: boolean;
  /** exact line counts from toolUseResult.structuredPatch (Edit / Write), when present */
  edit: EditStats | null;
  /** Agent tool result status, e.g. "completed", "async_launched" */
  agentStatus: string | null;
  /** Workflow tool result: the run id (`wf_…`) of the workflow it launched */
  workflowRunId: string | null;
  /** the result text is Claude Code's "[Request interrupted by user …]" marker */
  userInterrupt: boolean;
}

export interface TranscriptLine {
  /** byte offset where the line starts */
  start: number;
  entry: SlimEntry;
}

export interface ReadResult {
  lines: TranscriptLine[];
  /** byte offset after the last complete line read */
  end: number;
  /** the stored offset was past EOF (file replaced / truncated); reading restarted at 0 */
  reset: boolean;
}

const CHUNK = 4 * 1024 * 1024;

/**
 * Reads complete lines from `offset` to EOF (a trailing partial line is left for the next read) and
 * slims them. Entries of a different session (copied history) are skipped.
 */
export function readTranscript(path: string, offset: number, sessionId?: string): ReadResult {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { lines: [], end: offset, reset: false };
  }
  try {
    const size = fstatSync(fd).size;
    let reset = false;
    let pos = offset;
    if (pos > size) {
      pos = 0;
      reset = true;
    }
    const lines: TranscriptLine[] = [];
    let carry = Buffer.alloc(0);
    let carryStart = pos;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let lineStart = 0;
      for (let i = data.indexOf(10); i >= 0; i = data.indexOf(10, lineStart)) {
        const text = data.toString('utf8', lineStart, i);
        const entry = text.trim() ? slimLine(text, sessionId) : null;
        if (entry) lines.push({ start: carryStart + lineStart, entry });
        lineStart = i + 1;
      }
      carry = data.subarray(lineStart);
      carryStart += lineStart;
    }
    return { lines, end: carryStart, reset };
  } finally {
    closeSync(fd);
  }
}

/** Reads a whole (sub-agent) transcript. */
export function readWholeTranscript(path: string): SlimEntry[] {
  return readTranscript(path, 0).lines.map((l) => l.entry);
}

// ---------------------------------------------------------------- slimming

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function slimLine(text: string, sessionId?: string): SlimEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return isObj(raw) ? slimEntry(raw, sessionId) : null;
}

export function slimEntry(o: Obj, sessionId?: string): SlimEntry | null {
  if (sessionId && typeof o.sessionId === 'string' && o.sessionId !== sessionId) return null;
  const at = Date.parse(str(o.timestamp) ?? '');
  if (!Number.isFinite(at)) return null;
  const message = isObj(o.message) ? o.message : null;
  if (o.type === 'assistant' && message) return slimAssistant(o, message, at);
  if (o.type === 'user' && message) return slimUser(o, message, at);
  if (o.type === 'system' && (o.subtype === 'stop_hook_summary' || o.subtype === 'turn_duration')) return { k: 'stop', at };
  return null;
}

function slimAssistant(o: Obj, m: Obj, at: number): SlimEntry {
  const model = str(m.model) ?? 'unknown';
  const synthetic = model.startsWith('<') || o.isApiErrorMessage === true;
  const u = isObj(m.usage) ? m.usage : null;
  const details = u && isObj(u.output_tokens_details) ? u.output_tokens_details : null;
  const usage: UsageRecord | null =
    u && !synthetic
      ? {
          responseId: str(m.id) ?? str(o.requestId),
          model,
          effort: str(o.effort) ?? str(o.perTurnEffort),
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
          reasoning: num(details?.thinking_tokens),
        }
      : null;
  const blocks: AssistantBlock[] = [];
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (!isObj(c)) continue;
    if (c.type === 'tool_use') blocks.push(slimToolUse(c));
    else if (c.type === 'text') blocks.push({ t: 'output', text: str(c.text)?.slice(-MESSAGE_KEEP * 2) ?? null });
    else blocks.push({ t: 'output', text: null });
  }
  if (typeof m.content === 'string') blocks.push({ t: 'output', text: m.content.slice(-MESSAGE_KEEP * 2) });
  return { k: 'assistant', at, usage, synthetic, blocks };
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function slimToolUse(c: Obj): AssistantBlock {
  const name = str(c.name) ?? 'unknown';
  const input = isObj(c.input) ? c.input : {};
  const command = name === 'Bash' ? str(input.command) : null;
  const filePath = EDIT_TOOLS.has(name) ? (str(input.file_path) ?? str(input.notebook_path)) : null;
  const phase = classify(name, { ...(command ? { command } : {}), ...(filePath ? { filePaths: [filePath] } : {}) });
  const isAgent = phase === 'delegating';
  return {
    t: 'tool_use',
    id: str(c.id) ?? '',
    name,
    phase,
    command: command && command.length > 4000 ? command.slice(0, 4000) : command,
    filePath,
    edit: filePath ? estimateEdit(name, input, filePath) : null,
    agent: isAgent ? { type: str(input.subagent_type), background: input.run_in_background === true } : null,
    skill: name === 'Skill' ? str(input.skill) : null,
  };
}

/** Line counts derived from the tool input (fallback when the result has no structuredPatch). */
function estimateEdit(name: string, input: Obj, filePath: string): EditStats | null {
  const pairs: Array<[string, string]> = [];
  if (name === 'Write') pairs.push(['', str(input.content) ?? '']);
  else if (name === 'Edit') pairs.push([str(input.old_string) ?? '', str(input.new_string) ?? '']);
  else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const e of input.edits) if (isObj(e)) pairs.push([str(e.old_string) ?? '', str(e.new_string) ?? '']);
  } else if (name === 'NotebookEdit') pairs.push(['', str(input.new_source) ?? '']);
  if (!pairs.length) return null;
  const added: string[] = [];
  const removed: string[] = [];
  for (const [a, b] of pairs) {
    const d = lineDiff(splitLines(a), splitLines(b));
    added.push(...d.added);
    removed.push(...d.removed);
  }
  return { added: added.length, removed: removed.length, fp: editFingerprint([{ filePath, added, removed }]) };
}

const splitLines = (s: string) => (s ? s.replace(/\n$/, '').split('\n') : []);

/** Multiset line diff: lines only in `b` are added, lines only in `a` removed. */
export function lineDiff(a: readonly string[], b: readonly string[]): { added: string[]; removed: string[] } {
  const counts = new Map<string, number>();
  for (const l of a) counts.set(l, (counts.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of b) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const [l, c] of counts) for (let i = 0; i < c; i++) removed.push(l);
  return { added, removed };
}

const INTERRUPT_RE = /^\[Request interrupted/;
const NOT_A_PROMPT_RE = /^<(local-command-(stdout|stderr|caveat)|bash-(stdout|stderr))>/;
const COMMAND_RE = /<command-name>\/([^<\s]{1,200})<\/command-name>/;

function slimUser(o: Obj, m: Obj, at: number): SlimEntry | null {
  const content = m.content;
  const parts = Array.isArray(content) ? content.filter(isObj) : [];
  const results = parts.filter((c) => c.type === 'tool_result');
  if (results.length) {
    const infos = results.map((r) => slimToolResult(r, o.toolUseResult));
    const marker = parts.some((c) => c.type === 'text' && INTERRUPT_RE.test((str(c.text) ?? '').trimStart())) || infos.some((r) => r.userInterrupt);
    return { k: 'tool_result', at, results: infos, userInterrupt: marker };
  }
  const text = typeof content === 'string' ? content : parts.filter((c) => c.type === 'text').map((c) => str(c.text) ?? '').join('\n');
  // Compaction summaries can be meta too: never an expansion (a typed `/compact` must not count as a skill).
  if (o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) return null;
  if (o.isMeta === true) return isCommandExpansion(o, text) ? { k: 'expansion', at } : null;
  if (INTERRUPT_RE.test(text.trimStart())) return { k: 'interrupt', at };
  if (!text.trim() && !parts.length) return null;
  if (NOT_A_PROMPT_RE.test(text.trimStart())) return null;
  const origin = isObj(o.origin) ? str(o.origin.kind) : null;
  const human = (origin === null || origin === 'human') && !/^<task-notification>/.test(text.trimStart());
  const command = COMMAND_RE.exec(text.slice(0, 2000))?.[1] ?? null;
  return { k: 'prompt', at, uuid: str(o.uuid) ?? `${at}`, text: text.slice(0, PROMPT_KEEP), human, command };
}

/**
 * The meta entry Claude Code writes right after a typed `/skill` or custom command: the skill's body.
 * Not one: a Skill tool's expansion (`sourceToolUseID`; counted from the tool call), local-command
 * caveats / output, and skills the harness loads itself (the meta entry carries its own `<command-name>`).
 */
function isCommandExpansion(o: Obj, text: string): boolean {
  if (typeof o.sourceToolUseID === 'string') return false;
  const t = text.trimStart();
  return Boolean(t) && !NOT_A_PROMPT_RE.test(t) && !/^<command-(name|message)>/.test(t);
}

function slimToolResult(r: Obj, toolUseResult: unknown): ToolResultInfo {
  const isError = r.is_error === true;
  const text = typeof r.content === 'string' ? r.content : Array.isArray(r.content) ? r.content.map((c) => (isObj(c) ? (str(c.text) ?? '') : '')).join('') : '';
  const exit = /^Exit code (\d+)/.exec(text.slice(0, 40));
  const tur = isObj(toolUseResult) ? toolUseResult : null;
  const userInterrupt = INTERRUPT_RE.test(text.trimStart().slice(0, 60));
  const interrupted = tur?.interrupted === true || userInterrupt;
  return {
    userInterrupt,
    id: str(r.tool_use_id) ?? '',
    isError,
    exitCode: exit ? Number(exit[1]) : isError ? null : 0,
    interrupted,
    edit: tur ? patchStats(tur) : null,
    agentStatus: tur ? str(tur.status) : null,
    workflowRunId: tur && tur.taskType === 'local_workflow' && /^wf_[A-Za-z0-9_-]{1,64}$/.test(str(tur.runId) ?? '') ? str(tur.runId) : null,
  };
}

/** Exact counts from Claude Code's structuredPatch (hunks with "+…" / "-…" lines). */
function patchStats(tur: Obj): EditStats | null {
  const hunks = tur.structuredPatch;
  const filePath = str(tur.filePath);
  if (!Array.isArray(hunks) || !filePath) return null;
  const added: string[] = [];
  const removed: string[] = [];
  for (const h of hunks) {
    if (!isObj(h) || !Array.isArray(h.lines)) continue;
    for (const l of h.lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) added.push(l.slice(1));
      else if (l.startsWith('-')) removed.push(l.slice(1));
    }
  }
  if (!added.length && !removed.length) {
    // A new file has no hunks; its content is the added lines.
    const content = tur.type === 'create' ? str(tur.content) : null;
    if (!content) return null;
    added.push(...splitLines(content));
  }
  return { added: added.length, removed: removed.length, fp: editFingerprint([{ filePath, added, removed }]) };
}

/** Whether any Bash command in these entries throws work away (git restore / checkout -- / reset --hard …). */
export function hasRevertCommand(entries: readonly SlimEntry[]): boolean {
  return entries.some((e) => e.k === 'assistant' && e.blocks.some((b) => b.t === 'tool_use' && b.command !== null && isRevertCommand(b.command)));
}
