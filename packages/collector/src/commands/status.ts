import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readDelivery, droppedLine, readDropped, tokenDelivery } from '../delivery.js';
import { readJsonFile } from '../fsutil.js';
import { listJobs } from '../jobs.js';
import { resolveProjectKey, RESOLVE_TIMEOUT_MS } from '../project-key.js';
import {
  assignmentIdentity,
  captureBinding,
  effectiveCompany,
  entryFor,
  isExplicit,
  loadRouting,
  routable,
  type HeldReason,
  type RoutingView,
} from '../projects.js';
import { COLLECTOR_VERSION, compareVersions } from '../version.js';
import { pendingSummariesPath } from '../analysis/summaries.js';
import {
  ago,
  formatBytes,
  HELD_LABEL,
  listSome,
  nowOf,
  openStore,
  parseOptions,
  summarizeQueue,
  takePreUpgradeNote,
  type CliDeps,
  type Io,
  type QueueSummary,
} from './common.js';
import { describeTokenLine } from './register.js';

const NOT_CONFIGURED = 'not configured — run `ai-obs init --token … --endpoint …`';
const MAX_QUEUE_BYTES = 50 * 1024 * 1024;
const DROPPED_SHOWN_MS = 30 * 24 * 3600_000;

/** The project's next-session routing and its queued data (status `project` line, doctor project check). */
export interface ProjectCheck {
  level: 'ok' | 'warn' | 'bad';
  text: string;
  /** extra line: open data waiting while new sessions are bound */
  note?: string;
}

const tokenNames = (view: RoutingView) => view.config.tokens.map((t) => t.name).join('|');

/** design §2.6 `project` line, from captureBinding plus the key's streams. */
export function checkProject(view: RoutingView, key: string | null, q: QueueSummary, nowMs: number): ProjectCheck {
  if (key === null) return { level: 'warn', text: 'git did not answer in time; the repository could not be read' };
  if (view.projects.status !== 'ok') {
    return {
      level: 'bad',
      text: `projects.json cannot be read (${view.projects.error}): with several tokens new sessions are kept here; with one token they report to it and \`--none\` choices are not applied. Run \`ai-obs use --reset-projects\` (the file is set aside, not deleted)`,
    };
  }
  const queued = q.byKey.get(key) ?? { open: 0, bound: 0 };
  const a = Object.prototype.hasOwnProperty.call(view.projects.entries, key) ? view.projects.entries[key] : undefined;
  if (a && !isExplicit(a)) return { level: 'warn', text: `${key} is not reported (\`use --none\`; ${queued.open + queued.bound} events kept)` };
  const notConfirmed = (n: string): ProjectCheck => ({ level: 'warn', text: `${key} → ${n}, which is not confirmed: \`ai-obs token confirm ${n}\`` });
  let res: ProjectCheck;
  if (isExplicit(a)) {
    const t = entryFor(view, assignmentIdentity(a));
    if (!t) {
      return {
        level: 'warn',
        text: `${key} assigned to ${a.token}, which is no longer registered (or now belongs to another company): \`ai-obs use <${tokenNames(view)}>\``,
      };
    }
    res = routable(t, view.caches[t.name]) === 'ok' ? { level: 'ok', text: `${key} → ${t.name}` } : notConfirmed(t.name);
  } else {
    const d = captureBinding(view, key, nowMs);
    if (d.kind === 'drop') return { level: 'warn', text: `${key}: nothing is recorded (no token)` };
    if (d.bind.kind === 'token') {
      const t = entryFor(view, d.bind.id);
      res = t && routable(t, view.caches[t.name]) !== 'ok' ? notConfirmed(t.name) : { level: 'ok', text: `${key} → ${d.bind.name} (only token)` };
    } else if (d.openReason === 'config-damaged') {
      return { level: 'warn', text: 'config.json has malformed token entries: new sessions are kept here (`ai-obs doctor`)' };
    } else {
      return {
        level: 'warn',
        text: `${key} not assigned: new sessions are kept here${queued.open ? ` (${queued.open} events waiting)` : ''}. Run \`ai-obs use <${tokenNames(view)}>\``,
      };
    }
  }
  if (queued.open) {
    res.note = `${queued.open} events recorded while several tokens were registered wait for a choice: \`ai-obs use <name>\``;
    if (res.level === 'ok') res.level = 'warn';
  }
  return res;
}

/** The copied hook runtime (`<home>/app`) when it is older than this collector (C25); null when current or absent. */
export function staleRuntime(paths: CliDeps['paths']): string | null {
  const v = readJsonFile<{ version?: unknown }>(join(paths.app, 'package.json'))?.version;
  if (!existsSync(join(paths.app, 'bin', 'ai-obs.js'))) return null;
  const runtime = typeof v === 'string' ? v : '0.0.0';
  if (compareVersions(runtime, COLLECTOR_VERSION) >= 0) return null;
  return `hook runtime is ${runtime}, collector is ${COLLECTOR_VERSION}: run \`ai-obs init\` to update it (sessions ask for a token only with ≥ 0.2.0)`;
}

/** design §2.6 state of a token on the `tokens` line. */
function tokenStateLine(view: RoutingView, deps: CliDeps, name: string, nowMs: number): string {
  const t = view.config.tokens.find((x) => x.name === name)!;
  const st = tokenDelivery(readDelivery(deps.paths), t);
  const eff = effectiveCompany(t, view.caches[name]);
  if (st.blocked?.status === 401) {
    return `REJECTED (HTTP 401): create a new token and run \`ai-obs token add --token <new token> --name ${name}\`; \`ai-obs flush\` retries the current one`;
  }
  if (st.blocked?.status === 403) return `company ${eff?.name ?? name} is SUSPENDED; \`ai-obs flush\` retries once it is active again`;
  if (routable(t, view.caches[name]) !== 'ok') return `UNCONFIRMED: run \`ai-obs token confirm ${name}\``;
  if (st.next_attempt_at && Date.parse(st.next_attempt_at) > nowMs) return `retrying: ${st.last_error ?? 'send failed'}`;
  return `ok, last send ${ago(st.last_success_at, nowMs)}`;
}

