import type { HarnessName } from '../protocol-types.js';
import { adapter as claudeCode } from './claude-code/index.js';
import { adapter as codex } from './codex/index.js';
import type { HarnessAdapter } from './types.js';

/** Adapter registry. A new harness = a new adapter module + one line here. */
export const ADAPTERS: readonly HarnessAdapter[] = [claudeCode, codex];

export const HARNESS_NAMES: readonly HarnessName[] = ['claude-code', 'codex'];

export function isHarnessName(s: string | undefined): s is HarnessName {
  return HARNESS_NAMES.includes(s as HarnessName);
}

export function getAdapter(name: string, adapters: readonly HarnessAdapter[] = ADAPTERS): HarnessAdapter | undefined {
  return adapters.find((a) => a.name === name);
}

export type { HarnessAdapter } from './types.js';
