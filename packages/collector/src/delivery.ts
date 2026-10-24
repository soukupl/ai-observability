import { endpointHost, tokenFingerprint, type ServerEntry } from './config.js';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { AiObsPaths } from './paths.js';

/** A server that refused the token with 401 / 403: its streams stay queued until a new login, a manual flush or doctor succeeds. */
export interface Blocked {
  status: 401 | 403;
  at: string;
  message: string;
}

/** Repositories (plain project keys, local only) delivered to a server, with the last send; at most MAX_REPOS. */
export type SeenRepos = Record<string, string>;
export const MAX_REPOS = 200;

/** Delivery state of one server (state/delivery.json `servers[<host>]`). */
export interface ServerDeliveryState {
  /** fingerprint of the token this state belongs to; a new login starts fresh (the blocked flag goes with it) */
  token_fp: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  /** automatic flushes wait until this time after failures; `ai-obs flush` ignores it */
  next_attempt_at: string | null;
  last_result: { accepted: number; duplicates: number; rejected: number } | null;
  blocked: Blocked | null;
  /** repositories delivered (token list REPOSITORIES); kept across logins */
  repos: SeenRepos;
}

export interface DeliveryFile {
  v: 3;
  servers: Record<string, ServerDeliveryState>;
}

/** Cap drop counters (state/dropped.json), cumulative (C13); `shown_at` comes from state/dropped-shown.json. */
export interface DroppedCounters {
  held_events: number;
  sendable_events: number;
  last_at: string | null;
  /** when the SessionStart text last mentioned the drops */
  shown_at: string | null;
  /** the two counters when the SessionStart text last mentioned them (it reports only what came since) */
  shown_held: number;
  shown_sendable: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function freshState(fp: string, repos: SeenRepos = {}): ServerDeliveryState {
  return {
    token_fp: fp,
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    next_attempt_at: null,
    last_result: null,
    blocked: null,
    repos,
  };
}

function parseBlocked(v: unknown): Blocked | null {
  if (!isObject(v) || (v.status !== 401 && v.status !== 403)) return null;
  return { status: v.status, at: str(v.at) ?? new Date(0).toISOString(), message: str(v.message) ?? '' };
}

function parseRepos(v: unknown): SeenRepos {
  const out: SeenRepos = {};
  if (!isObject(v)) return out;
  for (const [k, at] of Object.entries(v)) if (k && typeof at === 'string') out[k] = at;
  return out;
}

function parseState(v: unknown): ServerDeliveryState | null {
  if (!isObject(v) || typeof v.token_fp !== 'string') return null;
  const r = v.last_result;
  return {
    token_fp: v.token_fp,
    last_attempt_at: str(v.last_attempt_at),
    last_success_at: str(v.last_success_at),
    last_error: str(v.last_error),
    consecutive_failures: count(v.consecutive_failures),
    next_attempt_at: str(v.next_attempt_at),
    last_result: isObject(r) ? { accepted: count(r.accepted), duplicates: count(r.duplicates), rejected: count(r.rejected) } : null,
    blocked: parseBlocked(v.blocked),
    repos: parseRepos(v.repos),
  };
}

/** state/delivery.json; a 0.2 – 0.4 (per token name) file, garbage or a missing file read as empty. Never throws. */
export function readDelivery(paths: Pick<AiObsPaths, 'delivery'>): DeliveryFile {
  const raw = readJsonFile<unknown>(paths.delivery);
  const out: DeliveryFile = { v: 3, servers: {} };
  if (!isObject(raw) || raw.v !== 3 || !isObject(raw.servers)) return out;
  for (const [host, v] of Object.entries(raw.servers)) {
    const st = parseState(v);
    if (st) out.servers[host] = st;
  }
  return out;
}

/** The server's state when it belongs to its current token (fingerprint), else a fresh one (repositories kept). */
export function serverDelivery(file: DeliveryFile, entry: Pick<ServerEntry, 'endpoint' | 'token'>): ServerDeliveryState {
  const fp = tokenFingerprint(entry.token);
  const host = endpointHost(entry.endpoint);
  const st = Object.prototype.hasOwnProperty.call(file.servers, host) ? file.servers[host] : undefined;
  if (st && st.token_fp === fp) return st;
  return freshState(fp, st?.repos ?? {});
}

/** Read-modify-write of one server's state (atomic). Returns the new state. */
export function writeServerDelivery(
  paths: Pick<AiObsPaths, 'delivery'>,
  entry: Pick<ServerEntry, 'endpoint' | 'token'>,
  patch: Partial<Omit<ServerDeliveryState, 'token_fp'>>,
): ServerDeliveryState {
  const file = readDelivery(paths);
  const next = { ...serverDelivery(file, entry), ...patch, token_fp: tokenFingerprint(entry.token) };
  const repos = Object.entries(next.repos).sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, MAX_REPOS);
  next.repos = Object.fromEntries(repos);
  file.servers[endpointHost(entry.endpoint)] = next;
  writeJsonAtomic(paths.delivery, file, 0o600);
  return next;
}

