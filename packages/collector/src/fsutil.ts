import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** mkdir -p with owner-only permissions. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Writes via a temp file + rename so readers never see a partial file. Mode defaults to 0600. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/** Reads and parses a JSON file; null when missing or unparsable (never throws). */
export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Rejects when `p` has not settled after `ms` (it is not cancelled: it keeps running in the background). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      timer.unref?.();
    }),
  ]);
}
