import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, errorMessage, readJsonFile, writeFileAtomic, writeJsonAtomic } from './fsutil.js';
import { nullLogger, type Logger } from './log.js';
import { isPathKey } from './project-key.js';
import {
  keyDirName,
  legacyTarget,
  resolveStream,
  sendableNow,
  streamDirName,
  unresolvedDirName,
  upgradeStreamKey,
  type RoutingView,
  type StreamIdentity,
  type StreamKey,
  type StreamTarget,
} from './routing.js';
import { TEAM_SLUG_RE } from './protocol-types.js';
import type { CollectorConfig } from './config.js';
import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS, type IngestEvent } from './protocol-types.js';
import { decodeTime, ulid } from './ulid.js';

export interface QueueOptions {
  /** total queue cap; oldest segments are dropped first (default 50 MB) */
  maxBytes?: number;
  /** segments older than this are dropped (default 30 days) */
  maxAgeMs?: number;
  /** start a new segment once the newest one reaches this size (default 1 MB) */
  segmentBytes?: number;
  log?: Logger;
  now?: () => number;
  /** enforce the caps after each enqueue (default true; streams opened by a QueueStore pass false: the store caps) */
  autoCap?: boolean;
  /** where refused batches go (default `<dir>/dead`; the store uses the shared queue/dead) */
  deadDir?: string;
}

export interface BatchLimits {
  maxEvents?: number;
  /** uncompressed JSON bytes of the whole batch */
  maxBytes?: number;
}

interface SegmentCursor {
  file: string;
  /** lines (incl. dropped corrupt ones) consumed from the start of the file */
  consumedLines: number;
}

export interface QueueBatch {
  events: IngestEvent[];
  /** uncompressed byte estimate of the events array */
  bytes: number;
  readonly cursor: readonly SegmentCursor[];
}

export interface QueueStats {
  files: number;
  bytes: number;
  events: number;
  oldestAt: number | null;
}

/** Room left in a batch for the envelope (schema, collector, machine, identity). */
const ENVELOPE_RESERVE = 4096;

export interface SegmentInfo {
  file: string;
  size: number;
  createdAt: number;
}
const SEGMENT_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.ndjson$/;

/**
 * Append-only NDJSON event queue under ~/.ai-obs/queue (ADR-0011). Segments are named by ULID, so
 * name order = age order. Callers serialize mutation through the worker lock; even so, ack() re-reads
 * a partially sent segment and keeps any lines appended since readBatch().
 */
export class EventQueue {
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly segmentBytes: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly autoCap: boolean;
  private readonly deadDir: string;

  constructor(
    readonly dir: string,
    opts: QueueOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 3600_000;
    this.segmentBytes = opts.segmentBytes ?? 1024 * 1024;
    this.log = opts.log ?? nullLogger;
    this.now = opts.now ?? Date.now;
    this.autoCap = opts.autoCap ?? true;
    this.deadDir = opts.deadDir ?? join(dir, 'dead');
  }

  /** Appends events (one write per call) and enforces the cap (unless `autoCap` is false). */
  enqueue(events: readonly IngestEvent[]): void {
    if (!events.length) return;
    ensureDir(this.dir);
    const data = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const segments = this.segments();
    const newest = segments.at(-1);
    const target =
      newest && newest.size + data.length <= this.segmentBytes ? newest.file : `${ulid(this.now())}.ndjson`;
    appendFileSync(join(this.dir, target), data, { mode: 0o600 });
    if (this.autoCap) this.enforceCap();
  }

