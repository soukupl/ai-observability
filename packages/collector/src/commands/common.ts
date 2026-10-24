import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { HarnessAdapter } from '../adapters/types.js';
import { daysLeft, endpointHost, isExpired, type CollectorConfig, type ServerEntry } from '../config.js';
import { readDelivery, recordDropped, serverDelivery } from '../delivery.js';
import type { Transport } from '../http.js';
import { acquireLock, tryLock } from '../lock.js';
import { createLogger } from '../log.js';
import { migrateHome, needsMigration } from '../migrate.js';
import type { AiObsPaths } from '../paths.js';
import { identityOfRef, QueueStore, type StoreStats } from '../queue.js';
import { loadRouting, resolveStream, type HeldReason, type RoutingView } from '../routing.js';
import type { RuntimeInstall } from '../runtime.js';

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Injectable dependencies (tests); production uses the defaults. */
export interface CliDeps {
  paths: AiObsPaths;
  adapters?: readonly HarnessAdapter[];
  transport?: Transport;
  installRuntime?: (paths: AiObsPaths) => RuntimeInstall;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** wait used by the device-login poll and the 429 retry of `login` */
  sleep?: (ms: number) => Promise<void>;
  /** wall clock in ms */
  now?: () => number;
  /** starts the background worker after `link` moved queued events (default: hook.ts defaultSpawnWorker) */
  spawnWorker?: (paths: AiObsPaths) => void;
  /** opens the device-login page (default: open / xdg-open / explorer, detached) */
  openBrowser?: (url: string) => void;
  /** this machine's name: the default device-login client name */
  hostname?: () => string;
  /** reads a token piped to `login --token -` */
  readStdin?: () => Promise<string>;
  /** plain project key of a directory (default resolveProjectKey, 5 s); null when git timed out */
  resolveProjectKey?: (cwd: string, opts: { timeoutMs: number }) => Promise<string | null>;
  /** how long write commands wait for worker.lock (default 30 s, C24) */
  lockWaitMs?: number;
}

export class UsageError extends Error {}

type Options = NonNullable<ParseArgsConfig['options']>;

/** Strict option parsing; unknown flags or missing values throw UsageError. */
export function parseOptions<O extends Options>(args: readonly string[], options: O, allowPositionals = false) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return 'unknown';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const nowOf = (deps: Pick<CliDeps, 'now'>): number => deps.now?.() ?? Date.now();

/** Left-aligned columns separated by two spaces (trailing spaces trimmed). */
export function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
}

/** "a, b, c" with at most `max` items, then "… and N more". */
export function listSome(items: readonly string[], max = 10): string {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` … and ${more} more` : ''}`;
}

/** The line every command except `hook`, `init`, `login` and `live` prints while nothing can be recorded (C6). */
export function upgradeBanner(config: CollectorConfig | null): string | null {
  if (!config || config.servers.length) return null;
  return '! not logged in to any ai-obs server: nothing is recorded. Run `ai-obs login --server <url>`.';
}

export const BUSY_MESSAGE = 'the background worker is busy (it may be summarizing); try again in a minute. Nothing was changed.';

/**
 * C24: runs `fn` holding worker.lock (waits up to `lockWaitMs`, default 30 s). Null when the lock could
 * not be taken: the busy message is printed and nothing ran.
 */
export async function withWriteLock<T>(deps: CliDeps, io: Io, fn: () => Promise<T> | T): Promise<{ value: T } | null> {
  const release = await acquireLock(deps.paths.workerLock, deps.lockWaitMs ?? 30_000, 15 * 60_000);
  if (!release) {
    io.err(`✗ ${BUSY_MESSAGE}`);
    return null;
  }
  try {
    return { value: await fn() };
  } finally {
    release();
  }
}

/**
 * Migrates a 0.2 – 0.4 home (config.json v2, projects.json, `o-` / `t-` streams) when the worker lock is free
 * right now, printing what changed; otherwise the background worker does it on its next run. An older copied
 * hook runtime is refreshed first (migrateHome), or nothing is migrated.
 */
export function migrateNow(deps: CliDeps, io: Io): void {
  try {
    if (!needsMigration(deps.paths)) return;
    const release = tryLock(deps.paths.workerLock, 15 * 60_000);
    if (!release) return;
    try {
      const opts = { log: createLogger(deps.paths, 'cli'), now: new Date(nowOf(deps)), ...(deps.installRuntime ? { refreshRuntime: deps.installRuntime } : {}) };
      for (const note of migrateHome(deps.paths, opts)) io.err(`ai-obs: ${note}`);
    } finally {
      release();
    }
  } catch {
    /* the worker retries */
  }
}

/** The queue as streams, with fresh routing (C17) and the drop counters. */
export function openStore(paths: AiObsPaths): QueueStore {
  return new QueueStore(paths.queue, { routing: () => loadRouting(paths), dropped: (d) => recordDropped(paths, d) });
}

/** The device-login page can be opened here: not over SSH; on Linux only with a display. */
export function canOpenBrowser(env: NodeJS.ProcessEnv): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function defaultOpenBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser: the URL is printed anyway */
  }
}

export const defaultHostname = (): string => hostname();

/** Reads all of stdin (a piped token), giving up after `timeoutMs`; '' on a terminal. */
export function readProcessStdin(timeoutMs = 2000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      data += c;
      if (data.length > 4096) finish();
    });
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });
}

/** Strips terminal control characters from server-derived text before it is printed. */
export function terminalSafe(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const control = (c < 0x20 && c !== 0x09) || (c >= 0x7f && c <= 0x9f) || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    if (!control) out += ch;
  }
  return out;
}

// ---------------------------------------------------------------- server state (status, token list, doctor)

export interface ServerState {
  short: string;
  /** refused, expired or failing: data waits */
  problem: boolean;
}

/** STATE column / status line of a server (no network). */
export function serverState(view: RoutingView, deps: CliDeps, s: ServerEntry, nowMs: number): ServerState {
  const st = serverDelivery(readDelivery(deps.paths), s);
  if (isExpired(s, nowMs)) return { short: `EXPIRED: run \`ai-obs login --server ${s.endpoint}\``, problem: true };
  if (st.blocked?.status === 401) return { short: `REJECTED (401, expired or revoked): run \`ai-obs login --server ${s.endpoint}\``, problem: true };
  if (st.blocked?.status === 403) return { short: `refused (403: ${st.blocked.message || 'access denied'}); \`ai-obs flush\` retries`, problem: true };
  if (st.next_attempt_at && Date.parse(st.next_attempt_at) > nowMs) return { short: `retrying (${st.last_error ?? 'send failed'})`, problem: true };
  const days = daysLeft(s, nowMs);
  const expiring = days !== null && days <= 14 ? `; expires in ${days} day${days === 1 ? '' : 's'}: run \`ai-obs login --server ${s.endpoint}\`` : '';
  if (!st.last_success_at) return { short: `never sent${expiring}`, problem: false };
  return { short: `ok, last send ${ago(st.last_success_at, nowMs)}${expiring}`, problem: false };
}

