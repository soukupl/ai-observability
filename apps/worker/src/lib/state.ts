import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Tiny key/value store (JSON file) for worker bookkeeping: rollup watermark, last retention day. */
export interface StateStore {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
}

/**
 * File-backed store under `dir`. Never throws: when the directory is not writable it keeps the values in
 * memory (jobs are idempotent and self-healing, so losing state only costs a recompute).
 */
export function fileStateStore(dir: string, onError: (msg: string, err: unknown) => void = () => {}): StateStore {
  const file = join(dir, 'worker-state.json');
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    // missing or corrupt file: start empty
  }
  let warned = false;
  return {
    get: (key) => data[key],
    set(key, value) {
      data = { ...data, [key]: value };
      try {
        mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(data));
        renameSync(tmp, file);
      } catch (err) {
        if (!warned) onError(`state dir ${dir} is not writable, keeping state in memory`, err);
        warned = true;
      }
    },
  };
}

export function memoryStateStore(initial: Record<string, string> = {}): StateStore {
  const data = { ...initial };
  return { get: (k) => data[k], set: (k, v) => void (data[k] = v) };
}