  /** Oldest-first batch of at most `maxEvents` events / `maxBytes` bytes, or null when empty. */
  readBatch(limits: BatchLimits = {}): QueueBatch | null {
    const maxEvents = limits.maxEvents ?? MAX_BATCH_EVENTS;
    const maxBytes = (limits.maxBytes ?? MAX_BATCH_BYTES) - ENVELOPE_RESERVE;
    const events: IngestEvent[] = [];
    const cursor: SegmentCursor[] = [];
    let bytes = 2;

    for (const seg of this.segments()) {
      const lines = this.readLines(seg.file);
      let consumed = 0;
      let full = false;
      for (const line of lines) {
        if (events.length >= maxEvents) {
          full = true;
          break;
        }
        const size = Buffer.byteLength(line) + 1;
        if (!line.trim()) {
          consumed++;
          continue;
        }
        let event: IngestEvent;
        try {
          event = JSON.parse(line) as IngestEvent;
        } catch {
          this.log.warn('queue: dropping corrupt line', { segment: seg.file });
          consumed++;
          continue;
        }
        if (size > maxBytes) {
          this.log.warn('queue: dropping event larger than a batch', { event_id: event.event_id, bytes: size });
          consumed++;
          continue;
        }
        if (bytes + size > maxBytes) {
          full = true;
          break;
        }
        events.push(event);
        bytes += size;
        consumed++;
      }
      if (consumed) cursor.push({ file: seg.file, consumedLines: consumed });
      if (full) break;
    }
    if (!events.length && !cursor.length) return null;
    return { events, bytes, cursor };
  }

  /** Removes a delivered batch: whole segments are deleted, a partial one is rewritten atomically. */
  ack(batch: QueueBatch): void {
    for (const c of batch.cursor) {
      const path = join(this.dir, c.file);
      const lines = this.readLines(c.file);
      const rest = lines.slice(c.consumedLines).filter((l) => l.trim());
      if (!rest.length) rmSync(path, { force: true });
      else writeFileAtomic(path, rest.join('\n') + '\n');
    }
  }

  /** Moves a batch the server refused as a whole into dead/ (capped at 5 MB) and acks it. `meta` is added to the log line. */
  deadLetter(batch: QueueBatch, reason: string, meta: Record<string, unknown> = {}): void {
    const deadDir = this.deadDir;
    try {
      ensureDir(deadDir);
      const body = batch.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      writeFileAtomic(join(deadDir, `${ulid(this.now())}.ndjson`), body);
      const dead = this.segments(deadDir);
      let total = dead.reduce((s, d) => s + d.size, 0);
      for (const d of dead) {
        if (total <= 5 * 1024 * 1024) break;
        rmSync(join(deadDir, d.file), { force: true });
        total -= d.size;
      }
    } catch (err) {
      this.log.error('queue: dead-letter write failed', { error: String(err) });
    }
    this.log.warn('queue: batch dead-lettered', { ...meta, events: batch.events.length, reason: reason.slice(0, 200) });
    this.ack(batch);
  }

  /** Drops segments older than maxAge, then oldest segments until under maxBytes. Logged. */
  enforceCap(): { droppedFiles: number; droppedBytes: number } {
    const segments = this.segments();
    let total = segments.reduce((s, x) => s + x.size, 0);
    let droppedFiles = 0;
    let droppedBytes = 0;
    const cutoff = this.now() - this.maxAgeMs;
    for (const seg of segments) {
      const tooOld = seg.createdAt < cutoff;
      // Never drop the newest segment for size: it holds what was just written.
      const tooBig = total > this.maxBytes && seg !== segments.at(-1);
      if (!tooOld && !tooBig) continue;
      rmSync(join(this.dir, seg.file), { force: true });
      total -= seg.size;
      droppedFiles++;
      droppedBytes += seg.size;
    }
    if (droppedFiles) this.log.warn('queue: cap reached, dropped oldest segments', { droppedFiles, droppedBytes });
    return { droppedFiles, droppedBytes };
  }

  stats(): QueueStats {
    const segments = this.segments();
    let events = 0;
    for (const s of segments) events += this.readLines(s.file).filter((l) => l.trim()).length;
    return {
      files: segments.length,
      bytes: segments.reduce((s, x) => s + x.size, 0),
      events,
      oldestAt: segments[0]?.createdAt ?? null,
    };
  }

