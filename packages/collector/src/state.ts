import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';

/** File-safe form of a session id. */
export function safeName(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  return s && s !== '.' && s !== '..' ? s : '_';
}

/**
 * Per-session JSON state for one harness: ~/.ai-obs/state/<harness>/<session>.json (mode 0600).
 * Adapters keep transcript cursors, open-turn data and provisional outcomes here. Values must stay
 * local-only data; writes are atomic.
 */
export class SessionStateStore {
  constructor(readonly dir: string) {}

  path(sessionId: string): string {
    return join(this.dir, `${safeName(sessionId)}.json`);
  }

  get<T>(sessionId: string): T | null {
    return readJsonFile<T>(this.path(sessionId));
  }

  set<T>(sessionId: string, value: T): void {
    writeJsonAtomic(this.path(sessionId), value);
  }

  /** Read-modify-write; `fn` receives null for a new session. */
  update<T>(sessionId: string, fn: (prev: T | null) => T): T {
    const next = fn(this.get<T>(sessionId));
    this.set(sessionId, next);
    return next;
  }

  delete(sessionId: string): void {
    rmSync(this.path(sessionId), { force: true });
  }

  /** Stored sessions with their last write time (epoch ms), oldest first. */
  list(): Array<{ sessionId: string; updatedAt: number }> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .flatMap((n) => {
        try {
          return [{ sessionId: n.slice(0, -5), updatedAt: statSync(join(this.dir, n)).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }
}
