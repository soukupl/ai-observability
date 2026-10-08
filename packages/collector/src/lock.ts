import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './fsutil.js';

export type Release = () => void;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(path: string, staleMs: number): boolean {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    const pid = Number.parseInt(readFileSync(path, 'utf8').split(' ')[0] ?? '', 10);
    if (Number.isFinite(pid) && pid > 0 && !isAlive(pid)) return true;
    return age > staleMs;
  } catch {
    return false;
  }
}

/**
 * Exclusive lock file (O_EXCL). Returns a release function, or null when another live process holds
 * it. A lock whose owner is dead, or that was not refreshed for `staleMs`, is taken over. The holder
 * refreshes the lock's mtime while it holds it (heartbeat), so a long run (summaries, a large backlog)
 * is never taken over by age while its process lives (C24). Release removes the file only while it is
 * still this holder's.
 */
export function tryLock(path: string, staleMs = 10 * 60_000): Release | null {
  ensureDir(dirname(path));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      const stamp = `${process.pid} ${new Date().toISOString()} ${randomBytes(6).toString('hex')}`;
      writeSync(fd, stamp);
      closeSync(fd);
      const owned = (): boolean => {
        try {
          return readFileSync(path, 'utf8') === stamp;
        } catch {
          return false;
        }
      };
      const beat = setInterval(
        () => {
          if (!owned()) return;
          try {
            const t = new Date();
            utimesSync(path, t, t);
          } catch {
            /* removed meanwhile */
          }
        },
        Math.max(1000, Math.min(60_000, Math.floor(staleMs / 4))),
      );
      beat.unref();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        if (owned()) rmSync(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt === 0 && isStale(path, staleMs)) {
        rmSync(path, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Polls for the lock up to `waitMs`. */
export async function acquireLock(path: string, waitMs: number, staleMs?: number): Promise<Release | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = tryLock(path, staleMs);
    if (release || Date.now() >= deadline) return release;
    await new Promise((r) => setTimeout(r, 100));
  }
}