  /** Segment files of this queue, oldest first (name order = age order). */
  segments(dir = this.dir): SegmentInfo[] {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => SEGMENT_RE.test(n))
      .sort()
      .flatMap((file) => {
        try {
          const st = statSync(join(dir, file));
          return [{ file, size: st.size, createdAt: decodeTime(file) }];
        } catch {
          return [];
        }
      });
  }

  /** Non-empty lines of one segment (what a cap drop loses). */
  countEvents(file: string): number {
    return this.readLines(file).filter((l) => l.trim()).length;
  }

  private readLines(file: string): string[] {
    try {
      const text = readFileSync(join(this.dir, file), 'utf8');
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines;
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------- streams (brief appendix E)

export { streamDirName, unresolvedDirName };
export type { StreamKey };

/**
 * One stream directory: `p/s-<id>/` (project), `u/s-<id>/` (unresolved), the root segments (0.1.x,
 * pre-upgrade), a 0.2 – 0.4 directory (`p|u/o-`, `t-`) waiting for the migration, or a directory we cannot
 * read (unknown).
 */
export interface StreamRef {
  kind: 'project' | 'unresolved' | 'pre-upgrade' | 'legacy' | 'unknown';
  dir: string;
  pk?: string;
  cwd?: string;
  endpoint?: string;
  team?: string;
}
export interface StreamStats extends QueueStats {
  stream: StreamRef;
}
/** Totals over all streams plus the non-empty streams. */
export interface StoreStats extends QueueStats {
  streams: StreamStats[];
}
/** Receives the events a cap run dropped (state/dropped.json, C13). */
export type DroppedRecorder = (drops: { held: number; sendable: number }) => void;
export interface CapResult {
  droppedFiles: number;
  droppedBytes: number;
  droppedEvents: number;
  /** of droppedEvents: events of streams that could not be sent now */
  droppedHeldEvents: number;
}
export interface StoreOptions extends QueueOptions {
  /** fresh routing per call (loadRouting, C17); null = not configured */
  routing: () => RoutingView | null;
  dropped?: DroppedRecorder;
}
export interface LegacyMigration {
  /** 0.2 – 0.4 stream directories converted */
  streams: number;
  events: number;
  /** of `events`: converted to streams with no server chosen (several servers registered) */
  unassignedEvents: number;
}

const STREAM_FILE = 'stream.json';
/** A stream not observed for longer than this starts a new sendable period (observe, C13). */
export const SEEN_GAP_MS = 2 * 24 * 3600_000;
/** `seen_at` of a stream whose state did not change is rewritten at most this often. */
const SEEN_REFRESH_MS = 3600_000;
/** A `.tmp-*` stream directory older than this was left by a crash and is removed by prune(). */
const TMP_STALE_MS = 10 * 60_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTeam = (v: unknown): v is string => v === '' || (typeof v === 'string' && TEAM_SLUG_RE.test(v));

/** The routing identity of a stream directory. */
export function identityOfRef(ref: StreamRef): StreamIdentity {
  if (ref.kind === 'project' && ref.pk !== undefined && ref.endpoint !== undefined && ref.team !== undefined)
    return { kind: 'project', pk: ref.pk, endpoint: ref.endpoint, team: ref.team };
  if (ref.kind === 'unresolved' && ref.cwd !== undefined && ref.endpoint !== undefined && ref.team !== undefined)
    return { kind: 'unresolved', cwd: ref.cwd, endpoint: ref.endpoint, team: ref.team };
  if (ref.kind === 'pre-upgrade') return { kind: 'pre-upgrade' };
  if (ref.kind === 'legacy') return { kind: 'legacy' };
  return { kind: 'unknown' };
}

/** A project key as it may appear in the log: never a local path. */
export function loggableKey(pk: string | undefined): string | undefined {
  if (pk === undefined) return undefined;
  return isPathKey(pk) ? '(local path)' : pk;
}

/**
 * The queue as streams keyed by (project key, server endpoint, team) (brief appendix E). Each stream is an
 * EventQueue directory with a `stream.json`; root segments are the frozen pre-upgrade stream, which no API
 * writes. Mutation is serialized by the worker lock, like EventQueue. The store enforces the caps across
 * all streams: the 30-day age cap only for streams that can be sent now (a registered server whose token is
 * neither refused nor expired), counted from when they became sendable; the size cap for all (C13).
 */
export class QueueStore {
  readonly projectsDir: string;
  readonly unresolvedDir: string;
  readonly deadDir: string;
  private readonly opts: StoreOptions;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;

  constructor(
    readonly root: string,
    opts: StoreOptions,
  ) {
    this.opts = opts;
    this.projectsDir = join(root, 'p');
    this.unresolvedDir = join(root, 'u');
    this.deadDir = join(root, 'dead');
    this.log = opts.log ?? nullLogger;
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 3600_000;
  }

  /**
   * Appends events to the key's stream (created on first use) and enforces the caps. A null key (no cwd,
   * C16; nothing to record) drops the events (logged). A key stored by 0.2 – 0.4 is converted first.
   */
  enqueue(events: readonly IngestEvent[], rawKey: StreamKey | null): void {
    if (!events.length) return;
    const key = this.current(rawKey);
    if (!key) {
      this.log.warn('queue: events without a stream key dropped', { count: events.length });
      return;
    }
    let ref = this.ensure(key);
    if (!ref) {
      this.log.error('queue: stream directory unusable, events dropped', { count: events.length });
      return;
    }
    try {
      this.stream(ref).enqueue(events);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      ref = this.ensure(key); // pruned between ensure and append
      if (!ref) return;
      this.stream(ref).enqueue(events);
    }
    this.enforceCap(ref);
  }

  /** Non-empty streams, oldest first (by their oldest segment). */
  streams(): StreamRef[] {
    return this.scan(false).map((x) => x.ref);
  }

  /** The stream as an EventQueue (no auto cap: the store caps; refused batches go to the shared queue/dead). */
  stream(ref: StreamRef): EventQueue {
    const { routing: _r, dropped: _d, ...q } = this.opts;
    return new EventQueue(ref.dir, { ...q, autoCap: false, deadDir: this.deadDir });
  }

  /** An unresolved stream whose key is now known moves into its project stream (same server and team). */
  adopt(ref: StreamRef, pk: string): void {
    if (ref.kind !== 'unresolved' || ref.endpoint === undefined || ref.team === undefined) return;
    const target = this.ensure({ kind: 'project', pk, endpoint: ref.endpoint, team: ref.team });
    if (!target) return;
    this.moveSegments(ref.dir, target.dir);
    rmSync(ref.dir, { recursive: true, force: true });
  }

  /**
   * `ai-obs link`: the key's streams recorded while no server was chosen (endpoint '') move into the stream
   * of the linked server and team. Streams already bound to a server keep it (capture-time pinning).
   * Returns the number of events moved.
   */
  retarget(pk: string, to: StreamTarget): number {
    if (to.endpoint === '') return 0;
    const sources = this.scan(false).filter((x) => x.ref.kind === 'project' && x.ref.pk === pk && x.ref.endpoint === '');
    if (!sources.length) return 0;
    const target = this.ensure({ kind: 'project', pk, ...to });
    if (!target) return 0;
    let moved = 0;
    for (const { ref } of sources) {
      if (ref.dir === target.dir) continue;
      moved += this.moveSegments(ref.dir, target.dir);
      rmSync(ref.dir, { recursive: true, force: true });
    }
    if (moved) this.log.info('queue: events of a repository without a server moved to its linked server', { events: moved, project: loggableKey(pk) });
    return moved;
  }

  /**
   * Converts the 0.2 – 0.4 stream directories (`o-` open, `t-` token-bound; under p/ and u/) into `s-`
   * streams (brief appendix E): a token binding becomes its endpoint with no team, an open stream the only
   * server or, with several, no server ('' → held `no-server` until `ai-obs link`). Segments keep their
   * ULID names, so time order and event ids are unchanged. A directory without a readable stream.json is
   * left as it is. Caller holds the worker lock.
   */
  migrateLegacy(config: Pick<CollectorConfig, 'servers'>): LegacyMigration {
    const out: LegacyMigration = { streams: 0, events: 0, unassignedEvents: 0 };
    for (const [parent, kind] of [
      [this.projectsDir, 'project'],
      [this.unresolvedDir, 'unresolved'],
    ] as const) {
      for (const name of this.dirNames(parent)) {
        if (!/^[ot]-/.test(name)) continue;
        const dir = join(parent, name);
        const raw = readJsonFile<unknown>(join(dir, STREAM_FILE));
        const target = isObject(raw) ? legacyTarget(raw.bind, config) : null;
        if (!isObject(raw) || !target) continue;
        let key: StreamKey | null = null;
        if (kind === 'project' && nonEmpty(raw.pk)) key = { kind, pk: raw.pk, ...target };
        if (kind === 'unresolved' && nonEmpty(raw.cwd)) key = { kind, cwd: raw.cwd, ...target };
        if (!key) continue;
        const dest = this.ensure(key);
        if (!dest) continue;
        const events = this.moveSegments(dir, dest.dir);
        rmSync(dir, { recursive: true, force: true });
        out.streams++;
        out.events += events;
        if (target.endpoint === '') out.unassignedEvents += events;
      }
    }
    if (out.streams) this.log.info('queue: 0.4 streams converted', { ...out });
    return out;
  }

  /** Whether any 0.2 – 0.4 stream directory is left. */
  hasLegacy(): boolean {
    return [this.projectsDir, this.unresolvedDir].some((p) => this.dirNames(p).some((n) => /^[ot]-/.test(n)));
  }

  /**
   * Records whether a stream is sendable now (stream.json `sendable_since` / `seen_at`) and returns the
   * start of its current sendable period (ms), or null while it is held. The 30-day age cap counts from
   * there (C13), so data released after being held (a login, a new token, a link) gets its full 30 days
   * from the release. A stream not seen for more than SEEN_GAP_MS (the collector did not run) starts a new
   * period: a hold in that gap could not be seen. Never throws.
   */
  observe(ref: StreamRef, sendable: boolean): number | null {
    if (ref.kind !== 'project' && ref.kind !== 'unresolved') return null;
    const file = join(ref.dir, STREAM_FILE);
    const raw = readJsonFile<unknown>(file);
    if (!isObject(raw)) return null;
    const now = this.now();
    const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : Number.NaN);
    const since0 = ms(raw.sendable_since);
    const seen = ms(raw.seen_at);
    const fresh = Number.isFinite(seen) && now >= seen && now - seen <= SEEN_GAP_MS;
    const since = sendable ? (Number.isFinite(since0) && fresh ? since0 : now) : null;
    const changed = since === null ? Number.isFinite(since0) : since !== since0;
    if (changed || !fresh || now - seen > SEEN_REFRESH_MS) {
      const { sendable_since: _s, seen_at: _t, ...rest } = raw;
      try {
        writeJsonAtomic(
          file,
          { ...rest, ...(since !== null ? { sendable_since: new Date(since).toISOString() } : {}), seen_at: new Date(now).toISOString() },
          0o600,
        );
      } catch {
        /* the stream was removed meanwhile */
      }
    }
    return since;
  }

  /** Removes stream directories without segments and stale `.tmp-*` directories. */
  prune(): void {
    for (const parent of [this.projectsDir, this.unresolvedDir]) {
      for (const name of this.dirNames(parent)) {
        const dir = join(parent, name);
        try {
          if (name.startsWith('.tmp-')) {
            if (this.now() - statSync(dir).mtimeMs > TMP_STALE_MS) rmSync(dir, { recursive: true, force: true });
            continue;
          }
          if (!this.segmentsOf(dir).length) rmSync(dir, { recursive: true, force: true });
        } catch {
          /* vanished */
        }
      }
    }
  }

  /**
   * Caps across all streams (C13): segments older than maxAge are dropped only for streams that can be sent
   * now and have been sendable for longer than maxAge (observe); then the globally oldest segments go until
   * the total is under maxBytes (never the newest segment of `justWritten`). Dropped events are counted
   * (held / sendable) into the `dropped` recorder and logged.
   */
  enforceCap(justWritten?: StreamRef): CapResult {
    const result: CapResult = { droppedFiles: 0, droppedBytes: 0, droppedEvents: 0, droppedHeldEvents: 0 };
    const all = this.scan(false).flatMap(({ ref }) => {
      const q = this.queueOf(ref);
      return q.segments().map((seg) => ({ ref, seg, q }));
    });
    let total = all.reduce((s, x) => s + x.seg.size, 0);
    const cutoff = this.now() - this.maxAgeMs;
    if (total <= this.maxBytes && !all.some((x) => x.seg.createdAt < cutoff)) return result;

    const view = this.opts.routing();
    const sendableByDir = new Map<string, boolean>();
    const sendable = (ref: StreamRef): boolean => {
      let v = sendableByDir.get(ref.dir);
      if (v === undefined) {
        v = !!view && sendableNow(view, resolveStream(view, identityOfRef(ref)));
        sendableByDir.set(ref.dir, v);
      }
      return v;
    };
    const sinceByDir = new Map<string, number | null>();
    /** start of the stream's current sendable period (observe), null while held */
    const sendableSince = (ref: StreamRef): number | null => {
      if (!sinceByDir.has(ref.dir)) sinceByDir.set(ref.dir, view ? this.observe(ref, sendable(ref)) : null);
      return sinceByDir.get(ref.dir) ?? null;
    };
    let held = 0;
    let sent = 0;
    const dropped = new Set<(typeof all)[number]>();
    const drop = (x: (typeof all)[number]) => {
      const events = x.q.countEvents(x.seg.file);
      try {
        rmSync(join(x.ref.dir, x.seg.file), { force: true });
      } catch {
        return;
      }
      dropped.add(x);
      total -= x.seg.size;
      result.droppedFiles++;
      result.droppedBytes += x.seg.size;
      result.droppedEvents += events;
      if (sendable(x.ref)) sent += events;
      else held += events;
    };
    all.sort((a, b) => a.seg.createdAt - b.seg.createdAt || (a.seg.file < b.seg.file ? -1 : a.seg.file > b.seg.file ? 1 : 0));
    // age cap: only data that has been sendable for the whole period (held, refused and expired time does not count, C13)
    for (const x of all) {
      if (x.seg.createdAt >= cutoff) continue;
      const since = sendableSince(x.ref);
      if (since !== null && since < cutoff) drop(x);
    }
    const keep = justWritten ? this.segmentsOf(justWritten.dir).at(-1)?.file : undefined;
    for (const x of all) {
      if (total <= this.maxBytes) break;
      if (dropped.has(x) || (justWritten && x.ref.dir === justWritten.dir && x.seg.file === keep)) continue;
      drop(x);
    }
    result.droppedHeldEvents = held;
    if (result.droppedFiles) {
      this.log.warn('queue: cap reached, dropped oldest segments', { ...result });
      try {
        this.opts.dropped?.({ held, sendable: sent });
      } catch (err) {
        this.log.error('queue: cannot record dropped events', { error: errorMessage(err) });
      }
    }
    return result;
  }

  stats(): StoreStats {
    const streams = this.scan(false).map(({ ref }) => ({ ...this.queueOf(ref).stats(), stream: ref }));
    const oldest = streams.map((s) => s.oldestAt).filter((x): x is number => x !== null);
    return {
      files: streams.reduce((s, x) => s + x.files, 0),
      bytes: streams.reduce((s, x) => s + x.bytes, 0),
      events: streams.reduce((s, x) => s + x.events, 0),
      oldestAt: oldest.length ? Math.min(...oldest) : null,
      streams,
    };
  }

  // -------------------------------------------------------------- internals

  /** A key in the current shape (keys stored by 0.2 – 0.4 are converted with the current servers). */
  private current(key: StreamKey | null): StreamKey | null {
    if (!key) return null;
    const k = key as unknown as Record<string, unknown>;
    if (typeof k.endpoint === 'string' && isTeam(k.team)) return key;
    return upgradeStreamKey(key, this.opts.routing()?.config ?? null);
  }

  private queueOf(ref: StreamRef): EventQueue {
    return ref.kind === 'pre-upgrade' ? new EventQueue(this.root, { autoCap: false, deadDir: this.deadDir, log: this.log }) : this.stream(ref);
  }

  private segmentsOf(dir: string): SegmentInfo[] {
    return new EventQueue(dir, { autoCap: false }).segments();
  }

  private dirNames(parent: string): string[] {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** The stream of a directory, as read from its stream.json; anything that does not hash to its name is unknown. */
  private readRef(dir: string, name: string, kind: 'project' | 'unresolved'): StreamRef {
    if (/^[ot]-/.test(name)) return { kind: 'legacy', dir };
    const raw = readJsonFile<unknown>(join(dir, STREAM_FILE));
    if (isObject(raw) && typeof raw.endpoint === 'string' && isTeam(raw.team)) {
      const { endpoint, team } = raw;
      if (kind === 'project' && nonEmpty(raw.key) && streamDirName(raw.key, endpoint, team) === name) return { kind, dir, pk: raw.key, endpoint, team };
      if (kind === 'unresolved' && nonEmpty(raw.cwd) && unresolvedDirName(raw.cwd, endpoint, team) === name) return { kind, dir, cwd: raw.cwd, endpoint, team };
    }
    return { kind: 'unknown', dir };
  }

  /** All streams (optionally the empty ones too), oldest segment first; the pre-upgrade stream when root segments exist. */
  private scan(includeEmpty: boolean): Array<{ ref: StreamRef; oldest: number }> {
    const out: Array<{ ref: StreamRef; oldest: number }> = [];
    const rootSegs = this.segmentsOf(this.root);
    if (rootSegs.length) out.push({ ref: { kind: 'pre-upgrade', dir: this.root }, oldest: rootSegs[0]!.createdAt });
    for (const [parent, kind] of [
      [this.projectsDir, 'project'],
      [this.unresolvedDir, 'unresolved'],
    ] as const) {
      for (const name of this.dirNames(parent)) {
        if (name.startsWith('.tmp-')) continue;
        const dir = join(parent, name);
        const segs = this.segmentsOf(dir);
        if (!segs.length && !includeEmpty) continue;
        out.push({ ref: this.readRef(dir, name, kind), oldest: segs[0]?.createdAt ?? Infinity });
      }
    }
    return out.sort((a, b) => a.oldest - b.oldest || (a.ref.dir < b.ref.dir ? -1 : a.ref.dir > b.ref.dir ? 1 : 0));
  }

  /**
   * The key's stream directory, created atomically with its stream.json in place (temp dir + rename;
   * another writer winning the race is fine). Null when a directory of that name exists but is not
   * this stream (never append into it).
   */
  private ensure(key: StreamKey): StreamRef | null {
    const project = key.kind === 'project';
    const parent = project ? this.projectsDir : this.unresolvedDir;
    const name = keyDirName(key);
    const dir = join(parent, name);
    const expected = (): StreamRef | null => {
      const ref = this.readRef(dir, name, key.kind);
      return ref.kind === key.kind ? ref : null;
    };
    if (existsSync(join(dir, STREAM_FILE))) return expected();
    ensureDir(parent);
    const tmp = join(parent, `.tmp-${randomBytes(6).toString('hex')}`);
    try {
      ensureDir(tmp);
      const body = project ? { key: key.pk, endpoint: key.endpoint, team: key.team } : { cwd: key.cwd, endpoint: key.endpoint, team: key.team };
      writeJsonAtomic(join(tmp, STREAM_FILE), { ...body, created_at: new Date(this.now()).toISOString() }, 0o600);
      renameSync(tmp, dir);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw err;
    }
    return expected();
  }

  /** Renames every segment of `from` into `to` (ULID names keep time order). Returns the events moved. */
  private moveSegments(from: string, to: string): number {
    const q = new EventQueue(from, { autoCap: false });
    let events = 0;
    for (const seg of q.segments()) {
      events += q.countEvents(seg.file);
      const src = join(from, seg.file);
      const dest = join(to, seg.file);
      if (existsSync(dest)) {
        appendFileSync(dest, readFileSync(src), { mode: 0o600 });
        rmSync(src, { force: true });
      } else {
        renameSync(src, dest);
      }
    }
    return events;
  }
}
