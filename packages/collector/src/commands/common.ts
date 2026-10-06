import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { HarnessAdapter } from '../adapters/types.js';
import type { Transport } from '../http.js';
import type { AiObsPaths } from '../paths.js';
import type { RuntimeInstall } from '../runtime.js';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Injectable dependencies (tests); production uses the defaults. */
export interface CliDeps {
  paths: AiObsPaths;
  adapters?: readonly HarnessAdapter[];
  transport?: Transport;
  installRuntime?: (paths: AiObsPaths) => RuntimeInstall;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export class UsageError extends Error {}

type Options = NonNullable<ParseArgsConfig['options']>;

/** Strict option parsing; unknown flags or missing values throw UsageError. */
export function parseOptions<O extends Options>(args: readonly string[], options: O, allowPositionals = false) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return 'unknown';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