/** "dev@acme.com · SPECTADO · mac-dev, expires 2027-01-22" */
export function describeServer(s: ServerEntry): string {
  const who = s.email ?? (s.source ? 'service user' : '(not checked yet)');
  const exp = s.expires_at ? `expires ${s.expires_at.slice(0, 10)}` : s.source ? 'no expiry' : 'expiry unknown until the next send';
  return [who, s.deployment?.name ?? '(deployment unknown)', `${s.label ? `${s.label}, ` : ''}${exp}`].map(terminalSafe).join(' · ');
}

export const hostOf = endpointHost;

// ---------------------------------------------------------------- queue summary (status, doctor, flush, token, uninstall)

export interface QueueSummary {
  stats: StoreStats;
  /** events in streams that resolve to a usable server (not refused, not expired) */
  sendable: number;
  sendableOldestAt: number | null;
  /** events not sendable now: held streams plus streams of refused or expired servers */
  kept: number;
  /** per endpoint: events in streams that resolve to it (refused / expired ones included) */
  perServer: Record<string, number>;
  /** per endpoint: events waiting because its token is refused or expired */
  blocked: Record<string, number>;
  /** held events per reason */
  byReason: Partial<Record<HeldReason, number>>;
  /** held `no-server` events per stream endpoint ('' = no server chosen) */
  noServer: Record<string, number>;
  /** per project key: queued events */
  byKey: Map<string, number>;
  /** stream directories without a readable stream.json */
  unknown: Array<{ dir: string; events: number }>;
}

/** Resolves every non-empty stream and counts the result. */
export function summarizeQueue(stats: StoreStats, view: RoutingView | null): QueueSummary {
  const s: QueueSummary = { stats, sendable: 0, sendableOldestAt: null, kept: 0, perServer: {}, blocked: {}, byReason: {}, noServer: {}, byKey: new Map(), unknown: [] };
  for (const st of stats.streams) {
    const ref = st.stream;
    const events = st.events;
    if (ref.pk !== undefined) s.byKey.set(ref.pk, (s.byKey.get(ref.pk) ?? 0) + events);
    if (ref.kind === 'unknown') s.unknown.push({ dir: ref.dir, events });
    const r = view ? resolveStream(view, identityOfRef(ref)) : ({ kind: 'held', reason: 'no-server', endpoint: ref.endpoint } as const);
    if (r.kind === 'server') {
      const ep = r.server.endpoint;
      s.perServer[ep] = (s.perServer[ep] ?? 0) + events;
      const usable = view && !Object.prototype.hasOwnProperty.call(view.blocked, endpointHost(ep)) && !isExpired(r.server, view.nowMs);
      if (!usable) {
        s.blocked[ep] = (s.blocked[ep] ?? 0) + events;
        s.kept += events;
      } else {
        s.sendable += events;
        if (st.oldestAt !== null) s.sendableOldestAt = Math.min(s.sendableOldestAt ?? Infinity, st.oldestAt);
      }
      continue;
    }
    s.kept += events;
    s.byReason[r.reason] = (s.byReason[r.reason] ?? 0) + events;
    if (r.reason === 'no-server') s.noServer[r.endpoint ?? ''] = (s.noServer[r.endpoint ?? ''] ?? 0) + events;
  }
  return s;
}

/** Short words for held reasons (status / flush / doctor). */
export const HELD_LABEL: Record<HeldReason, string> = {
  'no-server': 'no server to send to',
  unresolved: 'repository could not be read yet (retried on the next send)',
  'pre-upgrade': 'queued by ai-obs 0.1, never sent',
  legacy: 'recorded by ai-obs 0.4 or older; converted on the next worker run',
  'unknown-stream': 'queue directory without a readable stream.json (`ai-obs doctor`)',
};

/** One line per endpoint whose events wait for a server (status, doctor). */
export function noServerLines(q: QueueSummary): string[] {
  return Object.entries(q.noServer).map(([ep, n]) =>
    ep === ''
      ? `${n} events of repositories without a server (several are registered): run \`ai-obs link --server <url> --team <slug>\` in each`
      : `${n} events for ${ep}, which this machine is not logged in to: run \`ai-obs login --server ${ep}\``,
  );
}
