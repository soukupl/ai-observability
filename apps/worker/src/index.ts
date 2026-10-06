import { closeAllDbs, dbFor } from '@ai-obs/db';
import { parseRunOnce, runOnce } from './cli.js';
import type { WorkerContext } from './context.js';
import { createBudgetsJob } from './jobs/budgets.js';
import { createRetentionJob } from './jobs/retention.js';
import { createRollupsJob } from './jobs/rollups.js';
import { loadConfig } from './lib/config.js';
import { createSmtpMailer } from './lib/mailer.js';
import { fileStateStore } from './lib/state.js';
import { startScheduler, type Logger } from './scheduler.js';

const log: Logger = {
  info: (msg) => console.log(`[worker] ${msg}`),
  error: (msg, err) => (err === undefined ? console.error(`[worker] ${msg}`) : console.error(`[worker] ${msg}`, err)),
};

// A bug in one job must never take the worker down.
process.on('unhandledRejection', (err) => log.error('unhandled rejection', err));
process.on('uncaughtException', (err) => log.error('uncaught exception', err));

const config = loadConfig();
const ctx: WorkerContext = {
  db: dbFor('worker'),
  state: fileStateStore(config.stateDir, (msg, err) => log.error(msg, err)),
  config,
  log,
  mailer: createSmtpMailer(config.smtp),
  now: () => new Date(),
};
const jobs = [createRollupsJob(ctx), createBudgetsJob(ctx), createRetentionJob(ctx)];

const once = parseRunOnce(process.argv.slice(2));
if (once) {
  const code = await runOnce(once, jobs, log);
  await closeAllDbs().catch(() => {});
  process.exit(code);
}

const scheduler = startScheduler(jobs, log);
log.info(`started jobs=${jobs.map((j) => j.name).join(',')} stateDir=${config.stateDir}`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} received, waiting for running jobs`);
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  await scheduler.stop();
  await closeAllDbs().catch(() => {});
  log.info('stopped');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
