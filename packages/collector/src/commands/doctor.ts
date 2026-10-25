import { existsSync } from 'node:fs';
import { ADAPTERS } from '../adapters/index.js';
import { hookRuntimeProblems } from '../adapters/hook-command.js';
import { readCache, writeCache } from '../cc-cache.js';
import { daysLeft, endpointHost, isExpired } from '../config.js';
import { clearBlocked, droppedLine, readDelivery, readDropped, serverDelivery } from '../delivery.js';
import { gitTopLevel } from '../git.js';
import { listJobs } from '../jobs.js';
import { loadRouting } from '../routing.js';
import { checkEndpoint, rejectedMessage, syncServerEntry } from '../sender.js';
import { COLLECTOR_VERSION, compareVersions } from '../version.js';
import { ago, formatBytes, nowOf, openStore, parseOptions, summarizeQueue, terminalSafe, type CliDeps, type Io } from './common.js';
import { checkRepository, keptLines, staleRuntime } from './status.js';

const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;
const DROPPED_SHOWN_MS = 30 * 24 * 3600_000;
const MAX_QUEUE_BYTES = 50 * 1024 * 1024;

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
  const nowMs = nowOf(deps);
  io.out(`ai-obs doctor (collector ${COLLECTOR_VERSION}, node ${process.version})`);

  // 1. Config
  let view = loadRouting(deps.paths, nowMs);
  if (!view) {
    bad(`no valid config at ${deps.paths.config} — run \`ai-obs login --server <url>\``);
    return 1;
  }
  const config = view.config;
  if (!config.servers.length) {
    bad('not logged in to any server — run `ai-obs login --server <url>`');
    return 1;
  }
  ok(`config ${deps.paths.config}: machine ${config.machine_id}, ${config.servers.length} server(s)`);

  // 2. Per server: reachable, token, expiry, version, naming
  for (const s of config.servers) {
    const host = endpointHost(s.endpoint);
    const tag = (t: string) => `${host}: ${t}`;
    if (s.endpoint.startsWith('http://') && !LOCAL_HTTP.test(s.endpoint)) warn(tag('endpoint uses plain http: the token is sent unencrypted'));
    if (isExpired(s, nowMs)) bad(tag(`token expired on ${s.expires_at!.slice(0, 10)}: run \`ai-obs login --server ${s.endpoint}\``));
    else {
      const days = daysLeft(s, nowMs);
      if (days !== null && days <= 14) warn(tag(`token expires in ${days} day${days === 1 ? '' : 's'} (${s.expires_at!.slice(0, 10)}): run \`ai-obs login --server ${s.endpoint}\``));
      else if (days !== null) ok(tag(`token expires ${s.expires_at!.slice(0, 10)} (${days} days)`));
    }
    const check = await checkEndpoint({ endpoint: s.endpoint, token: s.token, ...(deps.transport ? { transport: deps.transport } : {}) });
    if (!check.reachable) bad(tag(`unreachable: ${check.error}`));
    else if (check.status === 401) bad(tag(rejectedMessage(s.endpoint)));
    else if (check.status === 403) bad(tag(`access denied (HTTP 403${check.serverError ? `: ${check.serverError}` : ''})`));
    else if (check.status === 429) warn(tag('rate limited: try again in a minute'));
    else if (!check.value) bad(tag(`unexpected response from collector-config (HTTP ${check.status})`));
    if (check.value) {
      const value = check.value;
      ok(tag(`reachable, token valid (${terminalSafe(value.deployment?.name ?? '?')}, ${terminalSafe(value.user ? (value.user.email ?? `service user ${value.user.name}`) : (s.email ?? '?'))})`));
      try {
        writeCache(deps.paths, s, { fetched_at: new Date(nowMs).toISOString(), value, failed_at: undefined });
        clearBlocked(deps.paths, s); // refused until the next manual flush / doctor succeeds
        syncServerEntry(deps.paths, s, value); // e-mail, deployment and expiry of the entry, as the sender does
      } catch {
        /* read-only home: the checks still stand */
      }
      if (value.teams) ok(tag(`teams: ${terminalSafe(value.teams.map((t) => t.slug).join(', ') || 'none')}${value.primary_team ? ` (primary ${terminalSafe(value.primary_team)})` : ''}`));
      const min = value.min_collector_version;
      if (compareVersions(COLLECTOR_VERSION, min) < 0) bad(tag(`collector ${COLLECTOR_VERSION} is older than the server minimum ${min}`));
      else ok(tag(`collector version ${COLLECTOR_VERSION} ≥ server minimum ${min}`));
      ok(tag(`project naming: ${value.project_naming} (fetched now)`));
    } else {
      const cached = readCache(deps.paths, s);
      if (cached?.value) ok(tag(`project naming: ${cached.value.project_naming} (cached ${ago(cached.fetched_at, nowMs)})`));
      else warn(tag('project naming: unknown until the server is reached; events stay queued meanwhile'));
    }
  }
  view = loadRouting(deps.paths, nowMs) ?? view; // doctor may have refreshed caches, entries and blocked flags

  // 3. This repository: dot file, server, how the team is set
  const cwd = deps.cwd ?? process.cwd();
  for (const l of await checkRepository(view, deps, cwd, nowMs)) {
    const text = `repository: ${terminalSafe(l.text)}`;
    if (l.level === 'ok') ok(text);
    else if (l.level === 'warn') warn(text);
    else if (l.level === 'bad') bad(text);
    else io.out(`– ${text}`);
  }

  // 4. Harnesses and hooks
  const projectDir = (await gitTopLevel(cwd)) ?? undefined;
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
      for (const c of await adapter.installedHookCommands(projectDir ? { projectDir } : {})) for (const pr of hookRuntimeProblems(c)) problems.add(pr);
      for (const pr of problems) bad(`${adapter.displayName} hooks point to a stale runtime: ${pr}; hooks do nothing until you run \`ai-obs init\` again`);
    }
  }
  if (!installed) bad('no supported harness installed (Claude Code, Codex)');

  const entry = `${deps.paths.app}/bin/ai-obs.js`;
  if (existsSync(entry)) {
    ok(`hook runtime ${entry}`);
    const stale = staleRuntime(deps.paths);
    if (stale) warn(stale);
  } else warn(`hook runtime not copied to ${deps.paths.app} (hooks run from the install location)`);

  // 5. Queue
  const q = summarizeQueue(openStore(deps.paths).stats(), view);
  const s = q.stats;
  const pendingJobs = listJobs(deps.paths.jobs).length;
  const qline = `queue: ${s.events} events (${formatBytes(s.bytes)}): ${q.sendable} sendable, ${q.kept} kept${pendingJobs ? `; ${pendingJobs} hook jobs pending` : ''}`;
  if (q.sendableOldestAt !== null && nowMs - q.sendableOldestAt > 24 * 3600_000) warn(`${qline}, oldest sendable ${ago(new Date(q.sendableOldestAt).toISOString(), nowMs)}`);
  else ok(qline);
  for (const u of q.unknown) bad(`queue stream ${u.dir} has no readable stream.json; its ${u.events} events are kept and never sent: inspect or delete it`);
  for (const line of keptLines(q, ['unknown-stream'])) warn(line);
  const dropped = readDropped(deps.paths);
  const droppedText = droppedLine(dropped);
  if (droppedText && dropped.last_at && nowMs - Date.parse(dropped.last_at) < DROPPED_SHOWN_MS) warn(droppedText);
  if (q.kept > 0 && s.bytes > MAX_QUEUE_BYTES * 0.8) {
    warn(`queue at ${Math.round((s.bytes / MAX_QUEUE_BYTES) * 100)}% of its 50 MB cap; the oldest events, kept ones included, are dropped first`);
  }

  // 6. Delivery per server
  const delivery = readDelivery(deps.paths);
  for (const srv of view.config.servers) {
    const host = endpointHost(srv.endpoint);
    const st = serverDelivery(delivery, srv);
    if (st.blocked) warn(`${host}: refused by the server (HTTP ${st.blocked.status}: ${st.blocked.message})`);
    else if (st.last_error) warn(`${host}: last send failed ${ago(st.last_attempt_at, nowMs)}: ${st.last_error}`);
    if (st.last_success_at) {
      const r = st.last_result;
      ok(`${host}: last successful send ${ago(st.last_success_at, nowMs)}${r ? ` (accepted ${r.accepted}, duplicates ${r.duplicates}, rejected ${r.rejected})` : ''}`);
    } else io.out(`– ${host}: nothing sent yet`);
  }

  io.out(failed ? `${failed} problem(s) found. Log: ${deps.paths.logFile}` : 'All good.');
  return failed ? 1 : 0;
}
