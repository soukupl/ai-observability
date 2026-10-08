import { describe, expect, it } from 'vitest';
import { computeRunLinks, type LinkableRun } from '../../src/adapters/claude-code/run-links.js';
import { normalizeRunLinks, runEvent, withRunLinks, type RunLinkInput } from '../../src/events.js';

const run = (runId: string, startedMs: number, endedMs: number, o: Partial<LinkableRun> = {}): LinkableRun => ({
  runId, parentRunId: null, orchestrationId: null, flowKey: null, startedMs, endedMs, ...o,
});
const wf = (runId: string, flowKey: string | null, startedMs: number, endedMs = startedMs + 5, orchestrationId = 'wf_1') =>
  run(runId, startedMs, endedMs, { orchestrationId, flowKey });
const asObj = (m: Map<string, RunLinkInput[]>) => Object.fromEntries(m);

describe('computeRunLinks: item', () => {
  it('chains runs of one orchestration and flow key in start order, each to the previous one', () => {
    const links = computeRunLinks([wf('fix', 'data', 30), wf('impl', 'data', 10), wf('verify', 'data', 20), wf('impl-ui', 'ui', 11), wf('verify-ui', 'ui', 21)]);
    expect(asObj(links)).toEqual({
      verify: [{ fromRunId: 'impl', kind: 'item' }],
      fix: [{ fromRunId: 'verify', kind: 'item' }],
      'verify-ui': [{ fromRunId: 'impl-ui', kind: 'item' }],
    });
  });

  it('equal starts are ordered by run id; other orchestrations, no flow key and no orchestration never chain', () => {
    const links = computeRunLinks([
      wf('b', 'data', 10),
      wf('a', 'data', 10),
      wf('x', 'data', 5, 6, 'wf_2'),
      wf('n1', null, 1),
      wf('n2', null, 2),
      run('plain', 0, 1, { flowKey: 'data' }),
    ]);
    expect(links.get('b')).toEqual([{ fromRunId: 'a', kind: 'item' }]);
    expect(links.has('a')).toBe(false);
    expect(links.has('x')).toBe(false);
    expect(links.has('n2')).toBe(false);
  });

  it('parallel runs of one item still chain in start order (no end check)', () => {
    expect(asObj(computeRunLinks([wf('r1', 'bugs', 10, 50), wf('r2', 'bugs', 11, 40)]))).toEqual({ r2: [{ fromRunId: 'r1', kind: 'item' }] });
  });
});

describe('computeRunLinks: sequence', () => {
  it('links to the sibling with the latest end not after the start; overlapping siblings do not chain', () => {
    const links = computeRunLinks([run('e1', 2, 8), run('e2', 3, 9), run('plan', 11, 19), run('impl', 21, 40), run('review', 42, 50)]);
    expect(asObj(links)).toEqual({
      plan: [{ fromRunId: 'e2', kind: 'sequence' }],
      impl: [{ fromRunId: 'plan', kind: 'sequence' }],
      review: [{ fromRunId: 'impl', kind: 'sequence' }],
    });
  });

  it('an end equal to the start counts; ties on the end pick the greater run id', () => {
    const links = computeRunLinks([run('a', 0, 10), run('c', 1, 10), run('b', 2, 10), run('next', 10, 20)]);
    expect(links.get('next')).toEqual([{ fromRunId: 'c', kind: 'sequence' }]);
  });

  it('siblings are grouped by parent; workflow runs never take part', () => {
    const links = computeRunLinks([
      run('top1', 0, 5),
      run('kid1', 6, 7, { parentRunId: 'top2' }),
      run('top2', 5, 20),
      run('kid2', 8, 9, { parentRunId: 'top2' }),
      wf('wf1', 'data', 0, 1),
      run('top3', 21, 22),
    ]);
    expect(asObj(links)).toEqual({
      top2: [{ fromRunId: 'top1', kind: 'sequence' }],
      kid2: [{ fromRunId: 'kid1', kind: 'sequence' }],
      top3: [{ fromRunId: 'top2', kind: 'sequence' }],
    });
  });

  it('never links a run to itself or both ways (zero-length runs at one instant)', () => {
    const links = computeRunLinks([run('z', 5, 5), run('a', 5, 5), run('solo', 0, 0)]);
    expect(asObj(links)).toEqual({ a: [{ fromRunId: 'solo', kind: 'sequence' }], z: [{ fromRunId: 'a', kind: 'sequence' }] });
    expect(computeRunLinks([run('x', 0, 0)]).size).toBe(0);
  });

  it('a run id given twice counts once (first wins)', () => {
    const links = computeRunLinks([run('a', 0, 5), run('b', 6, 7), run('a', 8, 9)]);
    expect(asObj(links)).toEqual({ b: [{ fromRunId: 'a', kind: 'sequence' }] });
  });
});

