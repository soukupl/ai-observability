import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  MAX_BATCH_EVENTS,
  projectKeyKind,
  tokenKind,
  validateBatch,
  type IngestBatchInput,
} from '../src/index.js';

const fixture = (): IngestBatchInput =>
  JSON.parse(readFileSync(new URL('../fixtures/valid-batch.json', import.meta.url), 'utf8'));

const withEvents = (events: unknown[]) => ({ ...fixture(), events });

describe('validateBatch', () => {
  it('accepts the fixture with one event of every type', () => {
    const res = validateBatch(fixture());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rejected).toEqual([]);
    expect(res.events.map((e) => e.type).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('applies defaults to optional fields', () => {
    const res = validateBatch(fixture());
    if (!res.ok) throw new Error(res.error);
    const run = res.events.find((e) => e.type === 'run');
    expect(run?.outcome.provisional).toBe(false);
  });

  it('rejects a bad envelope as a whole', () => {
    expect(validateBatch({ ...fixture(), schema: 2 })).toMatchObject({ ok: false });
    expect(validateBatch({ ...fixture(), machine: { id: 'nope', os: 'x' } })).toMatchObject({ ok: false });
    expect(validateBatch(withEvents([]))).toMatchObject({ ok: false });
    expect(validateBatch('garbage')).toMatchObject({ ok: false });
  });

  it(`caps a batch at ${MAX_BATCH_EVENTS} events`, () => {
    const one = fixture().events[5]!;
    const many = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => one);
    expect(validateBatch(withEvents(many))).toMatchObject({ ok: false });
  });

  it('rejects invalid events individually and keeps the valid ones', () => {
    const [start, turn] = fixture().events;
    const bad = { ...turn, event_id: '01J9ZQ8Y3N4X5V6W7Z8A9B0C99', ended_at: '2026-10-05T09:00:00Z' };
    const res = validateBatch(withEvents([start, bad, { type: 'nope' }]));
    if (!res.ok) throw new Error(res.error);
    expect(res.events).toHaveLength(1);
    expect(res.rejected).toEqual([
      { event_id: '01J9ZQ8Y3N4X5V6W7Z8A9B0C99', reason: expect.stringContaining('ended_at') },
      { event_id: null, reason: expect.any(String) },
    ]);
  });

  it('accepts unknown harnesses and ext objects', () => {
    const end = { ...fixture().events[5]!, harness: 'cursor', ext: { foo: 1 } };
    const res = validateBatch(withEvents([end]));
    expect(res.ok && res.events.length).toBe(1);
  });

  it('rejects non-ULID event ids, long summaries and negative token counts', () => {
    const events = fixture().events;
    const res = validateBatch(
      withEvents([
        { ...events[5], event_id: 'not-a-ulid' },
        { ...events[4], summary: 'x'.repeat(141) },
        { ...events[1], usage: [{ ...(events[1] as { usage: object[] }).usage[0], input: -1 }] },
      ]),
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.events).toHaveLength(0);
    expect(res.rejected).toHaveLength(3);
  });

  it('accepts hashed project keys and rejects local paths', () => {
    const start = fixture().events[0]!;
    const hashed = { ...start, project: { key: `sha256:${'a'.repeat(64)}` } };
    const path = { ...start, project: { key: '/Users/dev/billing' } };
    const res = validateBatch(withEvents([hashed, path]));
    if (!res.ok) throw new Error(res.error);
    expect(res.events).toHaveLength(1);
    expect(res.rejected).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('projectKeyKind distinguishes plain and hashed keys', () => {
    expect(projectKeyKind('github.com/acme/billing')).toBe('plain');
    expect(projectKeyKind(`sha256:${'0'.repeat(64)}`)).toBe('hashed');
  });

  it('tokenKind reads the prefix', () => {
    expect(tokenKind('aiobs_u_abc')).toBe('user');
    expect(tokenKind('aiobs_t_abc')).toBe('team');
    expect(tokenKind('aiobs_u_')).toBeNull();
    expect(tokenKind('Bearer x')).toBeNull();
  });
});
