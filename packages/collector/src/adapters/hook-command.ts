import { accessSync, constants, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { HookCommand } from './types.js';

/** Marker present in every hook command we install; adapters use it to find our entries. */
export const HOOK_MARKER = 'ai-obs';

/** POSIX single-quote when needed. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds `hookCommand(hookName)` for InstallOptions. `entry` is the installed bin script
 * (~/.ai-obs/app/bin/ai-obs.js); `home` is appended as `--home` only when non-default.
 */
export function hookCommandFactory(input: { node: string; entry: string; harness: string; home?: string }) {
  return (hookName: string): HookCommand => {
    const argv = [input.node, input.entry, 'hook', input.harness, hookName, ...(input.home ? ['--home', input.home] : [])];
    return { argv, shell: argv.map(shellQuote).join(' ') };
  };
}

/** True for a hook command written by `ai-obs init` (any harness). */
export function isAiObsHookCommand(command: string | readonly string[] | undefined | null): boolean {
  if (!command) return false;
  const s = typeof command === 'string' ? command : command.join(' ');
  return /ai-obs/.test(s) && /\bhook\b/.test(s);
}

/** Splits a POSIX-shell command (single / double quotes, backslash) into words. Not a full shell. */
export function parseShellWords(command: string): string[] {
  const words: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < command.length) cur += command[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < command.length) {
      cur += command[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started || cur) words.push(cur);
      cur = '';
      started = false;
    } else cur += c;
  }
  if (started || cur) words.push(cur);
  return words;
}

/**
 * What is wrong with the runtime baked into an installed hook command (`<node> <entry> hook …`):
 * the absolute node binary or the entry script is gone (e.g. an nvm Node version was removed, or
 * `~/.ai-obs` was deleted). Hooks then fail without the harness telling anyone. A bare `node` is
 * resolved through PATH at run time and is not checked.
 */
export function hookRuntimeProblems(command: string): string[] {
  const [node, entry] = parseShellWords(command);
  const out: string[] = [];
  if (node && isAbsolute(node)) {
    try {
      accessSync(node, constants.X_OK);
    } catch {
      out.push(`node binary ${node} is missing or not executable`);
    }
  }
  if (entry && isAbsolute(entry) && !existsSync(entry)) out.push(`collector script ${entry} is missing`);
  return out;
}

/** Node installs that live in a per-version directory and disappear when that version is removed. */
export function isVersionManagedNode(path: string): boolean {
  return /[\\/](\.nvm|\.fnm|fnm_multishells|\.volta|\.asdf|\.nodenv|\.nvs|n[\\/]versions|nvm[\\/]versions)[\\/]/.test(path) || /[\\/]node[\\/]v?\d+\.\d+\.\d+[\\/]/.test(path);
}
