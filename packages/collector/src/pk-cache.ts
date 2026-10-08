import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { AiObsPaths } from './paths.js';

/** Entries kept in state/project-keys.json (least recently resolved dropped first). */
export const PK_CACHE_MAX = 500;
/** A cache hit younger than this is not rewritten (the worker resolves on every job). */
const REFRESH_MS = 60_000;

/**
 * cwd → plain project key, when it was last resolved (ms) and the repository stamp at that time
 * (repoStamp). Local only, never sent.
 */
export type PkCache = Record<string, { pk: string; at: number; stamp?: string }>;

type Paths = Pick<AiObsPaths, 'projectKeyCache'>;

/** The cache; empty when missing or unreadable. Never throws. */
export function readPkCache(paths: Paths): PkCache {
  const raw = readJsonFile<unknown>(paths.projectKeyCache);
  const out: PkCache = Object.create(null) as PkCache;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [cwd, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as { pk?: unknown; at?: unknown; stamp?: unknown } | null;
    if (e && typeof e.pk === 'string' && e.pk && typeof e.at === 'number' && Number.isFinite(e.at)) {
      out[cwd] = { pk: e.pk, at: e.at, ...(typeof e.stamp === 'string' ? { stamp: e.stamp } : {}) };
    }
  }
  return out;
}

/** Records a resolution (LRU, 0600, atomic). Never throws: the cache is an optimisation only. */
export function rememberPk(paths: Paths, cwd: string, pk: string, now: number = Date.now()): void {
  try {
    const cache = readPkCache(paths);
    const hit = cache[cwd];
    const stamp = repoStamp(cwd);
    if (hit && hit.pk === pk && hit.stamp === stamp && now - hit.at >= 0 && now - hit.at < REFRESH_MS) return;
    cache[cwd] = { pk, at: now, stamp };
    const kept = Object.entries(cache)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, PK_CACHE_MAX);
    writeJsonAtomic(paths.projectKeyCache, Object.fromEntries(kept), 0o600);
  } catch {
    /* read-only home */
  }
}

/** Distinct keys resolved at or after `sinceMs` (a timestamp), most recent first. */
export function recentKeys(paths: Paths, sinceMs: number): string[] {
  const seen = new Set<string>();
  for (const [, e] of Object.entries(readPkCache(paths)).sort((a, b) => b[1].at - a[1].at)) {
    if (e.at >= sinceMs) seen.add(e.pk);
  }
  return [...seen];
}

/**
 * The cached key of `cwd` when it still describes the same repository: the entry's stamp equals the
 * current repoStamp (no re-clone, no `git remote set-url`, no `git init` since). Null otherwise: the
 * caller resolves again (the hook trusts nothing older, §4.2).
 */
export function cachedPk(cache: PkCache, cwd: string): string | null {
  const hit = cache[cwd];
  return hit?.stamp !== undefined && hit.stamp !== 'unknown' && hit.stamp === repoStamp(cwd) ? hit.pk : null;
}

/**
 * What identifies the repository a directory belongs to, from a few `stat`s and no git: the git config
 * file that holds its remotes (path, mtime, inode), found by walking up to the nearest `.git` (a linked
 * worktree's `.git` file is followed to the common directory); `none` outside a repository. Any change
 * of the remote rewrites that file, a re-clone replaces it. Never throws.
 */
export function repoStamp(cwd: string): string {
  try {
    let dir = resolve(cwd);
    for (let depth = 0; depth < 128; depth++) {
      const dotgit = join(dir, '.git');
      let st: ReturnType<typeof statSync> | null = null;
      try {
        st = statSync(dotgit);
      } catch {
        st = null;
      }
      if (st) {
        let gitdir = dotgit;
        if (!st.isDirectory()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'));
          if (!m?.[1]) return `file:${dotgit}:${st.mtimeMs}:${st.ino}`;
          gitdir = resolve(dir, m[1].trim());
          try {
            gitdir = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim());
          } catch {
            /* a submodule or a plain gitdir file: its own config */
          }
        }
        const cfg = join(gitdir, 'config');
        try {
          const c = statSync(cfg);
          return `${cfg}:${c.mtimeMs}:${c.ino}`;
        } catch {
          return `${cfg}:missing`;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return 'unknown';
  }
  return 'none';
}
