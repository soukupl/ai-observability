import { ADAPTERS } from '../adapters/index.js';
import { pendingSummariesPath, summarizeAndQueue } from '../analysis/summaries.js';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { errorMessage, readJsonFile } from '../fsutil.js';
import { acquireLock } from '../lock.js';
import { createLogger } from '../log.js';
import { EventQueue } from '../queue.js';
import { flushQueue, getCollectorConfig } from '../sender.js';
import { parseOptions, type CliDeps, type Io } from './common.js';

/**
 * `ai-obs flush` — finish what is waiting, then send the queue now, ignoring the retry backoff.
 * Before sending it runs each adapter's idle-session sweep (Codex ends sessions idle for 1 h, Claude
 * Code ones silent for 24 h) and retries pending summaries, so data does not wait for the next hook.
 */
export async function flushCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, { wait: { type: 'string', default: '30' } });
  const config = loadConfig(deps.paths, deps.env ?? process.env);
  if (!config) {
    io.err('not configured — run `ai-obs init --token … --endpoint …`');
    return 1;
  }
  const release = await acquireLock(deps.paths.workerLock, Number(values.wait) * 1000, 15 * 60_000);
  if (!release) {
    io.out('the background worker is busy (e.g. summarizing); it flushes when done');
    return 0;
  }
  try {
    const log = createLogger(deps.paths, 'flush');
    const queue = new EventQueue(deps.paths.queue, { log });
    const transport = deps.transport;

    const serverConfig = (await getCollectorConfig({ config, paths: deps.paths, log, transport })).value;
    for (const adapter of deps.adapters ?? ADAPTERS) {
      const ctx = createContext({ adapter, config, paths: deps.paths, queue, log, projectNaming: serverConfig.project_naming, projectSalt: serverConfig.project_salt ?? null });
      try {
        const before = queue.stats().events;
        await adapter.sweepCrashedSessions(ctx);
        const swept = queue.stats().events - before;
        if (swept > 0) io.out(`${adapter.displayName}: idle-session sweep queued ${swept} events`);
        const waiting = (readJsonFile<unknown[]>(pendingSummariesPath(deps.paths.state, adapter.name)) ?? []).length;
        if (waiting) {
          const r = await summarizeAndQueue(adapter, [], ctx);
          io.out(`${adapter.displayName}: summaries ${r.summarized} of ${waiting} done, ${r.pending} still waiting`);
        }
      } catch (err) {
        log.warn('flush: sweep / summaries failed', { harness: adapter.name, error: errorMessage(err).slice(0, 200) });
      }
    }

    const r = await flushQueue(queue, { config, paths: deps.paths, log, transport }, { force: true, maxBatches: 1000 });
    const left = queue.stats().events;
    if (r.status === 'empty') io.out('queue is empty');
    else if (r.status === 'ok') io.out(`sent ${r.sent} events in ${r.batches} batch(es): accepted ${r.accepted}, duplicates ${r.duplicates}, rejected ${r.rejected}; ${left} left`);
    else io.err(`✗ ${r.status === 'auth_error' ? 'token rejected' : 'send failed'}: ${r.error}; ${left} events stay queued${r.sent ? ` (${r.sent} sent before the failure)` : ''}`);
    return r.status === 'ok' || r.status === 'empty' ? 0 : 1;
  } finally {
    release();
  }
}