/** Lines about kept (not sendable now) events, shared by status and doctor. */
export function keptLines(view: RoutingView, q: QueueSummary, skip: readonly HeldReason[] = []): string[] {
  const out: string[] = [];
  for (const [name, n] of Object.entries(q.blocked)) {
    out.push(`${n} events for ${name} (${view.blocked[name]?.status === 403 ? 'suspended' : 'rejected'}); \`ai-obs flush\` retries it`);
  }
  if (q.danglingBound) {
    out.push(
      `${q.danglingBound} events recorded with tokens that are no longer registered: \`ai-obs token add\` a token of that company, or \`ai-obs use <name> --move-queued\` in the repository`,
    );
  }
  for (const [reason, n] of Object.entries(q.byReason)) {
    if (!n || reason === 'unassigned' || reason === 'dangling' || skip.includes(reason as HeldReason)) continue;
    out.push(`${n} events: ${HELD_LABEL[reason as keyof typeof HELD_LABEL]}`);
  }
  return out;
}

/** `ai-obs status` — local state at a glance (no network). */
export async function statusCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  parseOptions(args, {});
  const nowMs = nowOf(deps);
  io.out(`ai-obs ${COLLECTOR_VERSION} — home ${deps.paths.root}`);
  const view = loadRouting(deps.paths);
  if (!view) {
    io.out(NOT_CONFIGURED);
    return 1;
  }
  const config = view.config;
  io.out(`machine    ${config.machine_id}`);
  if (!config.tokens.length) {
    io.out('tokens     none');
    return 1;
  }
  config.tokens.forEach((t, i) => {
    const eff = effectiveCompany(t, view.caches[t.name]);
    const width = Math.max(...config.tokens.map((x) => x.name.length));
    io.out(`${i ? '           ' : 'tokens     '}${t.name.padEnd(width)}  ${describeTokenLine(t, eff)} · ${tokenStateLine(view, deps, t.name, nowMs)}`);
  });
  if (config.invalidTokens.length) io.out(`!          ${config.invalidTokens.length} malformed token entries in config.json (\`ai-obs doctor\`)`);

  const q = summarizeQueue(openStore(deps.paths).stats(), view);
  const cwd = deps.cwd ?? process.cwd();
  const resolveKey = deps.resolveProjectKey ?? ((c: string, o: { timeoutMs: number }) => resolveProjectKey(c, o));
  const key = await resolveKey(cwd, { timeoutMs: RESOLVE_TIMEOUT_MS });
  const p = checkProject(view, key, q, nowMs);
  io.out(`project    ${p.text}`);
  if (p.note) io.out(`           ${p.note}`);

  const s = q.stats;
  io.out(`queue      ${s.events} events in ${s.files} file(s), ${formatBytes(s.bytes)}${s.oldestAt ? `, oldest ${ago(new Date(s.oldestAt).toISOString(), nowMs)}` : ''}`);
  if (q.waiting.keys.length) {
    io.out(
      `waiting    ${q.waiting.keys.length} projects waiting for a token (${q.waiting.events} events): run \`ai-obs use <name>\` in each, or \`ai-obs use <name> --all-held\` (${listSome(q.waiting.keys, 5)})`,
    );
  }
  const kept = keptLines(view, q);
  kept.forEach((line, i) => io.out(`${i ? '           ' : 'kept       '}${line}`));
  const dropped = readDropped(deps.paths);
  const droppedText = droppedLine(dropped);
  if (droppedText && dropped.last_at && nowMs - Date.parse(dropped.last_at) < DROPPED_SHOWN_MS) io.out(`dropped    ${droppedText}`);
  if (q.kept > 0 && s.bytes > MAX_QUEUE_BYTES * 0.8) {
    io.out(`!          queue at ${Math.round((s.bytes / MAX_QUEUE_BYTES) * 100)}% of its 50 MB cap; the oldest events, kept ones included, are dropped first`);
  }
  const pre = takePreUpgradeNote(deps.paths, new Date(nowMs));
  if (pre) io.out(`pre-upgrade ${pre}`);
  const stale = staleRuntime(deps.paths);
  if (stale) io.out(`runtime    ${stale}`);
  io.out(`jobs       ${listJobs(deps.paths.jobs).length} pending`);
  const pending = ['claude-code', 'codex'].map((h) => (readJsonFile<unknown[]>(pendingSummariesPath(deps.paths.state, h)) ?? []).length);
  io.out(`summaries  ${pending.reduce((a, b) => a + b, 0)} waiting for retry`);
  if (config.tokens.length === 1) {
    const d = tokenDelivery(readDelivery(deps.paths), config.tokens[0]!);
    io.out(`last send  ${ago(d.last_success_at, nowMs)}${d.last_result ? ` (accepted ${d.last_result.accepted}, duplicates ${d.last_result.duplicates}, rejected ${d.last_result.rejected})` : ''}`);
    if (d.last_error) io.out(`last error ${d.last_error} (${ago(d.last_attempt_at, nowMs)}, ${d.consecutive_failures} in a row${d.next_attempt_at ? `, next try after ${d.next_attempt_at}` : ''})`);
  }
  return 0;
}