describe('run event links on the wire', () => {
  const base = {
    harness: 'claude-code', turnId: 't', runId: 'me', parentRunId: null, agentType: 'Explore', depth: 1,
    startedAt: 0, endedAt: 1000, usage: [], phases: {}, outcome: { status: 'success' as const, signals: [], provisional: false },
  };

  it('drops self-links, duplicates and unknown kinds, caps at 32 and clips ids', () => {
    const many: RunLinkInput[] = Array.from({ length: 40 }, (_, i) => ({ fromRunId: `r${i}`, kind: 'sequence' }));
    const links = normalizeRunLinks('me', [
      { fromRunId: 'me', kind: 'item' },
      { fromRunId: 'a', kind: 'item' },
      { fromRunId: 'a', kind: 'item' },
      { fromRunId: 'a', kind: 'sequence' },
      { fromRunId: '', kind: 'item' },
      { fromRunId: 'b', kind: 'continues' as never },
      { fromRunId: 'x'.repeat(300), kind: 'item' },
      ...many,
    ]);
    expect(links).toHaveLength(32);
    expect(links.slice(0, 3)).toEqual([
      { from_run_id: 'a', kind: 'item' },
      { from_run_id: 'a', kind: 'sequence' },
      { from_run_id: 'x'.repeat(256), kind: 'item' },
    ]);
  });

  it('runEvent emits stage_index / flow_key / links only when set', () => {
    const plain = runEvent(base);
    expect('stage_index' in plain || 'flow_key' in plain || 'links' in plain).toBe(false);
    expect(runEvent({ ...base, stageIndex: null, flowKey: ' ', links: [{ fromRunId: 'me', kind: 'item' }] })).toEqual(plain);
    const full = runEvent({ ...base, stageIndex: 2, flowKey: 'data', links: [{ fromRunId: 'a', kind: 'item' }] });
    expect(full).toMatchObject({ stage_index: 2, flow_key: 'data', links: [{ from_run_id: 'a', kind: 'item' }] });
    expect(full.event_id).toBe(plain.event_id);
    expect(runEvent({ ...base, stageIndex: 20_000 }).stage_index).toBe(10_000);
    expect(runEvent({ ...base, stageIndex: -1 }).stage_index).toBeUndefined();
    expect(runEvent({ ...base, stageIndex: 1.5 }).stage_index).toBeUndefined();
    expect(runEvent({ ...base, flowKey: 'k'.repeat(200) }).flow_key).toHaveLength(128);
  });

  it('withRunLinks replaces the links and keeps the event id', () => {
    const e = runEvent({ ...base, links: [{ fromRunId: 'old', kind: 'item' }] });
    const next = withRunLinks(e, [{ fromRunId: 'new', kind: 'sequence' }]);
    expect(next.links).toEqual([{ from_run_id: 'new', kind: 'sequence' }]);
    expect(next.event_id).toBe(e.event_id);
    expect('links' in withRunLinks(e, [])).toBe(false);
    expect(e.links).toEqual([{ from_run_id: 'old', kind: 'item' }]);
  });
});
