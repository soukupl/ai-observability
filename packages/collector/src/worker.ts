import { readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS, getAdapter } from './adapters/index.js';
import type { CollectorContext, HarnessAdapter } from './adapters/types.js';
import { listStagedDigests, runSummaryBatch, type SummaryGroup } from './analysis/summaries.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { recordDropped } from './delivery.js';
import { errorMessage, withTimeout } from './fsutil.js';
import type { Transport } from './http.js';
import { listCrashedJobs, listJobs, toInvocation, type JobFile } from './jobs.js';
import { tryLock, type Release } from './lock.js';
import { createLogger, type Logger } from './log.js';
import type { AiObsPaths } from './paths.js';
import { loadRouting } from './projects.js';
import { QueueStore } from './queue.js';
import { flushQueue, type FlushResult } from './sender.js';

/** Upper bound for one job; also (default) how long one harness's summary batch keeps starting new chunks. Jobs no longer summarise (ADR-0027). */
export const JOB_TIMEOUT_MS = 5 * 60_000;
/** How long the summary phase waits for worker.lock to queue and send its summaries. */
export const SUMMARY_COMMIT_WAIT_MS = 60_000;
/** Summary passes per worker run (each one is followed by the jobs written meanwhile). */
export const MAX_SUMMARY_PASSES = 3;
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
  /** run the summary phase after the flush (default true; ADR-0027) */
  summaries?: boolean;
  /** after this long one harness's summary batch starts no further chunk and commits what it has (default JOB_TIMEOUT_MS) */
  summaryTimeoutMs?: number;
  /** how long a summary commit waits for worker.lock (default SUMMARY_COMMIT_WAIT_MS) */
  summaryCommitWaitMs?: number;
}

export interface WorkerResult {
  /** false when another worker held the lock (it will pick up our job) */
  ran: boolean;
  jobs: number;
  failed: number;
  flush?: FlushResult;
  /** summary phase: turn summaries queued, and the flush that sent them */
  summaries?: { summarized: number; flush?: FlushResult };
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
 * (§5.3); when config.json / projects.json changed during the flush, it runs again (C17). Then the
 * summary phase summarises the staged digests and sends the summaries (ADR-0027). Never throws.
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

  await drainJobs(deps, adapters, log, result);

  // Summaries run after the flush, outside worker.lock, so a slow summary never delays the next hook's events (ADR-0027).
  if (deps.summaries === false) return result;
  try {
    for (let pass = 0; pass < MAX_SUMMARY_PASSES && adapters.some((a) => listStagedDigests(deps.paths.state, a.name).length); pass++) {
      const progress = await summarizeStaged(deps, adapters, log, result);
      // A hook that fired while a commit held worker.lock left its job to us (its worker saw the lock taken).
      if (listJobs(deps.paths.jobs).length) await drainJobs(deps, adapters, log, result);
      if (!progress) break;
    }
  } catch (err) {
    log.error('worker: summary phase failed', { error: errorMessage(err).slice(0, 300) });
  }
  return result;
}

/**
 * Processes every job under worker.lock, in hook order, then flushes the queue; runs again when a job
 * arrived meanwhile or the routing changed during the flush (C17). Returns at once when another worker
 * holds the lock (it re-scans the jobs dir after releasing).
 */
async function drainJobs(deps: WorkerDeps, adapters: readonly HarnessAdapter[], log: Logger, result: WorkerResult): Promise<void> {
  let replans = 0;
  for (;;) {
    const release = tryLock(deps.paths.workerLock, LOCK_STALE_MS);
    if (!release) return;
    result.ran = true;
    let again = false;
    try {
      const config = loadConfig(deps.paths);
      if (!config || !config.tokens.length) {
        dropJobs(deps.paths);
        return;
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
    if (!again && !listJobs(deps.paths.jobs).length) return;
  }
}

/** Polls for worker.lock like acquireLock(): null when it is still taken after `waitMs`. */
async function lockWithin(path: string, waitMs: number): Promise<Release | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = tryLock(path, LOCK_STALE_MS);
    if (release || Date.now() >= deadline) return release;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The summary phase (ADR-0027): under summaries.lock, summarises each harness's staged digests, then queues
 * and sends the summaries under worker.lock (waiting up to SUMMARY_COMMIT_WAIT_MS for it). Each chunk is bounded
 * (SUMMARY_CHUNK_TIMEOUT_MS, a failed attempt) and no chunk starts after summaryTimeoutMs, so a batch always ends
 * and commits its progress; the digests not tried yet wait in the pending file. A batch that cannot get
 * worker.lock changes nothing: its staged and pending files stay for the next run. False when there is no token,
 * another process holds summaries.lock (it summarises them), or a commit was refused (another pass would only run
 * the model again).
 */
async function summarizeStaged(deps: WorkerDeps, adapters: readonly HarnessAdapter[], log: Logger, result: WorkerResult): Promise<boolean> {
  const config = loadConfig(deps.paths);
  if (!config || !config.tokens.length) return false;
  const release = tryLock(deps.paths.summariesLock, LOCK_STALE_MS);
  if (!release) return false;
  let progress = true;
  try {
    for (const adapter of adapters) {
      if (!listStagedDigests(deps.paths.state, adapter.name).length) continue;
      const ctx = createContext({
        adapter,
        config,
        paths: deps.paths,
        queue: {
          enqueue() {
            throw new Error('summaries are queued through commit');
          },
        },
        log,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.resolveProject ? { resolveProject: deps.resolveProject } : {}),
      });
      const commit = async (groups: SummaryGroup[]): Promise<boolean> => {
        if (!groups.length) return true;
        const unlock = await lockWithin(deps.paths.workerLock, deps.summaryCommitWaitMs ?? SUMMARY_COMMIT_WAIT_MS);
        if (!unlock) {
          log.warn('worker: summaries kept for the next run (worker busy)', { harness: adapter.name });
          return false;
        }
        try {
          const store = new QueueStore(deps.paths.queue, {
            log,
            routing: () => loadRouting(deps.paths),
            dropped: (d) => recordDropped(deps.paths, d),
          });
          const done = (result.summaries ??= { summarized: 0 });
          for (const g of groups) {
            store.enqueue(g.events, g.key);
            done.summarized += g.events.length;
          }
          if (deps.flush !== false) {
            done.flush = await flushQueue(store, {
              paths: deps.paths,
              log,
              ...(deps.transport ? { transport: deps.transport } : {}),
              ...(deps.resolveProject ? { resolveProjectKey: (cwd: string) => deps.resolveProject!(cwd) } : {}),
            });
          }
          return true;
        } finally {
          unlock();
        }
      };
      try {
        const deadline = Date.now() + (deps.summaryTimeoutMs ?? JOB_TIMEOUT_MS);
        if (!(await runSummaryBatch(adapter, ctx, { commit, deadline }))) progress = false;
      } catch (err) {
        progress = false;
        log.error('worker: summaries failed', { harness: adapter.name, error: errorMessage(err).slice(0, 300) });
      }
    }
  } finally {
    release();
  }
  return progress;
}
