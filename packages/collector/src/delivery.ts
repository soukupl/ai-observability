import { tokenFingerprint, type TokenEntry } from './config.js';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { AiObsPaths } from './paths.js';

/** A token the server refused with 401 / 403: its streams stay queued until a manual flush or doctor succeeds (§3.3). */
export interface Blocked {
  status: 401 | 403;
  at: string;
  /** the response `error`, e.g. "company is suspended" */
  message: string;
}

/** Delivery state of one token (state/delivery.json `tokens[<name>]`). */
export interface TokenDeliveryState {
  /** fingerprint of the token this state belongs to; a replaced token starts fresh */
  token_fp: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  /** automatic flushes wait until this time after failures; `ai-obs flush` ignores it */
  next_attempt_at: string | null;
  last_result: { accepted: number; duplicates: number; rejected: number } | null;
  blocked: Blocked | null;
}

export interface DeliveryFile {
  v: 2;
  tokens: Record<string, TokenDeliveryState>;
}

/** Cap drop counters (state/dropped.json), cumulative (C13); `shown_at` comes from state/dropped-shown.json. */
export interface DroppedCounters {
  held_events: number;
  sendable_events: number;
  last_at: string | null;
  /** when the SessionStart text last mentioned the drops */
  shown_at: string | null;
}

const TOKEN_NAME_SHAPE = /^[a-z0-9-]{1,63}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function freshState(fp: string): TokenDeliveryState {
  return {
    token_fp: fp,
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    next_attempt_at: null,
    last_result: null,
    blocked: null,
  };
}

function parseBlocked(v: unknown): Blocked | null {
  if (!isObject(v) || (v.status !== 401 && v.status !== 403)) return null;
  return { status: v.status, at: str(v.at) ?? new Date(0).toISOString(), message: str(v.message) ?? '' };
}

function parseState(v: unknown): TokenDeliveryState | null {
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
  };
}

/** state/delivery.json; the flat 0.1.x file, garbage or a missing file read as empty. Never throws. */
export function readDelivery(paths: Pick<AiObsPaths, 'delivery'>): DeliveryFile {
  const raw = readJsonFile<unknown>(paths.delivery);
  const out: DeliveryFile = { v: 2, tokens: {} };
  if (!isObject(raw) || raw.v !== 2 || !isObject(raw.tokens)) return out;
  for (const [name, v] of Object.entries(raw.tokens)) {
    if (!TOKEN_NAME_SHAPE.test(name)) continue;
    const st = parseState(v);
    if (st) out.tokens[name] = st;
  }
  return out;
}

/** The token's state when it belongs to this token (fingerprint), else a fresh one. */
export function tokenDelivery(file: DeliveryFile, entry: TokenEntry): TokenDeliveryState {
  const fp = tokenFingerprint(entry.token);
  const st = Object.prototype.hasOwnProperty.call(file.tokens, entry.name) ? file.tokens[entry.name] : undefined;
  return st && st.token_fp === fp ? st : freshState(fp);
}

/** Read-modify-write of one token's state (atomic). Returns the new state. */
export function writeTokenDelivery(
  paths: Pick<AiObsPaths, 'delivery'>,
  entry: TokenEntry,
  patch: Partial<Omit<TokenDeliveryState, 'token_fp'>>,
): TokenDeliveryState {
  const file = readDelivery(paths);
  const next = { ...tokenDelivery(file, entry), ...patch, token_fp: tokenFingerprint(entry.token) };
  file.tokens[entry.name] = next;
  writeJsonAtomic(paths.delivery, file, 0o600);
  return next;
}

export function clearBlocked(paths: Pick<AiObsPaths, 'delivery'>, entry: TokenEntry): void {
  const file = readDelivery(paths);
  if (tokenDelivery(file, entry).blocked) writeTokenDelivery(paths, entry, { blocked: null });
}

export function dropTokenDelivery(paths: Pick<AiObsPaths, 'delivery'>, name: string): void {
  const file = readDelivery(paths);
  if (!Object.prototype.hasOwnProperty.call(file.tokens, name)) return;
  delete file.tokens[name];
  writeJsonAtomic(paths.delivery, file, 0o600);
}

export function renameTokenDelivery(paths: Pick<AiObsPaths, 'delivery'>, from: string, to: string): void {
  if (from === to) return;
  const file = readDelivery(paths);
  const st = file.tokens[from];
  if (!st) return;
  delete file.tokens[from];
  file.tokens[to] = st;
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
  if (!isObject(raw)) return { held_events: 0, sendable_events: 0, last_at: null, shown_at: shownAt };
  return { held_events: count(raw.held_events), sendable_events: count(raw.sendable_events), last_at: str(raw.last_at), shown_at: shownAt };
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
  const { shown_at: _s, ...counters } = next;
  writeJsonAtomic(paths.dropped, counters, 0o600);
  return next;
}

/** The hook mentioned the drops in a SessionStart text (its own file: the counters are never rewritten here). */
export function markDroppedShown(paths: Pick<AiObsPaths, 'dropped'>, now: Date = new Date()): void {
  writeJsonAtomic(droppedShownPath(paths), { shown_at: now.toISOString() }, 0o600);
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
