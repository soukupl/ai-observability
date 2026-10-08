import { readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS, getAdapter } from './adapters/index.js';
import type { CollectorContext, HarnessAdapter } from './adapters/types.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { recordDropped } from './delivery.js';
import { errorMessage } from './fsutil.js';
import type { Transport } from './http.js';
import { listCrashedJobs, listJobs, toInvocation, type JobFile } from './jobs.js';
import { tryLock } from './lock.js';
import { createLogger, type Logger } from './log.js';
import type { AiObsPaths } from './paths.js';
import { loadRouting } from './projects.js';
import { QueueStore } from './queue.js';
import { flushQueue, type FlushResult } from './sender.js';

/** Upper bound for one job (summaries alone may take 120 s). */
export const JOB_TIMEOUT_MS = 5 * 60_000;
/** A worker lock older than this is considered abandoned. */
const LOCK_STALE_MS = 15 * 60_000;
/** Extra loops when config.json / projects.json changed during a flush (C17). */
const MAX_REPLAN_LOOPS = 5;
/** SessionStart nudge markers older than this are deleted. */
const NUDGED_KEEP_MS = 7 * 24 * 3600_000;

export interface WorkerDeps {
  paths: AiObsPaths;
  adapters?: readonly HarnessAdapter[];
  transport?: Transport;
  log?: Logger;
  now?: () => Date;
  /** send the queue after processing (default true) */
  flush?: boolean;
  /** override project-key resolution (tests): the plain key of a cwd, null when git timed out */
  resolveProject?: (cwd: string) => Promise<string | null>;
}

export interface WorkerResult {
  /** false when another worker held the lock (it will pick up our job) */
  ran: boolean;
  jobs: number;
  failed: number;
  flush?: FlushResult;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      timer.unref?.();
    }),
  ]);
}

/** mtimes of the routing inputs the user changes (config.json, projects.json); a change during a flush means "run again". */
function routingStamp(paths: AiObsPaths): string {
  return [paths.config, paths.projects]
    .map((f) => {
      try {
        const st = statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

/** Deletes SessionStart nudge markers older than 7 days. */
function sweepNudged(paths: AiObsPaths, now: number): void {
  let names: string[];
  try {
    names = readdirSync(paths.nudged);
  } catch {
    return;
  }
  for (const n of names) {
    const f = join(paths.nudged, n);
    try {
      if (now - statSync(f).mtimeMs > NUDGED_KEEP_MS) rmSync(f, { force: true });
    } catch {
      /* vanished */
    }
  }
}

/** No config, or no valid token: nothing is recorded (C6). */
function dropJobs(paths: AiObsPaths): void {
  for (const j of listJobs(paths.jobs)) rmSync(j, { force: true });
}

/**
 * The detached worker (spawned by the hook fast path). Holds ~/.ai-obs/worker.lock, so exactly one
 * worker processes jobs at a time, in hook order; a worker that finds the lock taken exits, because
 * the holder re-scans the jobs dir after releasing. Config is re-read every loop; without a token
 * jobs are dropped (C6). Events go to per-project streams (design §3.1) and are flushed per token
 * (§5.3); when config.json / projects.json changed during the flush, it runs again (C17). Never throws.
 */
export async function runWorker(deps: WorkerDeps): Promise<WorkerResult> {
  const log = deps.log ?? createLogger(deps.paths, 'worker');
  const adapters = deps.adapters ?? ADAPTERS;
  const result: WorkerResult = { ran: false, jobs: 0, failed: 0 };
  const first = loadConfig(deps.paths);
  if (!first || !first.tokens.length) {
    dropJobs(deps.paths);
    return result;
  }

  let replans = 0;
  for (;;) {
    const release = tryLock(deps.paths.workerLock, LOCK_STALE_MS);
    if (!release) return result;
    result.ran = true;
    let again = false;
    try {
      const config = loadConfig(deps.paths);
      if (!config || !config.tokens.length) {
        dropJobs(deps.paths);
        return result;
      }
      for (const crashed of listCrashedJobs(deps.paths.jobs)) {
        log.warn('worker: dropping a job a previous worker crashed on');
        rmSync(crashed, { force: true });
      }
      const store = new QueueStore(deps.paths.queue, {
        log,
        routing: () => loadRouting(deps.paths),
        dropped: (d) => recordDropped(deps.paths, d),
      });
      const contexts = new Map<string, CollectorContext>();

      for (let jobs = listJobs(deps.paths.jobs); jobs.length; jobs = listJobs(deps.paths.jobs)) {
        for (const file of jobs) {
          const processing = `${file}.processing`;
          try {
            renameSync(file, processing);
          } catch {
            continue; // taken by someone else / vanished
          }
          result.jobs++;
          try {
            const job = JSON.parse(readFileSync(processing, 'utf8')) as JobFile;
            const adapter = getAdapter(job.harness, adapters);
            if (!adapter) throw new Error(`no adapter for harness "${job.harness}"`);
            let ctx = contexts.get(adapter.name);
            if (!ctx) {
              ctx = createContext({
                adapter,
                config,
                paths: deps.paths,
                queue: store,
                log,
                ...(deps.now ? { now: deps.now } : {}),
                ...(deps.resolveProject ? { resolveProject: deps.resolveProject } : {}),
              });
              contexts.set(adapter.name, ctx);
            }
            await withTimeout(adapter.handleHook(toInvocation(job), ctx), JOB_TIMEOUT_MS, `${adapter.name} ${job.hook}`);
            if (adapter.sessionStartHooks.includes(job.hook)) {
              await withTimeout(adapter.sweepCrashedSessions(ctx), JOB_TIMEOUT_MS, `${adapter.name} sweep`);
            }
          } catch (err) {
            result.failed++;
            log.error('worker: job failed', { error: errorMessage(err).slice(0, 300) });
          } finally {
            rmSync(processing, { force: true });
          }
        }
      }
      sweepNudged(deps.paths, (deps.now?.() ?? new Date()).getTime());
      if (deps.flush !== false) {
        const stamp = routingStamp(deps.paths);
        result.flush = await flushQueue(store, {
          paths: deps.paths,
          log,
          ...(deps.transport ? { transport: deps.transport } : {}),
          ...(deps.resolveProject ? { resolveProjectKey: (cwd: string) => deps.resolveProject!(cwd) } : {}),
        });
        if (routingStamp(deps.paths) !== stamp && replans < MAX_REPLAN_LOOPS) {
          replans++;
          again = true;
        }
      }
    } catch (err) {
      log.error('worker: failed', { error: errorMessage(err) });
    } finally {
      release();
    }
    // A hook may have written a job after our last scan but before release; it saw the lock taken.
    if (!again && !listJobs(deps.paths.jobs).length) return result;
  }
}
