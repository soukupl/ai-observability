import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cachedValue } from '../cc-cache.js';
import { findServer } from '../config.js';
import { droppedLine, readDelivery, readDropped, serverDelivery } from '../delivery.js';
import { dotFileProblems, lookupDotFile } from '../dotfile.js';
import { readJsonFile } from '../fsutil.js';
import { listJobs } from '../jobs.js';
import { resolveProjectKey, RESOLVE_TIMEOUT_MS } from '../project-key.js';
import { loadRouting, targetFor, type HeldReason, type RoutingView } from '../routing.js';
import { COLLECTOR_VERSION, compareVersions } from '../version.js';
import { readWarnings, warningText } from '../warnings.js';
import { countStagedDigests, pendingSummariesPath } from '../analysis/summaries.js';
import {
  ago,
  describeServer,
  formatBytes,
  HELD_LABEL,
  noServerLines,
  nowOf,
  openStore,
  parseOptions,
  serverState,
  summarizeQueue,
  terminalSafe,
  type CliDeps,
  type Io,
  type QueueSummary,
} from './common.js';

const NOT_CONFIGURED = 'not configured — run `ai-obs login --server <url>`';
const MAX_QUEUE_BYTES = 50 * 1024 * 1024;
const DROPPED_SHOWN_MS = 30 * 24 * 3600_000;

export interface RepoLine {
  level: 'ok' | 'warn' | 'bad' | 'info';
  text: string;
}

/**
 * "This repository": its dot file (and whether it is valid), the server and team its new sessions report to,
 * that server's token state, and the latest warning the server gave about its team (status, doctor).
 */
export async function checkRepository(view: RoutingView, deps: CliDeps, cwd: string, nowMs: number): Promise<RepoLine[]> {
  const out: RepoLine[] = [];
  const dot = lookupDotFile(cwd);
  const servers = view.config.servers;
  if (!dot.root) out.push({ level: 'info', text: `${cwd} is not inside a git repository (no dot file is read here)` });
  else if (!dot.dir) out.push({ level: 'info', text: `no .ai-obs.json in ${dot.root}` });
  else {
    for (const f of [dot.committed, dot.local]) {
      if (f?.status === 'ok') out.push({ level: 'ok', text: `${f.path}: ${[f.value?.server && `server ${f.value.server}`, f.value?.team && `team ${f.value.team}`].filter(Boolean).join(', ') || 'no keys'}` });
    }
  }
  for (const p of dotFileProblems(dot)) out.push({ level: 'bad', text: p });
  const target = targetFor(view.config, { ...(dot.server ? { server: dot.server } : {}), ...(dot.team ? { team: dot.team } : {}) });
  const via = dot.server ? 'from the dot file' : 'the only server';
  let teams: string[] | null = null;
  if (target.endpoint === '') {
    if (servers.length) {
      out.push({
        level: 'warn',
        text: `no server chosen (${servers.length} servers are registered and no dot file names one): new sessions are kept on this machine. Run \`ai-obs link --server <url> --team <slug>\``,
      });
    } else out.push({ level: 'warn', text: 'not logged in to any server: nothing is recorded' });
  } else {
    const entry = findServer(view.config, target.endpoint);
    if (!entry) {
      out.push({ level: 'bad', text: `server ${target.endpoint} (${via}): this machine is not logged in to it; data waits here. Run \`ai-obs login --server ${target.endpoint}\`` });
    } else {
      const st = serverState(view, deps, entry, nowMs);
      out.push({ level: st.problem ? 'bad' : 'ok', text: `server ${entry.endpoint} (${via}): ${st.short}` });
      teams = cachedValue(deps.paths, entry)?.teams?.map((t) => t.slug) ?? null;
    }
  }
  if (target.team) {
    if (teams && !teams.includes(target.team)) {
      out.push({ level: 'warn', text: `team ${target.team}: you are not a member of it on that server (your teams: ${teams.join(', ') || 'none'}); the server uses the project mapping or your primary team` });
    } else out.push({ level: 'ok', text: `team ${target.team}` });
  } else if (target.endpoint) {
    out.push({ level: 'info', text: 'team: none in the dot file (the server uses the project mapping, else your primary team)' });
  }
  const warnings = readWarnings(deps.paths);
  if (Object.keys(warnings).length) {
    const resolveKey = deps.resolveProjectKey ?? ((c: string, o: { timeoutMs: number }) => resolveProjectKey(c, o));
    const pk = await resolveKey(cwd, { timeoutMs: RESOLVE_TIMEOUT_MS });
    const w = pk !== null ? warnings[pk] : undefined;
    if (w) out.push({ level: 'warn', text: `server warning (${w.at.slice(0, 10)}, ${w.endpoint}): ${warningText(w)}` });
  }
  return out;
}

