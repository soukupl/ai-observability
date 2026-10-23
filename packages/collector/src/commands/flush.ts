import { ADAPTERS } from '../adapters/index.js';
import { countStagedDigests, pendingSummariesPath, runSummaryBatch } from '../analysis/summaries.js';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import { errorMessage, readJsonFile } from '../fsutil.js';
import { acquireLock, tryLock } from '../lock.js';
import { createLogger } from '../log.js';
import { RESOLVE_TIMEOUT_MS } from '../project-key.js';
import { effectiveCompany, loadRouting, type HeldReason } from '../projects.js';
import { flushQueue } from '../sender.js';
import { HELD_LABEL, openStore, parseOptions, summarizeQueue, type CliDeps, type Io } from './common.js';

const WAITING: readonly HeldReason[] = ['unassigned', 'dangling', 'projects-unreadable'];

/**
 * `ai-obs flush` — finish what is waiting, then send the queue now, per token, ignoring the retry
 * backoff and retrying refused tokens once. Before sending it runs each adapter's idle-session sweep
 * (Codex ends sessions idle for 1 h, Claude Code ones silent for 24 h) and writes the staged and pending
 * summaries, so data does not wait for the next hook (design §2.8). While the background worker's summary
 * phase holds summaries.lock, it leaves the summaries to it (ADR-0027).
 */
export async function flushCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, { wait: { type: 'string', default: '30' } });
  const config = loadConfig(deps.paths);
  if (!config || !config.tokens.length) {
    io.err('not configured — run `ai-obs init --token … --endpoint …`');
    return 1;
  }
  const release = await acquireLock(deps.paths.workerLock, Number(values.wait) * 1000, 15 * 60_000);
  if (!release) {
    io.out('the background worker is busy (e.g. a large backlog); it flushes when done');
    return 0;
  }
  try {
    const log = createLogger(deps.paths, 'flush');
    const store = openStore(deps.paths);
    const transport = deps.transport;
    const resolveProject = deps.resolveProjectKey ? (cwd: string) => deps.resolveProjectKey!(cwd, { timeoutMs: RESOLVE_TIMEOUT_MS }) : undefined;

    const sum = tryLock(deps.paths.summariesLock, 15 * 60_000);
    if (!sum) io.out('summaries are being written by the background worker; they are sent when done');
    try {
      for (const adapter of deps.adapters ?? ADAPTERS) {
        const ctx = createContext({ adapter, config, paths: deps.paths, queue: store, log, ...(resolveProject ? { resolveProject } : {}) });
        try {
          const before = store.stats().events;
          await adapter.sweepCrashedSessions(ctx);
          const swept = store.stats().events - before;
          if (swept > 0) io.out(`${adapter.displayName}: idle-session sweep queued ${swept} events`);
          if (!sum) continue;
          const waiting =
            (readJsonFile<unknown[]>(pendingSummariesPath(deps.paths.state, adapter.name)) ?? []).length + countStagedDigests(deps.paths.state, adapter.name);
          if (waiting) {
            // this process holds worker.lock: the summaries go straight into the queue it sends below
            const r = await runSummaryBatch(adapter, ctx, {
              retry: true,
              commit: async (groups) => {
                for (const g of groups) store.enqueue(g.events, g.key);
                return true;
              },
            });
            io.out(`${adapter.displayName}: summaries ${r?.summarized ?? 0} of ${waiting} done, ${r?.pending ?? waiting} still waiting`);
          }
        } catch (err) {
          log.warn('flush: sweep / summaries failed', { harness: adapter.name, error: errorMessage(err).slice(0, 200) });
        }
      }
    } finally {
      sum?.();
    }

    const r = await flushQueue(
      store,
      { paths: deps.paths, log, ...(transport ? { transport } : {}), ...(deps.resolveProjectKey ? { resolveProjectKey: deps.resolveProjectKey } : {}) },
      { force: true, maxBatches: 1000 },
    );
    if (r.confirmed) {
      const { from, to, company } = r.confirmed;
      io.out(from === to ? `✓ token ${to} confirmed: ${company.name}` : `✓ token \`${from}\` confirmed: ${company.name}; renamed to ${to}`);
    }
    const view = loadRouting(deps.paths);
    let failedTokens = 0;
    let printed = false;
    for (const [name, t] of Object.entries(r.tokens)) {
      const entry = view?.config.tokens.find((x) => x.name === name);
      const companyName = (entry && effectiveCompany(entry, view?.caches[name])?.name) ?? name;
      const sentBefore = t.sent ? ` (${t.sent} sent before the failure)` : '';
      switch (t.status) {
        case 'ok':
          io.out(`sent ${t.sent} events to ${name} in ${t.batches} batch(es): accepted ${t.accepted}, duplicates ${t.duplicates}, rejected ${t.rejected}; ${t.left} left`);
          break;
        case 'auth_error':
          failedTokens++;
          io.err(`✗ ${name}: token rejected (HTTP 401): create a new token and run \`ai-obs token add --token <new token> --name ${name}\`; ${t.left} events stay queued${sentBefore}`);
          break;
        case 'suspended':
          failedTokens++;
          io.err(`✗ ${name}: company ${companyName} is suspended; ${t.left} events stay queued${sentBefore}`);
          break;
        case 'failed':
          failedTokens++;
          io.err(`✗ ${name}: send failed: ${t.error ?? 'unknown error'}; ${t.left} events stay queued${sentBefore}`);
          break;
        case 'blocked':
        case 'backoff':
          io.out(`! ${name}: not sent now (${t.error ?? t.status}); ${t.left} events stay queued`);
          break;
        default:
          continue;
      }
      printed = true;
    }

    const byReason = r.held.byReason;
    const waiting = WAITING.reduce((n, k) => n + (byReason[k] ?? 0), 0);
    if (waiting) {
      const keys = view ? summarizeQueue(store.stats(), view).waiting.keys.length : 0;
      io.out(`! kept: ${waiting} events of ${keys || r.held.projects.length || 1} project(s) waiting for a token — \`ai-obs use <name>\` in each (\`ai-obs status\` lists them)`);
      printed = true;
    }
    for (const [reason, n] of Object.entries(byReason) as Array<[HeldReason, number]>) {
      if (!n || WAITING.includes(reason)) continue;
      io.out(`kept: ${n} events (${HELD_LABEL[reason]})`);
      printed = true;
    }
    if (r.dropped.events) {
      io.out(`! the queue caps (30 days / 50 MB) dropped ${r.dropped.events} events (${r.dropped.heldEvents} of them kept for a choice)`);
      printed = true;
    }
    if (r.status === 'failed' && !Object.keys(r.tokens).length && r.error) {
      io.err(`✗ send failed: ${r.error}`);
      return 1;
    }
    if (!printed) io.out('queue is empty');
    return failedTokens ? 1 : 0;
  } finally {
    release();
  }
}
