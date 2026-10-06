import { loadConfig, maskToken } from '../config.js';
import { readJsonFile } from '../fsutil.js';
import { listJobs } from '../jobs.js';
import { EventQueue } from '../queue.js';
import { readDeliveryState } from '../sender.js';
import { COLLECTOR_VERSION } from '../version.js';
import { pendingSummariesPath } from '../analysis/summaries.js';
import { ago, formatBytes, parseOptions, type CliDeps, type Io } from './common.js';

/** `ai-obs status` — local state at a glance (no network). */
export async function statusCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  parseOptions(args, {});
  const config = loadConfig(deps.paths, deps.env ?? process.env);
  io.out(`ai-obs ${COLLECTOR_VERSION} — home ${deps.paths.root}`);
  if (!config) {
    io.out('not configured — run `ai-obs init --token … --endpoint …`');
    return 1;
  }
  io.out(`endpoint   ${config.endpoint}`);
  io.out(`token      ${maskToken(config.token)}`);
  io.out(`machine    ${config.machine_id}`);
  const q = new EventQueue(deps.paths.queue).stats();
  io.out(`queue      ${q.events} events in ${q.files} file(s), ${formatBytes(q.bytes)}${q.oldestAt ? `, oldest ${ago(new Date(q.oldestAt).toISOString())}` : ''}`);
  io.out(`jobs       ${listJobs(deps.paths.jobs).length} pending`);
  const pending = ['claude-code', 'codex'].map((h) => (readJsonFile<unknown[]>(pendingSummariesPath(deps.paths.state, h)) ?? []).length);
  io.out(`summaries  ${pending.reduce((a, b) => a + b, 0)} waiting for retry`);
  const d = readDeliveryState(deps.paths);
  io.out(`last send  ${ago(d.last_success_at)}${d.last_result ? ` (accepted ${d.last_result.accepted}, duplicates ${d.last_result.duplicates}, rejected ${d.last_result.rejected})` : ''}`);
  if (d.last_error) io.out(`last error ${d.last_error} (${ago(d.last_attempt_at)}, ${d.consecutive_failures} in a row${d.next_attempt_at ? `, next try after ${d.next_attempt_at}` : ''})`);
  return 0;
}
