import { createHash } from 'node:crypto';
import { checkKind, classify, type PhaseOrDelegating } from '../../analysis/phases.js';
import { skillReadBy } from '../../analysis/usage.js';

/**
 * Codex tool calls → phase / check / edit facts. Command lines and patch text are used ONLY here,
 * locally, and never leave this module except as phases, counts and hashes.
 */

/**
 * Multi-agent tools: spawning a sub-agent, handing it work and waiting for it is `delegating` time.
 * `assign_agent_task` is MultiAgentV2 (agents addressed by canonical task path; seen in the 0.154
 * binary, not yet in a real rollout — see FORMAT.md).
 */
const DELEGATING = new Set([
  'spawn_agent',
  'assign_agent_task',
  'wait',
  'wait_agent',
  'wait_for_agent',
  'wait_agents',
  'followup_task',
  'resume_agent',
]);
const AGENT_PLUMBING = new Set(['send_input', 'send_message', 'close_agent', 'list_agents']);

export interface PatchFacts {
  /** file paths (local only; hashed before they are stored) */
  files: string[];
  added: number;
  removed: number;
  /** per-file added/removed line text for revert fingerprints (hashed by editFingerprint) */
  edits: Array<{ filePath: string; added: string[]; removed: string[] }>;
}

/**
 * Parses the Codex apply_patch envelope:
 *   *** Begin Patch / *** Add File: p / *** Update File: p / *** Move to: p / *** Delete File: p / @@ / +x / -y / *** End Patch
 */
export function parseApplyPatch(text: string): PatchFacts {
  const facts: PatchFacts = { files: [], added: 0, removed: 0, edits: [] };
  let cur: PatchFacts['edits'][number] | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (head) {
      cur = { filePath: head[2]!.trim(), added: [], removed: [] };
      facts.edits.push(cur);
      facts.files.push(cur.filePath);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) {
      facts.files.push(move[1]!.trim());
      continue;
    }
    if (!cur || line.startsWith('***')) continue;
    if (line.startsWith('+')) {
      facts.added++;
      cur.added.push(line.slice(1));
    } else if (line.startsWith('-')) {
      facts.removed++;
      cur.removed.push(line.slice(1));
    }
  }
  return facts;
}

/** Patch text of an apply_patch call in any of its Codex shapes (freeform, JSON args, shell argv / heredoc). */
export function patchTextOf(name: string, args: Record<string, unknown> | null, input: string | null): string | null {
  if (name === 'apply_patch') {
    if (input) return input;
    const a = args?.input ?? args?.patch;
    return typeof a === 'string' ? a : null;
  }
  const cmd = commandOf(args);
  if (Array.isArray(cmd) && /(^|\/)apply_patch$/.test(String(cmd[0] ?? '')) && typeof cmd[1] === 'string') return cmd[1];
  const line = Array.isArray(cmd) ? cmd.join(' ') : cmd;
  if (typeof line === 'string' && /\bapply_patch\b/.test(line) && line.includes('*** Begin Patch')) return line.slice(line.indexOf('*** Begin Patch'));
  return null;
}

/** Shell command of exec_command (`cmd`), shell / local_shell (`command` argv or string). */
export function commandOf(args: Record<string, unknown> | null): string | string[] | null {
  const c = args?.cmd ?? args?.command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c as string[];
  return null;
}

export interface ToolFacts {
  phase: PhaseOrDelegating;
  /** test / validate run whose exit code feeds the outcome */
  check: 'testing' | 'validating' | null;
  /** destructive git command (revert signal for the previous turn) */
  revert: boolean;
  patch: PatchFacts | null;
  /** write_stdin: the exec process session it talks to */
  processId: string | null;
  /** a shell command that reads a skill's SKILL.md: the skill's name (Codex skill use) */
  skill?: string | null;
}

/** Classifies one Codex tool call. `processPhase` resolves write_stdin to its process's phase. */
export function toolFacts(
  name: string,
  args: Record<string, unknown> | null,
  input: string | null,
  processPhase: (id: string) => { phase: PhaseOrDelegating; check: 'testing' | 'validating' | null } | undefined,
  isRevert: (cmd: string | readonly string[]) => boolean,
): ToolFacts {
  const base: ToolFacts = { phase: 'other', check: null, revert: false, patch: null, processId: null };
  if (DELEGATING.has(name)) return { ...base, phase: 'delegating' };
  if (AGENT_PLUMBING.has(name)) return base;
  if (name === 'write_stdin') {
    const id = args?.session_id;
    const pid = typeof id === 'number' || typeof id === 'string' ? String(id) : null;
    const proc = pid ? processPhase(pid) : undefined;
    return { ...base, phase: proc?.phase ?? 'other', processId: pid };
  }
  const patchText = patchTextOf(name, args, input);
  if (patchText !== null) {
    const patch = parseApplyPatch(patchText);
    return { ...base, phase: classify('apply_patch', { filePaths: patch.files }), patch };
  }
  const cmd = commandOf(args);
  if (cmd && /^(exec_command|shell|local_shell|container\.exec|shell_command|unified_exec|bash)$/.test(name)) {
    const skill = skillReadBy(typeof cmd === 'string' ? cmd : cmd.join(' '));
    return { ...base, phase: classify('shell', { command: cmd }), check: checkKind(cmd), revert: isRevert(cmd), ...(skill ? { skill } : {}) };
  }
  if (name === 'view_image') return { ...base, phase: 'exploring' };
  return { ...base, phase: classify(name) };
}

/**
 * Exit code in a tool output: unified exec ("Process exited with code N"), legacy shell JSON
 * ({"metadata": {"exit_code": N}}) or text ("Exit code: N"). `running` = the process is still alive
 * ("Process running with session ID N"), continued via write_stdin.
 */
export function parseExecOutput(output: string): { exitCode: number | null; runningId: string | null } {
  const head = output.slice(0, 2000);
  const exited = /Process exited with code (-?\d+)/.exec(head) ?? /^Exit code: (-?\d+)/m.exec(head);
  if (exited) return { exitCode: Number(exited[1]), runningId: null };
  const running = /Process running with session ID (\d+)/.exec(head);
  if (running) return { exitCode: null, runningId: running[1]! };
  if (head.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(output) as { metadata?: { exit_code?: unknown } };
      if (typeof j.metadata?.exit_code === 'number') return { exitCode: j.metadata.exit_code, runningId: null };
    } catch {
      /* not JSON */
    }
  }
  return { exitCode: null, runningId: null };
}

/** Short local-only hash of a file path (distinct-file counting without keeping paths). */
export const pathHash = (p: string) => createHash('sha256').update(p).digest('base64url').slice(0, 12);

/** Child thread ids returned by spawn_agent ({"agent_id": …} / {"thread_id": …} / plain text). */
export function spawnedAgentIds(output: string): string[] {
  const ids = new Set<string>();
  const re = /"(?:agent_id|thread_id|new_thread_id|id)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;
  for (const m of output.slice(0, 20_000).matchAll(re)) ids.add(m[1]!.toLowerCase());
  return [...ids];
}
