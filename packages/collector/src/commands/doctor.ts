import { existsSync } from 'node:fs';
import { ADAPTERS } from '../adapters/index.js';
import { hookRuntimeProblems } from '../adapters/hook-command.js';
import { readCache, writeCache } from '../cc-cache.js';
import { tokenKind } from '../config.js';
import { clearBlocked, readDelivery, droppedLine, readDropped, tokenDelivery } from '../delivery.js';
import { gitTopLevel } from '../git.js';
import { listJobs } from '../jobs.js';
import { resolveProjectKey, RESOLVE_TIMEOUT_MS } from '../project-key.js';
import { effectiveCompany, loadRouting } from '../projects.js';
import { checkEndpoint } from '../sender.js';
import { COLLECTOR_VERSION, compareVersions } from '../version.js';
import { ago, formatBytes, listSome, nowOf, openStore, parseOptions, summarizeQueue, takePreUpgradeNote, type CliDeps, type Io } from './common.js';
import { checkProject, keptLines, staleRuntime } from './status.js';

const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;
const DROPPED_SHOWN_MS = 30 * 24 * 3600_000;
const MAX_QUEUE_BYTES = 50 * 1024 * 1024;

/** `ai-obs doctor` — every check prints ✓ / ! / ✗; exit 1 when any ✗ (design §2.7). */
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
  let view = loadRouting(deps.paths);
  if (!view) {
    bad(`no valid config at ${deps.paths.config} — run \`ai-obs init --token … --endpoint …\``);
    return 1;
  }
  const config = view.config;
  if (!config.tokens.length) {
    const legacy = config.legacyToken ?? config.legacy?.token_mask;
    bad(`no tokens registered — run \`ai-obs init --token … --endpoint …\`${legacy ? ` (the token from before the upgrade, ${legacy}, was revoked)` : ''}`);
    return 1;
  }
  ok(`config ${deps.paths.config}: machine ${config.machine_id}, ${config.tokens.length} token(s)`);
  if (config.invalidTokens.length) {
    bad(
      `${config.invalidTokens.length} malformed token entries in config.json: new sessions of repositories without an explicit token are kept on this machine. Run \`ai-obs token remove --invalid\`, then \`ai-obs token add\` for the missing token`,
    );
  }

  // 2. Per token: server, token, company, version, naming
  const several = config.tokens.length > 1;
  for (const t of config.tokens) {
    const L = several ? t.name : '';
    const tag = (s: string) => (L ? `${s} (${L})` : s);
    if (t.endpoint.startsWith('http://') && !LOCAL_HTTP.test(t.endpoint)) warn(`${L ? `${L}: ` : ''}endpoint uses plain http: the token is sent unencrypted`);
    const check = await checkEndpoint({ endpoint: t.endpoint, token: t.token, ...(deps.transport ? { transport: deps.transport } : {}) });
    const eff = effectiveCompany(t, view.caches[t.name]);
    if (!check.reachable) bad(`endpoint unreachable${L ? ` (${L})` : ''}: ${check.error}`);
    else if (check.status === 401) bad(`token rejected (${L ? `${L}, ` : ''}HTTP 401): create a new token and run \`ai-obs token add --token <new token> --name ${t.name}\``);
    else if (check.status === 403) bad(`company ${eff?.name ?? t.name} is suspended (${L ? `${L}, ` : ''}HTTP 403)`);
    else if (check.status === 429) warn(`rate limited${L ? ` (${L})` : ''}: try again in a minute`);
    else if (!check.value) bad(`unexpected response from collector-config (${L ? `${L}, ` : ''}HTTP ${check.status})`);
    if (check.value) {
      const value = check.value;
      ok(`endpoint reachable (HTTP ${check.status})`);
      const who = tokenKind(t.token) === 'company' ? 'company token' : `user ${value.user?.email ?? t.email ?? '?'}`;
      ok(`token valid (${L ? `${L}: ` : ''}${value.company?.name ?? '?'}, ${who})`);
      try {
        writeCache(deps.paths, t, { fetched_at: new Date(nowMs).toISOString(), value, failed_at: undefined });
        clearBlocked(deps.paths, t); // contract: blocked until the next manual flush / doctor succeeds
      } catch {
        /* read-only home: the checks still stand */
      }
      const reported = value.company?.slug;
      const stored = t.company?.slug;
      if (reported && stored && reported !== stored) {
        bad(`${t.name}: the server reports company ${reported}; run \`ai-obs token confirm ${t.name}\` to send with it`);
      } else if (!stored && reported && several && reported !== t.name) {
        bad(`${t.name}: the server reports company ${reported}; run \`ai-obs token confirm ${t.name}\` to send with it`);
      } else if (!stored && several && reported !== t.name) {
        bad(`${t.name}: its company is not confirmed; run \`ai-obs token confirm ${t.name}\` to send with it`);
      } else if (!stored && !several) {
        warn(`token not confirmed yet: it is confirmed on the next send (\`ai-obs flush\`)`);
      }
      const min = value.min_collector_version;
      if (compareVersions(COLLECTOR_VERSION, min) < 0) bad(tag(`collector ${COLLECTOR_VERSION} is older than the server minimum ${min}`));
      else ok(tag(`collector version ${COLLECTOR_VERSION} ≥ server minimum ${min}`));
      ok(tag(`project naming: ${value.project_naming} (fetched now)`));
    } else {
      const cached = readCache(deps.paths, t);
      if (cached?.value) ok(tag(`project naming: ${cached.value.project_naming} (cached ${ago(cached.fetched_at, nowMs)})`));
      else warn(tag('project naming: unknown until the server is reached; events stay queued meanwhile'));
    }
  }
  view = loadRouting(deps.paths) ?? view; // doctor may have refreshed caches and cleared blocked flags

  // 3. Project (cwd)
  const cwd = deps.cwd ?? process.cwd();
  const store = openStore(deps.paths);
  const q = summarizeQueue(store.stats(), view);
  const resolveKey = deps.resolveProjectKey ?? ((c: string, o: { timeoutMs: number }) => resolveProjectKey(c, o));
  const key = await resolveKey(cwd, { timeoutMs: RESOLVE_TIMEOUT_MS });
  const p = checkProject(view, key, q, nowMs);
  ({ ok, warn, bad })[p.level](`project ${p.text}`);
  if (p.note) warn(p.note);
  if (view.projects.status === 'ok' && view.projects.mode !== undefined && view.projects.mode !== 0o600) {
    warn(`${deps.paths.projects} has mode ${view.projects.mode.toString(8)}; expected 600 (\`chmod 600\` it)`);
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
  const s = q.stats;
  const pendingJobs = listJobs(deps.paths.jobs).length;
  const qline = `queue: ${s.events} events (${formatBytes(s.bytes)}): ${q.sendable} sendable, ${q.kept} kept${pendingJobs ? `; ${pendingJobs} hook jobs pending` : ''}`;
  if (q.sendableOldestAt !== null && nowMs - q.sendableOldestAt > 24 * 3600_000) warn(`${qline}, oldest sendable ${ago(new Date(q.sendableOldestAt).toISOString(), nowMs)}`);
  else ok(qline);
  if (q.waiting.keys.length) {
    warn(
      `${q.waiting.keys.length} projects waiting for a token (${q.waiting.events} events): \`ai-obs use <name>\` in each, or \`ai-obs use <name> --all-held\`: ${listSome(q.waiting.keys, 10)}`,
    );
  }
  for (const u of q.unknown) bad(`queue stream ${u.dir} has no readable stream.json; its ${u.events} events are kept and never sent: inspect or delete it`);
  for (const line of keptLines(view, q, ['unknown-stream'])) warn(line);
  const dropped = readDropped(deps.paths);
  const droppedText = droppedLine(dropped);
  if (droppedText && dropped.last_at && nowMs - Date.parse(dropped.last_at) < DROPPED_SHOWN_MS) warn(droppedText);
  if (q.kept > 0 && s.bytes > MAX_QUEUE_BYTES * 0.8) {
    warn(`queue at ${Math.round((s.bytes / MAX_QUEUE_BYTES) * 100)}% of its 50 MB cap; the oldest events, kept ones included, are dropped first`);
  }
  const pre = takePreUpgradeNote(deps.paths, new Date(nowMs));
  if (pre) warn(pre);

  // 6. Delivery per token
  const delivery = readDelivery(deps.paths);
  for (const t of view.config.tokens) {
    const L = several ? ` (${t.name})` : '';
    const st = tokenDelivery(delivery, t);
    if (st.blocked) warn(`${t.name} is refused by its server (HTTP ${st.blocked.status}: ${st.blocked.message}); \`ai-obs flush\` retries it`);
    else if (st.last_error) warn(`last send failed ${ago(st.last_attempt_at, nowMs)}${L}: ${st.last_error}`);
    if (st.last_success_at) {
      const r = st.last_result;
      ok(`last successful send ${ago(st.last_success_at, nowMs)}${L}${r ? ` (accepted ${r.accepted}, duplicates ${r.duplicates}, rejected ${r.rejected})` : ''}`);
    } else io.out(`– nothing sent yet${L}`);
  }

  io.out(failed ? `${failed} problem(s) found. Log: ${deps.paths.logFile}` : 'All good.');
  return failed ? 1 : 0;
}

