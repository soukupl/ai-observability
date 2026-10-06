import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../../fsutil.js';
import { isAiObsHookCommand } from '../hook-command.js';
import type { HookCommand, InstallScope } from '../types.js';

/**
 * Claude Code hook config in settings.json:
 *   { "hooks": { "<Event>": [ { "matcher"?: "…", "hooks": [ { "type": "command", "command": "…" } ] } ] } }
 * We add one matcher-less group per event holding our command, and recognize our entries with
 * isAiObsHookCommand(). Everything else in the file is kept as is.
 */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SubagentStop', 'SessionEnd'] as const;

/** ~/.claude, or $CLAUDE_CONFIG_DIR when set. */
export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function settingsPath(scope: InstallScope, opts: { projectDir?: string; claudeDir?: string }): string {
  if (scope === 'project') {
    if (!opts.projectDir) throw new Error('project scope needs a project directory');
    return join(opts.projectDir, '.claude', 'settings.json');
  }
  return join(opts.claudeDir ?? claudeDir(), 'settings.json');
}

type Json = Record<string, unknown>;
interface HookEntry {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: unknown;
  hooks?: HookEntry[];
  [k: string]: unknown;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads settings.json; {} when missing; throws on invalid JSON (never overwrite a file we cannot parse). */
export function readSettings(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!isObj(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

/** Writes only when the content changed; keeps the file mode and leaves `<file>.ai-obs.bak` as a one-step undo. */
function writeSettings(path: string, settings: Json, before: string | null, newFileMode = 0o600): void {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  if (text === before) return;
  let mode = newFileMode;
  if (before !== null) {
    mode = statSync(path).mode & 0o777;
    copyFileSync(path, `${path}.ai-obs.bak`);
  }
  writeFileAtomic(path, text, mode);
}

const entryIsOurs = (h: HookEntry) => isAiObsHookCommand(typeof h.command === 'string' ? h.command : null) || (Array.isArray(h.args) && isAiObsHookCommand([String(h.command ?? ''), ...h.args.map(String)]));

/** Removes our entries from one event's groups; drops groups that only held our entries. */
function withoutOurs(groups: unknown): HookGroup[] {
  if (!Array.isArray(groups)) return [];
  const out: HookGroup[] = [];
  for (const g of groups) {
    if (!isObj(g)) {
      out.push(g as HookGroup);
      continue;
    }
    const hooks = Array.isArray(g.hooks) ? (g.hooks as HookEntry[]) : null;
    if (!hooks) {
      out.push(g as HookGroup);
      continue;
    }
    const kept = hooks.filter((h) => !(isObj(h) && entryIsOurs(h)));
    if (kept.length === hooks.length) out.push(g as HookGroup);
    else if (kept.length) out.push({ ...g, hooks: kept });
  }
  return out;
}

/**
 * Writes (or refreshes) our hook entries for every event. Idempotent. `newFileMode`: 0600 for the
 * user file, 0644 for a project file (meant to be shared).
 */
export function installHooksAt(path: string, hookCommand: (hookName: string) => HookCommand, newFileMode = 0o600): void {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const settings = readSettings(path);
  const hooks: Json = isObj(settings.hooks) ? { ...settings.hooks } : {};
  for (const event of HOOK_EVENTS) {
    const groups = withoutOurs(hooks[event]);
    groups.push({ hooks: [{ type: 'command', command: hookCommand(event).shell }] });
    hooks[event] = groups;
  }
  settings.hooks = hooks;
  writeSettings(path, settings, before, newFileMode);
}

/** Removes only our entries; leaves the file untouched when there are none. */
export function uninstallHooksAt(path: string): void {
  if (!existsSync(path)) return;
  const before = readFileSync(path, 'utf8');
  const settings = readSettings(path);
  if (!isObj(settings.hooks)) return;
  const hooks: Json = { ...settings.hooks };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = withoutOurs(groups);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  writeSettings(path, settings, before);
}

/** True when every event has our hook. */
export function hooksInstalledAt(path: string): boolean {
  let settings: Json;
  try {
    settings = readSettings(path);
  } catch {
    return false;
  }
  const hooks = isObj(settings.hooks) ? settings.hooks : {};
  return HOOK_EVENTS.every((event) => {
    const groups = hooks[event];
    return Array.isArray(groups) && groups.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isObj(h) && entryIsOurs(h)));
  });
}

/** `disableAllHooks: true` turns every hook off. */
export function hooksDisabledAt(path: string): boolean {
  try {
    return readSettings(path).disableAllHooks === true;
  } catch {
    return false;
  }
}

/** Shell commands of our hook entries in this settings file (empty when missing or unreadable). */
export function ourCommandsAt(path: string): string[] {
  try {
    const hooks = readSettings(path).hooks;
    if (!isObj(hooks)) return [];
    const out: string[] = [];
    for (const groups of Object.values(hooks)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of isObj(g) && Array.isArray(g.hooks) ? (g.hooks as HookEntry[]) : []) {
          if (isObj(h) && entryIsOurs(h)) out.push(Array.isArray(h.args) ? [String(h.command ?? ''), ...h.args.map(String)].join(' ') : String(h.command));
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}
