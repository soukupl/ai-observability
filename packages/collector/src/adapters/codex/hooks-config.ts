import { readFileSync, statSync } from 'node:fs';
import { writeFileAtomic } from '../../fsutil.js';
import { isAiObsHookCommand } from '../hook-command.js';

/**
 * Codex hooks.json (user: ~/.codex/hooks.json, project: <repo>/.codex/hooks.json):
 *   { "hooks": { "<Event>": [ { "matcher"?: "…", "hooks": [ { "type": "command", "command": "<shell>", "timeout"?: s } ] } ] } }
 * `command` is ONE shell string (run with the session cwd), so we write HookCommand.shell.
 */
export interface CodexHookHandler {
  type?: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}
export interface CodexMatcherGroup {
  matcher?: string;
  hooks?: CodexHookHandler[];
  [k: string]: unknown;
}
export interface CodexHooksFile {
  hooks?: Record<string, CodexMatcherGroup[]>;
  [k: string]: unknown;
}

/**
 * Events we install. Tool hooks (Pre/PostToolUse) are deliberately NOT installed: everything they
 * carry is in the rollout, and a worker spawn per tool call would be wasted work.
 */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionEnd'] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

/** SessionEnd hooks default to a 1 s timeout (max 3 s); give Node's cold start room. */
const TIMEOUTS: Partial<Record<CodexHookEvent, number>> = { SessionEnd: 3 };

/** `SessionStart` → `session_start` (the form used in config.toml `hooks.state` keys). */
export const snakeEvent = (e: string) => e.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

const ours = (h: CodexHookHandler | undefined) => Boolean(h && typeof h.command === 'string' && isAiObsHookCommand(h.command));

/** Reads hooks.json. Missing → empty; unparsable → throws (never overwrite a file we cannot read). */
export function readHooksFile(path: string): CodexHooksFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as CodexHooksFile;
}

/** Writes atomically, keeping the file's existing mode (default 0644: Codex must read it). */
export function writeHooksFile(path: string, file: CodexHooksFile): void {
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    /* new file */
  }
  writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, mode);
}

/**
 * Adds our handler to each event. Idempotent: an existing ai-obs handler is updated IN PLACE (so the
 * group/handler indices that Codex keys hook trust on stay stable) and duplicates are dropped; a
 * missing one is APPENDED as a new matcher group, so other tools' indices never shift.
 */
export function mergeAiObsHooks(file: CodexHooksFile, command: (event: CodexHookEvent) => string): CodexHooksFile {
  const out: CodexHooksFile = structuredClone(file);
  const hooks: Record<string, CodexMatcherGroup[]> = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  out.hooks = hooks;
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const handler: CodexHookHandler = { type: 'command', command: command(event), ...(TIMEOUTS[event] ? { timeout: TIMEOUTS[event] } : {}) };
    let placed = false;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      g.hooks = g.hooks.flatMap((h) => {
        if (!ours(h)) return [h];
        if (placed) return [];
        placed = true;
        return [{ ...h, ...handler }];
      });
    }
    const kept = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (!placed) kept.push({ hooks: [handler] });
    hooks[event] = kept;
  }
  return out;
}

/** Removes every ai-obs handler (any event); drops groups / events left empty. */
export function removeAiObsHooks(file: CodexHooksFile): { file: CodexHooksFile; removed: number } {
  const out: CodexHooksFile = structuredClone(file);
  let removed = 0;
  if (!out.hooks || typeof out.hooks !== 'object') return { file: out, removed };
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: CodexMatcherGroup[] = [];
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const before = g.hooks.length;
      const hooks = g.hooks.filter((h) => !ours(h));
      removed += before - hooks.length;
      if (hooks.length || before === 0) kept.push({ ...g, hooks });
    }
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  return { file: out, removed };
}

/** Positions of our handlers: event → [groupIndex, handlerIndex]. */
export function aiObsHookPositions(file: CodexHooksFile): Map<string, [number, number]> {
  const pos = new Map<string, [number, number]>();
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => (Array.isArray(g.hooks) ? g.hooks : []).forEach((h, hi) => ours(h) && !pos.has(event) && pos.set(event, [gi, hi])));
  }
  return pos;
}

/** True when every event we need has our handler. */
export function hasAiObsHooks(file: CodexHooksFile): boolean {
  const pos = aiObsHookPositions(file);
  return CODEX_HOOK_EVENTS.every((e) => pos.has(e));
}

/**
 * Codex runs a non-managed hook only after the user trusted it (`/hooks` in Codex). Trust lives in
 * config.toml as `[hooks.state."<hooks.json path>:<snake_event>:<group>:<handler>"]` with a
 * `trusted_hash`. Returns our events that have no trust entry or are disabled. (We cannot verify the
 * hash itself; a changed command needs re-trust in Codex.)
 */
export function untrustedEvents(configToml: string, hooksPath: string, file: CodexHooksFile): string[] {
  const sections = new Map<string, string>();
  const re = /^\[hooks\.state\."((?:[^"\\]|\\.)*)"\]\s*$/gm;
  const heads = [...configToml.matchAll(re)];
  heads.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const rest = configToml.slice(start, heads[i + 1]?.index ?? configToml.length);
    const body = rest.split(/^\[/m)[0] ?? '';
    sections.set(m[1]!.replace(/\\(.)/g, '$1'), body);
  });
  const out: string[] = [];
  for (const [event, [gi, hi]] of aiObsHookPositions(file)) {
    const body = sections.get(`${hooksPath}:${snakeEvent(event)}:${gi}:${hi}`);
    if (body === undefined || !/trusted_hash\s*=/.test(body) || /enabled\s*=\s*false/.test(body)) out.push(event);
  }
  return out;
}

/** `[features] hooks = false` in config.toml (or a `features.hooks = false` dotted key). */
export function hooksFeatureDisabled(configToml: string): boolean {
  if (/^\s*features\.hooks\s*=\s*false\b/m.test(configToml)) return true;
  const m = /^\[features\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(configToml);
  return Boolean(m && /^\s*hooks\s*=\s*false\b/m.test(m[1] ?? ''));
}

/** Shell commands of our handlers in a parsed hooks.json. */
export function aiObsCommands(file: CodexHooksFile): string[] {
  const out: string[] = [];
  for (const groups of Object.values(file.hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) for (const h of Array.isArray(g.hooks) ? g.hooks : []) if (ours(h)) out.push(h.command as string);
  }
  return out;
}