export function clearBlocked(paths: Pick<AiObsPaths, 'delivery'>, entry: Pick<ServerEntry, 'endpoint' | 'token'>): void {
  const file = readDelivery(paths);
  if (serverDelivery(file, entry).blocked) writeServerDelivery(paths, entry, { blocked: null });
}

export function dropServerDelivery(paths: Pick<AiObsPaths, 'delivery'>, endpoint: string): void {
  const file = readDelivery(paths);
  const host = endpointHost(endpoint);
  if (!Object.prototype.hasOwnProperty.call(file.servers, host)) return;
  delete file.servers[host];
  writeJsonAtomic(paths.delivery, file, 0o600);
}

/**
 * When the hook last showed the drops: a file of its own (state/dropped-shown.json), so the hook (no lock)
 * and the worker's recordDropped (under worker.lock) never write the same file (no lost update, C13).
 */
const droppedShownPath = (paths: Pick<AiObsPaths, 'dropped'>) => paths.dropped.replace(/\.json$/, '') + '-shown.json';

export function readDropped(paths: Pick<AiObsPaths, 'dropped'>): DroppedCounters {
  const raw = readJsonFile<unknown>(paths.dropped);
  const shown = readJsonFile<unknown>(droppedShownPath(paths));
  const shownAt = [isObject(raw) ? str(raw.shown_at) : null, isObject(shown) ? str(shown.shown_at) : null]
    .filter((x): x is string => x !== null)
    .sort()
    .at(-1) ?? null;
  const shownHeld = isObject(shown) ? count(shown.held_events) : 0;
  const shownSendable = isObject(shown) ? count(shown.sendable_events) : 0;
  const marks = { shown_at: shownAt, shown_held: shownHeld, shown_sendable: shownSendable };
  if (!isObject(raw)) return { held_events: 0, sendable_events: 0, last_at: null, ...marks };
  return { held_events: count(raw.held_events), sendable_events: count(raw.sendable_events), last_at: str(raw.last_at), ...marks };
}

/** Adds this cap run's drops to the cumulative counters (no write when both are 0). Called under worker.lock. */
export function recordDropped(paths: Pick<AiObsPaths, 'dropped'>, drops: { held: number; sendable: number }, now: Date = new Date()): DroppedCounters {
  const cur = readDropped(paths);
  if (drops.held <= 0 && drops.sendable <= 0) return cur;
  const next: DroppedCounters = {
    ...cur,
    held_events: cur.held_events + Math.max(0, drops.held),
    sendable_events: cur.sendable_events + Math.max(0, drops.sendable),
    last_at: now.toISOString(),
  };
  const { shown_at: _s, shown_held: _h, shown_sendable: _p, ...counters } = next;
  writeJsonAtomic(paths.dropped, counters, 0o600);
  return next;
}

/**
 * The hook mentioned the drops in a SessionStart text, at these counter values (its own file: the counters are
 * never rewritten here).
 */
export function markDroppedShown(
  paths: Pick<AiObsPaths, 'dropped'>,
  now: Date = new Date(),
  counters?: Pick<DroppedCounters, 'held_events' | 'sendable_events'>,
): void {
  writeJsonAtomic(
    droppedShownPath(paths),
    { shown_at: now.toISOString(), held_events: counters?.held_events ?? 0, sendable_events: counters?.sendable_events ?? 0 },
    0o600,
  );
}

/** Total events the caps dropped (kept + sendable), for status / doctor / the hook (C13). */
export function droppedTotal(d: DroppedCounters): number {
  return d.held_events + d.sendable_events;
}

/** The status / doctor line for the drop counters, or null when nothing was dropped. */
export function droppedLine(d: DroppedCounters): string | null {
  const parts: string[] = [];
  if (d.held_events > 0) parts.push(`${d.held_events} kept events were dropped by the 50 MB cap`);
  if (d.sendable_events > 0) parts.push(`${d.sendable_events} events that could not be sent were dropped by the 30-day / 50 MB queue caps`);
  if (!parts.length) return null;
  return `${parts.join('; ')}${d.last_at ? ` (last ${d.last_at.slice(0, 10)})` : ''}`;
}
