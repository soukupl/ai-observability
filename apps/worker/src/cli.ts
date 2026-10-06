import type { Job, Logger } from './scheduler.js';
import { healthLine } from './scheduler.js';

/**
 * Which job to run once and exit, from `--once <job>` / `--once=<job>` / `once <job>` or RUN_ONCE=<job>.
 * Returns undefined for normal (scheduler) mode.
 */
export function parseRunOnce(argv: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--once=')) return a.slice('--once='.length) || undefined;
    if ((a === '--once' || a === 'once') && argv[i + 1]) return argv[i + 1];
  }
  return env.RUN_ONCE?.trim() || undefined;
}

/** Runs one job and returns the process exit code (0 ok, 1 job failed, 2 unknown job). Never throws. */
export async function runOnce(name: string, jobs: Job[], log: Logger): Promise<number> {
  const job = jobs.find((j) => j.name === name);
  if (!job) {
    log.error(`unknown job "${name}", expected one of: ${jobs.map((j) => j.name).join(', ')}`);
    return 2;
  }
  const started = Date.now();
  try {
    const detail = await job.run(new AbortController().signal, { force: true });
    log.info(healthLine(job.name, 'ok', Date.now() - started, detail));
    return 0;
  } catch (err) {
    log.error(healthLine(job.name, 'error', Date.now() - started), err);
    return 1;
  }
}
