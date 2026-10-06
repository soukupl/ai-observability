import { existsSync } from 'node:fs';
import { ADAPTERS } from '../adapters/index.js';
import { hookRuntimeProblems } from '../adapters/hook-command.js';
import { loadConfig, maskToken } from '../config.js';
import { gitTopLevel } from '../git.js';
import { listJobs } from '../jobs.js';
import { EventQueue } from '../queue.js';
import { checkEndpoint, getCollectorConfig, readDeliveryState } from '../sender.js';
import { COLLECTOR_VERSION, compareVersions } from '../version.js';
import { ago, formatBytes, parseOptions, type CliDeps, type Io } from './common.js';

/** `ai-obs doctor` — every check prints ✓ / ! / ✗; exit 1 when any ✗. */
export async function doctorCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  parseOptions(args, {});
  let failed = 0;
  const ok = (s: string) => io.out(`✓ ${s}`);
  const warn = (s: string) => io.out(`! ${s}`);
  const bad = (s: string) => {
    failed++;
    io.out(`✗ ${s}`);
  };
  io.out(`ai-obs doctor (collector ${COLLECTOR_VERSION}, node ${process.version})`);

  const config = loadConfig(deps.paths, deps.env ?? process.env);
  if (!config) {
    bad(`no valid config at ${deps.paths.config} — run \`ai-obs init --token … --endpoint …\``);
    return 1;
  }
  ok(`config ${deps.paths.config}: endpoint ${config.endpoint}, token ${maskToken(config.token)}, machine ${config.machine_id}`);
  if (config.endpoint.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(config.endpoint)) {
    warn('endpoint uses plain http: the token is sent unencrypted');
  }

  const check = await checkEndpoint({ config, transport: deps.transport });
  if (!check.reachable) bad(`endpoint unreachable: ${check.error}`);
  else ok(`endpoint reachable (HTTP ${check.status})`);
  if (check.tokenValid === true) ok('token valid');
  else if (check.tokenValid === false) bad(`token rejected (HTTP ${check.status})`);
  else if (check.reachable) bad(`unexpected response from collector-config (HTTP ${check.status})`);

  if (check.value) {
    const min = check.value.min_collector_version;
    if (compareVersions(COLLECTOR_VERSION, min) < 0) bad(`collector ${COLLECTOR_VERSION} is older than the server minimum ${min}`);
    else ok(`collector version ${COLLECTOR_VERSION} ≥ server minimum ${min}`);
  }
  const cc = await getCollectorConfig({ config, paths: deps.paths, transport: deps.transport });
  ok(`project naming: ${cc.value.project_naming} (${cc.source === 'default' ? 'default until the server is reached' : `fetched ${ago(cc.fetchedAt)}`})`);

  const projectDir = (await gitTopLevel(deps.cwd ?? process.cwd())) ?? undefined;
  let installed = 0;
  for (const adapter of deps.adapters ?? ADAPTERS) {
    const d = await adapter.detect(projectDir ? { projectDir } : {});
    if (!d.installed) {
      io.out(`– ${adapter.displayName}: not installed`);
      continue;
    }
    installed++;
    const ver = d.version ?? 'unknown version';
    const hooks = d.hooksInstalled.user || d.hooksInstalled.project;
    const where = [d.hooksInstalled.user && 'user', d.hooksInstalled.project && 'project'].filter(Boolean).join(' + ');
    const line = `${adapter.displayName} ${ver}${d.versionSupported === false ? ' (unsupported version)' : ''}: ${hooks ? `hooks installed (${where})` : 'hooks NOT installed — run `ai-obs init`'}`;
    if (!hooks || d.versionSupported === false) bad(line);
    else if (d.versionSupported === null) warn(`${line}; version support unknown`);
    else ok(line);
    for (const w of d.warnings ?? []) warn(`${adapter.displayName}: ${w}`);
    for (const n of d.notes ?? []) io.out(`    ${n}`);
    if (hooks && adapter.installedHookCommands) {
      // A baked-in node path or script that no longer exists makes every hook fail silently.
      const problems = new Set<string>();
      for (const c of await adapter.installedHookCommands(projectDir ? { projectDir } : {})) for (const p of hookRuntimeProblems(c)) problems.add(p);
      for (const p of problems) bad(`${adapter.displayName} hooks point to a stale runtime: ${p}; hooks do nothing until you run \`ai-obs init\` again`);
    }
  }
  if (!installed) bad('no supported harness installed (Claude Code, Codex)');

  const entry = `${deps.paths.app}/bin/ai-obs.js`;
  if (existsSync(entry)) ok(`hook runtime ${entry}`);
  else warn(`hook runtime not copied to ${deps.paths.app} (hooks run from the install location)`);

  const stats = new EventQueue(deps.paths.queue).stats();
  const pendingJobs = listJobs(deps.paths.jobs).length;
  const qline = `queue: ${stats.events} events (${formatBytes(stats.bytes)})${pendingJobs ? `, ${pendingJobs} hook jobs pending` : ''}`;
  if (stats.oldestAt && Date.now() - stats.oldestAt > 24 * 3600_000) warn(`${qline}, oldest ${ago(new Date(stats.oldestAt).toISOString())}`);
  else ok(qline);

  const delivery = readDeliveryState(deps.paths);
  if (delivery.last_error) warn(`last send failed ${ago(delivery.last_attempt_at)}: ${delivery.last_error}`);
  if (delivery.last_success_at) {
    const r = delivery.last_result;
    ok(`last successful send ${ago(delivery.last_success_at)}${r ? ` (accepted ${r.accepted}, duplicates ${r.duplicates}, rejected ${r.rejected})` : ''}`);
  } else io.out('– nothing sent yet');

  io.out(failed ? `${failed} problem(s) found. Log: ${deps.paths.logFile}` : 'All good.');
  return failed ? 1 : 0;
}
