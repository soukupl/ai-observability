import { readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { HarnessAdapter } from '../adapters/types.js';
import type { CollectorConfig } from '../config.js';
import { recordDropped } from '../delivery.js';
import { ensureDir, readJsonFile, writeJsonAtomic } from '../fsutil.js';
import type { Transport } from '../http.js';
import { acquireLock } from '../lock.js';
import type { AiObsPaths } from '../paths.js';
import { loadRouting, resolveStream, type HeldReason, type RoutingView } from '../projects.js';
import { EventQueue, identityOfRef, QueueStore, type StoreStats } from '../queue.js';
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
  /** wait used by the 429 retry of `init` / `token add` / `token confirm` */
  sleep?: (ms: number) => Promise<void>;
  /** wall clock in ms */
  now?: () => number;
  /** starts the background worker after `use` / `token confirm` (default: hook.ts defaultSpawnWorker) */
  spawnWorker?: (paths: AiObsPaths) => void;
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

/**
 * C6: the line every command except `hook` prints while nothing can be recorded. Null when config.json
 * is missing (commands say "not configured") or at least one valid token is registered.
 */
export function upgradeBanner(config: CollectorConfig | null): string | null {
  if (!config || config.tokens.length) return null;
  if (config.legacyToken) {
    return `! ai-obs 0.2 no longer accepts the token from before the upgrade (${config.legacyToken}): create a user token (My tokens) or a company token (Settings → Tokens) in the dashboard and run \`ai-obs init --token <token>\`. Nothing is recorded until then.`;
  }
  return '! no tokens registered: nothing is recorded. Run `ai-obs init --token <token> --endpoint <url>`.';
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

/** The queue as streams, with fresh routing (C17) and the drop counters. */
export function openStore(paths: AiObsPaths): QueueStore {
  return new QueueStore(paths.queue, { routing: () => loadRouting(paths), dropped: (d) => recordDropped(paths, d) });
}

// ---------------------------------------------------------------- queue summary (status, doctor, flush, token, uninstall)

export interface QueueSummary {
  stats: StoreStats;
  /** events in streams that resolve to a usable, non-blocked token */
  sendable: number;
  sendableOldestAt: number | null;
  /** events not sendable now: held streams plus streams of blocked tokens */
  kept: number;
  /** per token name: events in streams that resolve to it (blocked ones included) */
  perToken: Record<string, number>;
  /** per blocked token name: its events */
  blocked: Record<string, number>;
  /** held events per reason (bound streams of removed tokens are counted as `dangling`) */
  byReason: Partial<Record<HeldReason, number>>;
  /** open project streams waiting for a choice (unassigned, or a choice that points nowhere) */
  waiting: { keys: string[]; events: number };
  /** events of streams bound to tokens that are no longer registered */
  danglingBound: number;
  /** stream directories without a readable stream.json */
  unknown: Array<{ dir: string; events: number }>;
  /** per project key: open events and bound events (for `use` / status) */
  byKey: Map<string, { open: number; bound: number }>;
}

/** Resolves every non-empty stream with table B (design §3.2) and counts the result. */
export function summarizeQueue(stats: StoreStats, view: RoutingView | null): QueueSummary {
  const s: QueueSummary = {
    stats,
    sendable: 0,
    sendableOldestAt: null,
    kept: 0,
    perToken: {},
    blocked: {},
    byReason: {},
    waiting: { keys: [], events: 0 },
    danglingBound: 0,
    unknown: [],
    byKey: new Map(),
  };
  const waitingKeys = new Set<string>();
  for (const st of stats.streams) {
    const ref = st.stream;
    const events = st.events;
    if (ref.pk !== undefined) {
      const k = s.byKey.get(ref.pk) ?? { open: 0, bound: 0 };
      if (ref.bind?.kind === 'open') k.open += events;
      else k.bound += events;
      s.byKey.set(ref.pk, k);
    }
    if (ref.kind === 'unknown') s.unknown.push({ dir: ref.dir, events });
    const r = view ? resolveStream(view, identityOfRef(ref)) : ({ kind: 'held', reason: 'no-tokens' } as const);
    if (r.kind === 'token') {
      s.perToken[r.token.name] = (s.perToken[r.token.name] ?? 0) + events;
      if (view && Object.prototype.hasOwnProperty.call(view.blocked, r.token.name)) {
        s.blocked[r.token.name] = (s.blocked[r.token.name] ?? 0) + events;
        s.kept += events;
      } else {
        s.sendable += events;
        if (st.oldestAt !== null) s.sendableOldestAt = Math.min(s.sendableOldestAt ?? Infinity, st.oldestAt);
      }
      continue;
    }
    s.kept += events;
    s.byReason[r.reason] = (s.byReason[r.reason] ?? 0) + events;
    if (r.reason === 'dangling' && ref.bind?.kind === 'token') s.danglingBound += events;
    else if ((r.reason === 'unassigned' || r.reason === 'dangling') && ref.pk !== undefined) {
      waitingKeys.add(ref.pk);
      s.waiting.events += events;
    }
  }
  s.waiting.keys = [...waitingKeys];
  return s;
}

/** Short words for held reasons other than "waiting for a token" (status / flush). */
export const HELD_LABEL: Record<HeldReason, string> = {
  'no-tokens': 'no token registered',
  'projects-unreadable': 'projects.json cannot be read',
  unassigned: 'waiting for a token',
  dangling: 'recorded with a token that is no longer registered',
  unverified: 'token not confirmed (`ai-obs token list`)',
  'company-mismatch': 'token reports another company (`ai-obs token list`)',
  'opted-out': 'repositories not reported (`use --none`)',
  'pre-upgrade': 'queued before the upgrade, never sent: tokens were reset',
  unresolved: 'repository could not be read yet (retried on the next send)',
  'unknown-stream': 'queue directory without a readable stream.json (`ai-obs doctor`)',
};

// ---------------------------------------------------------------- pre-upgrade data (owner decision 3)

/** state/pre-upgrade.json: what the first registration moved aside, and whether status / doctor said so. */
interface PreUpgradeNote {
  moved_at: string;
  batches: number;
  events: number;
  dir: string;
  shown_at: string | null;
}

export const preUpgradeNotePath = (paths: Pick<AiObsPaths, 'state'>) => join(paths.state, 'pre-upgrade.json');

/**
 * Moves the root `queue/*.ndjson` segments (written by the 0.1.x collector) to queue/dead/pre-upgrade/:
 * they are never sent, because every pre-upgrade token was reset (owner decision 3). Run by every
 * successful registration under the worker lock; returns what was moved now (null when nothing).
 */
export function movePreUpgrade(paths: AiObsPaths, now: Date): { batches: number; events: number } | null {
  const root = new EventQueue(paths.queue, { autoCap: false });
  const segs = root.segments();
  if (!segs.length) return null;
  ensureDir(paths.deadPreUpgrade);
  let batches = 0;
  let events = 0;
  for (const seg of segs) {
    const n = root.countEvents(seg.file);
    try {
      renameSync(join(paths.queue, seg.file), join(paths.deadPreUpgrade, seg.file));
    } catch {
      continue;
    }
    batches++;
    events += n;
  }
  if (!batches) return null;
  const prev = readJsonFile<Partial<PreUpgradeNote>>(preUpgradeNotePath(paths));
  const note: PreUpgradeNote = {
    moved_at: now.toISOString(),
    batches: (typeof prev?.batches === 'number' ? prev.batches : 0) + batches,
    events: (typeof prev?.events === 'number' ? prev.events : 0) + events,
    dir: paths.deadPreUpgrade,
    shown_at: null,
  };
  try {
    writeJsonAtomic(preUpgradeNotePath(paths), note, 0o600);
  } catch {
    /* the note is informational */
  }
  return { batches, events };
}

/** Number of segment files in queue/dead/pre-upgrade. */
function preUpgradeBatches(paths: AiObsPaths): number {
  try {
    return readdirSync(paths.deadPreUpgrade).filter((f) => f.endsWith('.ndjson')).length;
  } catch {
    return 0;
  }
}

/**
 * The pre-upgrade line, once (owner decision 3): the first `status` or `doctor` after the move prints it
 * and marks it shown. Null when there is nothing (left) to say.
 */
export function takePreUpgradeNote(paths: AiObsPaths, now: Date): string | null {
  const note = readJsonFile<Partial<PreUpgradeNote>>(preUpgradeNotePath(paths));
  if (!note || note.shown_at) return null;
  const batches = preUpgradeBatches(paths);
  if (!batches) return null;
  try {
    writeJsonAtomic(preUpgradeNotePath(paths), { ...note, shown_at: now.toISOString() }, 0o600);
  } catch {
    /* shown again next time */
  }
  return `${batches} pre-upgrade batches kept in ${paths.deadPreUpgrade}, not sent: tokens were reset (delete the directory when you no longer need them)`;
}