/** The copied hook runtime (`<home>/app`) when it is older than this collector (C25); null when current or absent. */
export function staleRuntime(paths: CliDeps['paths']): string | null {
  const v = readJsonFile<{ version?: unknown }>(join(paths.app, 'package.json'))?.version;
  if (!existsSync(join(paths.app, 'bin', 'ai-obs.js'))) return null;
  const runtime = typeof v === 'string' ? v : '0.0.0';
  if (compareVersions(runtime, COLLECTOR_VERSION) >= 0) return null;
  return `hook runtime is ${runtime}, collector is ${COLLECTOR_VERSION}: run \`ai-obs init\` to update it`;
}

/** Lines about kept (not sendable now) events, shared by status and doctor. */
export function keptLines(q: QueueSummary, skip: readonly HeldReason[] = []): string[] {
  const out: string[] = [];
  for (const [ep, n] of Object.entries(q.blocked)) out.push(`${n} events for ${ep} wait: its token is expired or was refused (\`ai-obs login --server ${ep}\`)`);
  if (!skip.includes('no-server')) out.push(...noServerLines(q));
  for (const [reason, n] of Object.entries(q.byReason)) {
    if (!n || reason === 'no-server' || skip.includes(reason as HeldReason)) continue;
    out.push(`${n} events: ${HELD_LABEL[reason as HeldReason]}`);
  }
  return out;
}

const MARK: Record<RepoLine['level'], string> = { ok: '', warn: '! ', bad: '✗ ', info: '' };

/** `ai-obs status` — local state at a glance (no network). */
export async function statusCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  parseOptions(args, {});
  const nowMs = nowOf(deps);
  io.out(`ai-obs ${COLLECTOR_VERSION} — home ${deps.paths.root}`);
  const view = loadRouting(deps.paths, nowMs);
  if (!view) {
    io.out(NOT_CONFIGURED);
    return 1;
  }
  const config = view.config;
  io.out(`machine    ${config.machine_id}`);
  if (!config.servers.length) io.out('servers    none');
  config.servers.forEach((s, i) => {
    io.out(`${i ? '           ' : 'servers    '}${s.endpoint}  ${describeServer(s)} · ${serverState(view, deps, s, nowMs).short}`);
  });

  const cwd = deps.cwd ?? process.cwd();
  const repo = await checkRepository(view, deps, cwd, nowMs);
  repo.forEach((l, i) => io.out(`${i ? '           ' : 'repository '}${MARK[l.level]}${terminalSafe(l.text)}`));

  const q = summarizeQueue(openStore(deps.paths).stats(), view);
  const s = q.stats;
  io.out(`queue      ${s.events} events in ${s.files} file(s), ${formatBytes(s.bytes)}${s.oldestAt ? `, oldest ${ago(new Date(s.oldestAt).toISOString(), nowMs)}` : ''}`);
  const kept = keptLines(q);
  kept.forEach((line, i) => io.out(`${i ? '           ' : 'kept       '}${line}`));
  const dropped = readDropped(deps.paths);
  const droppedText = droppedLine(dropped);
  if (droppedText && dropped.last_at && nowMs - Date.parse(dropped.last_at) < DROPPED_SHOWN_MS) io.out(`dropped    ${droppedText}`);
  if (q.kept > 0 && s.bytes > MAX_QUEUE_BYTES * 0.8) {
    io.out(`!          queue at ${Math.round((s.bytes / MAX_QUEUE_BYTES) * 100)}% of its 50 MB cap; the oldest events, kept ones included, are dropped first`);
  }
  const stale = staleRuntime(deps.paths);
  if (stale) io.out(`runtime    ${stale}`);
  io.out(`jobs       ${listJobs(deps.paths.jobs).length} pending`);
  const harnesses = ['claude-code', 'codex'];
  const retry = harnesses.reduce((n, h) => n + (readJsonFile<unknown[]>(pendingSummariesPath(deps.paths.state, h)) ?? []).length, 0);
  const due = harnesses.reduce((n, h) => n + countStagedDigests(deps.paths.state, h), 0);
  io.out(`summaries  ${retry} waiting for retry, ${due} due`);
  if (config.servers.length === 1) {
    const d = serverDelivery(readDelivery(deps.paths), config.servers[0]!);
    io.out(`last send  ${ago(d.last_success_at, nowMs)}${d.last_result ? ` (accepted ${d.last_result.accepted}, duplicates ${d.last_result.duplicates}, rejected ${d.last_result.rejected})` : ''}`);
    if (d.last_error) io.out(`last error ${d.last_error} (${ago(d.last_attempt_at, nowMs)}, ${d.consecutive_failures} in a row${d.next_attempt_at ? `, next try after ${d.next_attempt_at}` : ''})`);
  }
  return config.servers.length ? 0 : 1;
}
