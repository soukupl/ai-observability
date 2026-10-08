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

  it('accepts skill and MCP usage, defaults a missing skill source to 0 and treats both as optional', () => {
    const turn = fixture().events[1]! as Record<string, unknown>;
    const partial = { ...turn, skills: { 'plugin:skill': { user: 2 } } };
    const without = { ...turn, event_id: '01J9ZQ8Y3N4X5V6W7Z8A9B0C98', skills: undefined, mcp: undefined };
    const res = validateBatch(withEvents([partial, without]));
    if (!res.ok) throw new Error(res.error);
    expect(res.rejected).toEqual([]);
    const [a, b] = res.events;
    expect(a?.type === 'turn' && a.skills).toEqual({ 'plugin:skill': { model: 0, user: 2 } });
    expect(b?.type === 'turn' && b.skills).toBeUndefined();
  });

  it('accepts MCP stats with 5 latency buckets and rejects other bucket counts', () => {
    const turn = fixture().events[1]! as Record<string, unknown>;
    const stats = (buckets: number[]) => ({ ...turn, event_id: '01J9ZQ8Y3N4X5V6W7Z8A9B0C97', mcp_stats: { s: { t: { errors: 1, ms: 10, buckets } } } });
    const ok = validateBatch(withEvents([stats([1, 0, 0, 0, 0])]));
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.rejected).toEqual([]);
    const e = ok.events[0];
    expect(e?.type === 'turn' && e.mcp_stats).toEqual({ s: { t: { errors: 1, denied: 0, ms: 10, buckets: [1, 0, 0, 0, 0] } } });
    const bad = validateBatch(withEvents([stats([1, 0, 0])]));
    if (!bad.ok) throw new Error(bad.error);
    expect(bad.rejected).toHaveLength(1);
  });

  it('accepts a run with and without agent_group / orchestration_id and rejects empty or over-long values', () => {
    const run = fixture().events.find((e) => e.type === 'run')! as Record<string, unknown>;
    const id = (n: number) => `01J9ZQ8Y3N4X5V6W7Z8A9B0C${String(n).padStart(2, '0')}`;
    const { agent_group: _g, orchestration_id: _o, ...bare } = run;
    const res = validateBatch(
      withEvents([
        { ...run, event_id: id(60), agent_group: 'workflow:verify', orchestration_id: 'wf_01J9ZQ8Y3N4X5V6W7Z8A9B0C' },
        { ...bare, event_id: id(61) },
        { ...run, event_id: id(62), agent_group: '' },
        { ...run, event_id: id(63), orchestration_id: 'x'.repeat(129) },
        { ...run, event_id: id(64), agent_group: 'g'.repeat(129) },
      ]),
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.events).toHaveLength(2);
    const [withFields, without] = res.events;
    expect(withFields?.type === 'run' && [withFields.agent_group, withFields.orchestration_id]).toEqual([
      'workflow:verify',
      'wf_01J9ZQ8Y3N4X5V6W7Z8A9B0C',
    ]);
    expect(without?.type === 'run' && [without.agent_group, without.orchestration_id]).toEqual([undefined, undefined]);
    expect(res.rejected.map((r) => r.event_id)).toEqual([id(62), id(63), id(64)]);
  });

  it('accepts a run with and without stage_index / flow_key / links and rejects out-of-range values (ADR-0020)', () => {
    const run = fixture().events.find((e) => e.type === 'run')! as Record<string, unknown>;
    const id = (n: number) => `01J9ZQ8Y3N4X5V6W7Z8A9B0C${String(n).padStart(2, '0')}`;
    const { stage_index: _s, flow_key: _f, links: _l, ...bare } = run;
    const link = (n: number) => ({ from_run_id: `agent-${n}`, kind: 'sequence' });
    const res = validateBatch(
      withEvents([
        { ...run, event_id: id(70) },
        { ...bare, event_id: id(71) },
        { ...run, event_id: id(72), stage_index: 0, links: Array.from({ length: 32 }, (_, i) => link(i)) },
        { ...run, event_id: id(73), stage_index: -1 },
        { ...run, event_id: id(74), stage_index: 10_001 },
        { ...run, event_id: id(75), stage_index: 1.5 },
        { ...run, event_id: id(76), flow_key: '' },
        { ...run, event_id: id(77), flow_key: 'k'.repeat(129) },
        { ...run, event_id: id(78), links: Array.from({ length: 33 }, (_, i) => link(i)) },
        { ...run, event_id: id(79), links: [{ from_run_id: 'agent-x', kind: 'continues' }] },
        { ...run, event_id: id(80), links: [{ from_run_id: '', kind: 'item' }] },
      ]),
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.events).toHaveLength(3);
    const [withFields, without, many] = res.events;
    expect(withFields?.type === 'run' && [withFields.stage_index, withFields.flow_key, withFields.links]).toEqual([
      1,
      'data',
      [{ from_run_id: 'agent-a0', kind: 'item' }],
    ]);
    expect(without?.type === 'run' && [without.stage_index, without.flow_key, without.links]).toEqual([undefined, undefined, undefined]);
    expect(many?.type === 'run' && [many.stage_index, many.links?.length]).toEqual([0, 32]);
    expect(res.rejected.map((r) => r.event_id)).toEqual([73, 74, 75, 76, 77, 78, 79, 80].map(id));
  });

  it('rejects skill / MCP names with whitespace and too many entries', () => {
    const turn = fixture().events[1]! as Record<string, unknown>;
    const id = (n: number) => `01J9ZQ8Y3N4X5V6W7Z8A9B0C${String(n).padStart(2, '0')}`;
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`s${i}`, { model: 1 }]));
    const manyTools = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`t${i}`, 1]));
    const res = validateBatch(
      withEvents([
        { ...turn, event_id: id(80), skills: { 'my skill': { model: 1 } } },
        { ...turn, event_id: id(81), mcp: { 'a\nb': { x: 1 } } },
        { ...turn, event_id: id(82), skills: many },
        { ...turn, event_id: id(83), mcp: { srv: manyTools } },
        { ...turn, event_id: id(84), mcp: { srv: { x: -1 } } },
      ]),
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.events).toHaveLength(0);
    expect(res.rejected).toHaveLength(5);
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
