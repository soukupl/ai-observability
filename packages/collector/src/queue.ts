import { appendFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from './fsutil.js';
import { nullLogger, type Logger } from './log.js';
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

  constructor(
    readonly dir: string,
    opts: QueueOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 50 * 1024 * 1024;
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 3600_000;
    this.segmentBytes = opts.segmentBytes ?? 1024 * 1024;
    this.log = opts.log ?? nullLogger;
    this.now = opts.now ?? Date.now;
  }

  /** Appends events (one write per call) and enforces the cap. */
  enqueue(events: readonly IngestEvent[]): void {
    if (!events.length) return;
    ensureDir(this.dir);
    const data = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const segments = this.segments();
    const newest = segments.at(-1);
    const target =
      newest && newest.size + data.length <= this.segmentBytes ? newest.file : `${ulid(this.now())}.ndjson`;
    appendFileSync(join(this.dir, target), data, { mode: 0o600 });
    this.enforceCap();
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

  /** Moves a batch the server refused as a whole into dead/ (capped at 5 MB) and acks it. */
  deadLetter(batch: QueueBatch, reason: string): void {
    const deadDir = join(this.dir, 'dead');
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
    this.log.warn('queue: batch dead-lettered', { events: batch.events.length, reason: reason.slice(0, 200) });
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

  private segments(dir = this.dir): Array<{ file: string; size: number; createdAt: number }> {
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
