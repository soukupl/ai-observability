import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HookInvocation } from './adapters/types.js';
import { writeFileAtomic } from './fsutil.js';
import type { HarnessName } from './protocol-types.js';
import { ulid } from './ulid.js';

/**
 * On-disk job written by the hook fast path and consumed by the worker (local only, mode 0600).
 * `v: 1` = `<ulid>.json` written by the 0.1.x hook; `v: 2` = `<ulid>.v2.json` (C25). Same fields.
 */
export interface JobFile {
  v: 1 | 2;
  harness: HarnessName;
  hook: string;
  payload: unknown;
  cwd: string;
  env: Record<string, string>;
  received_at: string;
}

/**
 * Job file names: `<ulid>.json` (0.1.x hook) and `<ulid>.v2.json` (this hook). A 0.1.x worker still
 * running after `init` matches only `<ulid>.json`, so it never processes a post-upgrade job (C25).
 */
export const JOB_RE = /^[0-9A-HJKMNP-TV-Z]{26}(\.v2)?\.json$/;

/** Writes a v2 job atomically (temp + rename) so the worker never sees a partial file. Returns its path. */
export function writeJob(jobsDir: string, job: Omit<JobFile, 'v'> & { v?: JobFile['v'] }, now = Date.now()): string {
  const file = join(jobsDir, `${ulid(now)}.v2.json`);
  writeFileAtomic(file, JSON.stringify({ ...job, v: 2 }));
  return file;
}

/** Pending job files of both versions, oldest first (names start with ULIDs; `.json` sorts before `.v2.json` within one ms). */
export function listJobs(jobsDir: string): string[] {
  try {
    return readdirSync(jobsDir)
      .filter((n) => JOB_RE.test(n))
      .sort()
      .map((n) => join(jobsDir, n));
  } catch {
    return [];
  }
}

/** Jobs a previous worker crashed on (renamed to *.json.processing before handling; both versions). */
export function listCrashedJobs(jobsDir: string): string[] {
  try {
    return readdirSync(jobsDir)
      .filter((n) => n.endsWith('.json.processing'))
      .map((n) => join(jobsDir, n));
  } catch {
    return [];
  }
}

export function toInvocation(job: JobFile): HookInvocation {
  return { harness: job.harness, hook: job.hook, payload: job.payload, cwd: job.cwd, env: job.env, receivedAt: job.received_at };
}

const ENV_ALLOW = /^(CLAUDE|CODEX|AI_OBS)_/;
const ENV_SECRET = /TOKEN|KEY|SECRET|PASSW|AUTH|CREDENTIAL|COOKIE|SESSION_ID_SECRET/i;

/** Harness-related env vars only; anything that looks like a secret is dropped. */
export function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && ENV_ALLOW.test(k) && !ENV_SECRET.test(k)) out[k] = v.slice(0, 4096);
  }
  return out;
}
