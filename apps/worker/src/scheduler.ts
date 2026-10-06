export interface Job {
  name: string;
  intervalMs: number;
  /** Also run once right after start (default true). */
  runOnStart?: boolean;
  /**
   * Returns an optional one-line summary for the health log (e.g. "days=3 rows=40").
   * `force` is set for RUN_ONCE: skip "already ran today" style guards.
   */
  run: (signal: AbortSignal, opts?: { force?: boolean }) => Promise<string | void>;
}

export interface Logger {
  info: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

export interface Scheduler {
  /** Stops scheduling, aborts the signal passed to running jobs and waits for them to finish. */
  stop: () => Promise<void>;
}

/** One greppable health line per job run: `job=rollups status=ok ms=123 days=3 rows=40`. */
export function healthLine(name: string, status: 'ok' | 'error', ms: number, detail?: string | void): string {
  return `job=${name} status=${status} ms=${ms}${detail ? ` ${detail}` : ''}`;
}

/**
 * Runs each job on its own interval. A job never overlaps with itself: a tick that fires while the
 * previous run is still in progress is skipped. Errors are logged and never stop the loop.
 */
export function startScheduler(jobs: Job[], log: Logger): Scheduler {
  const controller = new AbortController();
  const inFlight = new Map<string, Promise<void>>();
  const timers: NodeJS.Timeout[] = [];

  const tick = (job: Job) => {
    if (controller.signal.aborted || inFlight.has(job.name)) return;
    const started = Date.now();
    const p = job
      .run(controller.signal)
      .then(
        (detail) => log.info(healthLine(job.name, 'ok', Date.now() - started, detail)),
        (err: unknown) => log.error(healthLine(job.name, 'error', Date.now() - started), err),
      )
      .finally(() => inFlight.delete(job.name));
    inFlight.set(job.name, p);
  };

  for (const job of jobs) {
    timers.push(setInterval(() => tick(job), job.intervalMs));
    if (job.runOnStart ?? true) tick(job);
  }

  return {
    async stop() {
      timers.forEach(clearInterval);
      controller.abort();
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
