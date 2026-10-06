import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Codex home: $CODEX_HOME (from the hook env or the process), else ~/.codex. */
export function codexHome(env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

/** hooks.json for a scope: user = <codex home>/hooks.json, project = <repo>/.codex/hooks.json. */
export function hooksFilePath(scope: 'user' | 'project', opts: { projectDir?: string; home?: string } = {}): string {
  if (scope === 'project') {
    if (!opts.projectDir) throw new Error('project scope needs a project directory');
    return join(opts.projectDir, '.codex', 'hooks.json');
  }
  return join(opts.home ?? codexHome(), 'hooks.json');
}

/** Thread / session ids are UUIDs (v4 in old rollouts, v7 now). Anything else is never used in a path. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const listDesc = (dir: string, re: RegExp): string[] => {
  try {
    return readdirSync(dir).filter((n) => re.test(n)).sort().reverse();
  } catch {
    return [];
  }
};

/**
 * Finds the rollout JSONL of a thread. Order: the `transcript_path` / `agent_transcript_path` from
 * the hook payload (when it exists and names this thread), then a newest-first scan of
 * <home>/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl, then <home>/archived_sessions/.
 */
export function locateRollout(sessionId: string, opts: { home: string; hint?: string | null }): string | null {
  if (opts.hint && isFile(opts.hint) && (!SESSION_ID_RE.test(sessionId) || opts.hint.includes(sessionId))) return opts.hint;
  if (!SESSION_ID_RE.test(sessionId)) return opts.hint && isFile(opts.hint) ? opts.hint : null;
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  const sessions = join(opts.home, 'sessions');
  for (const y of listDesc(sessions, /^\d{4}$/)) {
    for (const m of listDesc(join(sessions, y), /^\d{2}$/)) {
      for (const d of listDesc(join(sessions, y, m), /^\d{2}$/)) {
        const dir = join(sessions, y, m, d);
        const hit = listDesc(dir, /^rollout-.*\.jsonl$/).find((n) => n.toLowerCase().endsWith(suffix));
        if (hit) return join(dir, hit);
      }
    }
  }
  const archived = join(opts.home, 'archived_sessions');
  const hit = existsSync(archived) ? listDesc(archived, /^rollout-.*\.jsonl$/).find((n) => n.toLowerCase().endsWith(suffix)) : undefined;
  return hit ? join(archived, hit) : null;
}

/** Last modification time (epoch ms) of a file, 0 when missing. */
export function mtimeMs(path: string | null | undefined): number {
  if (!path) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
