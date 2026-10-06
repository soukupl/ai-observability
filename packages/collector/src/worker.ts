import { readFileSync, renameSync, rmSync } from 'node:fs';
import { ADAPTERS, getAdapter } from './adapters/index.js';
import type { CollectorContext, HarnessAdapter } from './adapters/types.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { errorMessage } from './fsutil.js';
import type { Transport } from './http.js';
import { listCrashedJobs, listJobs, toInvocation, type JobFile } from './jobs.js';
import { tryLock } from './lock.js';
import { createLogger, type Logger } from './log.js';
import type { AiObsPaths } from './paths.js';
import type { ProjectKeySecrets } from './project-key.js';
import type { CollectorConfigResponse, ProjectNamingMode, ProjectRef } from './protocol-types.js';
import { EventQueue } from './queue.js';
import { flushQueue, getCollectorConfig, type FlushResult } from './sender.js';

/** Upper bound for one job (summaries alone may take 120 s). */
export const JOB_TIMEOUT_MS = 5 * 60_000;
/** A worker lock older than this is considered abandoned. */
const LOCK_STALE_MS = 15 * 60_000;

export interface WorkerDeps {
  paths: AiObsPaths;
  adapters?: readonly HarnessAdapter[];
  transport?: Transport;
  log?: Logger;
  now?: () => Date;
  /** send the queue after processing (default true) */
  flush?: boolean;
  resolveProject?: (cwd: string, naming: ProjectNamingMode, secrets?: ProjectKeySecrets) => Promise<ProjectRef>;
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

/**
 * The detached worker (spawned by the hook fast path). Holds ~/.ai-obs/worker.lock, so exactly one
 * worker processes jobs at a time, in hook order; a worker that finds the lock taken exits, because
 * the holder re-scans the jobs dir after releasing. Never throws.
 */
export async function runWorker(deps: WorkerDeps): Promise<WorkerResult> {
  const log = deps.log ?? createLogger(deps.paths, 'worker');
  const adapters = deps.adapters ?? ADAPTERS;
  const result: WorkerResult = { ran: false, jobs: 0, failed: 0 };
  const config = loadConfig(deps.paths);
  if (!config) {
    for (const j of listJobs(deps.paths.jobs)) rmSync(j, { force: true });
    return result;
  }

  for (;;) {
    const release = tryLock(deps.paths.workerLock, LOCK_STALE_MS);
    if (!release) return result;
    result.ran = true;
    try {
      for (const crashed of listCrashedJobs(deps.paths.jobs)) {
        log.warn('worker: dropping a job a previous worker crashed on');
        rmSync(crashed, { force: true });
      }
      const queue = new EventQueue(deps.paths.queue, { log });
      let serverConfig: CollectorConfigResponse | null = null;
      const contexts = new Map<string, CollectorContext>();

      for (let jobs = listJobs(deps.paths.jobs); jobs.length; jobs = listJobs(deps.paths.jobs)) {
        serverConfig ??= (await getCollectorConfig({ config, paths: deps.paths, log, transport: deps.transport })).value;
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
                queue,
                log,
                projectNaming: serverConfig.project_naming,
                projectSalt: serverConfig.project_salt ?? null,
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
      if (deps.flush !== false) {
        result.flush = await flushQueue(queue, { config, paths: deps.paths, log, transport: deps.transport });
      }
    } catch (err) {
      log.error('worker: failed', { error: errorMessage(err) });
    } finally {
      release();
    }
    // A hook may have written a job after our last scan but before release; it saw the lock taken.
    if (!listJobs(deps.paths.jobs).length) return result;
  }
}
