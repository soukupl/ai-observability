import { readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IngestEvent } from '../src/protocol-types.js';
import { EventQueue } from '../src/queue.js';
import { ulid, ulidFrom } from '../src/ulid.js';
import { cleanupHomes, tmpHome } from './helpers.js';

afterEach(cleanupHomes);

const ev = (i: number, pad = 0): IngestEvent => ({
  event_id: ulid(),
  type: 'turn_summary',
  harness: 'claude-code',
  turn_id: `t${i}`,
  summary: `s${i}${'x'.repeat(pad)}`.slice(0, 140),
  ...(pad > 140 ? { ext: { pad: 'y'.repeat(pad) } } : {}),
});

describe('EventQueue', () => {
  it('reads oldest first in batches of at most 500 events and acks them', () => {
    const q = new EventQueue(tmpHome().queue);
    q.enqueue(Array.from({ length: 1200 }, (_, i) => ev(i)));
    const seen: string[] = [];
    for (let b = q.readBatch(); b; b = q.readBatch()) {
      expect(b.events.length).toBeLessThanOrEqual(500);
      seen.push(...b.events.map((e) => (e as { turn_id: string }).turn_id));
      q.ack(b);
    }
    expect(seen).toHaveLength(1200);
    expect(seen[0]).toBe('t0');
    expect(seen.at(-1)).toBe('t1199');
    expect(q.stats().events).toBe(0);
  });

  it('caps batches at ~1 MB', () => {
    const q = new EventQueue(tmpHome().queue, { segmentBytes: 64 * 1024 * 1024 });
    q.enqueue(Array.from({ length: 60 }, (_, i) => ev(i, 50_000))); // ~3 MB
    const b = q.readBatch()!;
    expect(b.bytes).toBeLessThanOrEqual(1_000_000);
    expect(b.events.length).toBeLessThan(60);
    expect(b.events.length).toBeGreaterThan(10);
  });

  it('keeps events appended after readBatch when acking a partial segment', () => {
    const q = new EventQueue(tmpHome().queue);
    q.enqueue([ev(1), ev(2), ev(3)]);
    const b = q.readBatch({ maxEvents: 2 })!;
    q.enqueue([ev(4)]);
    q.ack(b);
    const rest = q.readBatch()!;
    expect(rest.events.map((e) => (e as { turn_id: string }).turn_id)).toEqual(['t3', 't4']);
  });

  it('nothing is lost when a batch is not acked (send failure)', () => {
    const q = new EventQueue(tmpHome().queue);
    q.enqueue([ev(1), ev(2)]);
    q.readBatch();
    expect(q.stats().events).toBe(2);
  });

  it('drops corrupt lines and oversized events', () => {
    const paths = tmpHome();
    const q = new EventQueue(paths.queue);
    q.enqueue([ev(1)]);
    const seg = readdirSync(paths.queue)[0]!;
    writeFileSync(join(paths.queue, seg), 'not json\n' + JSON.stringify(ev(2)) + '\n', { flag: 'a' });
    q.enqueue([ev(3, 2_000_000)]);
    const b = q.readBatch()!;
    expect(b.events.map((e) => (e as { turn_id: string }).turn_id)).toEqual(['t1', 't2']);
    q.ack(b);
    expect(q.readBatch()).toBeNull();
  });

  it('enforces the size cap by dropping the oldest segments', () => {
    const q = new EventQueue(tmpHome().queue, { maxBytes: 200_000, segmentBytes: 50_000 });
    for (let i = 0; i < 40; i++) q.enqueue([ev(i, 10_000)]);
    const s = q.stats();
    expect(s.bytes).toBeLessThanOrEqual(200_000 + 50_000);
    const first = q.readBatch()!.events[0] as { turn_id: string };
    expect(Number(first.turn_id.slice(1))).toBeGreaterThan(10); // oldest dropped
  });

  it('drops segments older than 30 days', () => {
    const paths = tmpHome();
    const q = new EventQueue(paths.queue);
    q.enqueue([ev(1)]);
    const old = `${ulidFrom('old', Date.now() - 40 * 24 * 3600_000)}.ndjson`;
    writeFileSync(join(paths.queue, old), JSON.stringify(ev(0)) + '\n');
    expect(q.enforceCap().droppedFiles).toBe(1);
    expect(q.readBatch()!.events.map((e) => (e as { turn_id: string }).turn_id)).toEqual(['t1']);
  });

  it('dead-letters a refused batch', () => {
    const paths = tmpHome();
    const q = new EventQueue(paths.queue);
    q.enqueue([ev(1)]);
    q.deadLetter(q.readBatch()!, 'HTTP 400');
    expect(q.stats().events).toBe(0);
    expect(readdirSync(paths.deadLetter)).toHaveLength(1);
  });

  it('writes queue files with mode 0600', async () => {
    const paths = tmpHome();
    new EventQueue(paths.queue).enqueue([ev(1)]);
    const { statSync } = await import('node:fs');
    const f = readdirSync(paths.queue).find((n) => n.endsWith('.ndjson'))!;
    expect(statSync(join(paths.queue, f)).mode & 0o777).toBe(0o600);
    utimesSync(join(paths.queue, f), new Date(), new Date());
  });
});
