import { describe, expect, it } from 'vitest';
import { PriceBook } from '../../src/lib/cost';
import { buildFlows, flowOutcome, flowTotals, FLOW_KEY_RE, orchestrationKey, type FlowRunInput, type FlowTurn } from '../../src/lib/queries/flows';
import type { RunLink } from '../../src/lib/queries/run-links';

const T0 = Date.parse('2026-10-05T10:00:00Z');
const S = 1000;
const prices = new PriceBook([
  { model: 'opus', effectiveFrom: '2026-01-01', inputPerMtok: 10, outputPerMtok: 50, cacheReadPerMtok: 1, cacheWritePerMtok: 12.5 },
  { model: 'haiku', effectiveFrom: '2026-01-01', inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25 },
  // a price change on the 6th: a run starting that day is priced at it
  { model: 'haiku', effectiveFrom: '2026-10-06', inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: 0.2, cacheWritePerMtok: 2.5 },
]);

const tok = (input: number, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: input + output });
const turn = (id: string, over: Partial<FlowTurn> = {}): FlowTurn => ({
  id, startedMs: T0, projectId: 'p1', projectName: 'shop', harness: 'claude-code', summary: 'do it', isMine: true, ...over,
});
const run = (id: string, agentType: string, startS: number, endS: number, over: Partial<FlowRunInput> = {}): FlowRunInput => ({
  id,
  turnId: 't1',
  parentRunId: null,
  agentType,
  agentGroup: agentType,
  orchestrationId: null,
  stageIndex: null,
  depth: 1,
  model: 'opus',
  effort: 'high',
  startedMs: T0 + startS * S,
  endedMs: T0 + endS * S,
  durationMs: (endS - startS) * S,
  tokens: tok(1_000_000),
  outcome: 'success',
  phasesMs: null,
  skills: null,
  mcp: null,
  ...over,
});
const wf = (id: string, label: string, stage: number | null, startS: number, endS: number, over: Partial<FlowRunInput> = {}) =>
  run(id, `workflow:${label}`, startS, endS, { agentGroup: `workflow:${label.split(':')[0]}`, orchestrationId: 'wf_1', stageIndex: stage, ...over });

const build = (runs: FlowRunInput[], links: RunLink[] = [], turns = new Map([['t1', turn('t1')], ['t2', turn('t2', { startedMs: T0 + 3600 * S })]])) =>
  buildFlows({ runs, turns, links, prices });

describe('flowOutcome', () => {
  it('failed > abandoned > unknown; success only when every step succeeded', () => {
    expect(flowOutcome(['success', 'abandoned', 'failed'])).toBe('failed');
    expect(flowOutcome(['success', 'abandoned', 'unknown'])).toBe('abandoned');
    expect(flowOutcome(['success', 'unknown'])).toBe('unknown');
    expect(flowOutcome(['success', 'success'])).toBe('success');
    expect(flowOutcome([])).toBe('unknown');
  });
});

describe('buildFlows: grouping', () => {
  it('one workflow flow per (turn, orchestration); a single-step orchestration is not a flow', () => {
    const flows = build([
      wf('w1', 'review:bugs', 0, 0, 10),
      wf('w2', 'verify:bugs', 1, 11, 20),
      wf('x1', 'review:docs', 0, 0, 5, { orchestrationId: 'wf_2' }),
      wf('o1', 'impl:a', 0, 3600, 3605, { turnId: 't2' }),
      wf('o2', 'verify:a', 1, 3606, 3609, { turnId: 't2' }),
    ]);
    expect(flows.map((f) => [f.id, f.kind, f.steps.map((s) => s.runId)])).toEqual([
      ['t2~wf_1', 'workflow', ['o1', 'o2']], // newest first
      ['t1~wf_1', 'workflow', ['w1', 'w2']],
    ]);
  });

  it('legacy workflow runs (no orchestration) of a turn form one flow keyed `workflow`', () => {
    const flows = build([
      run('l1', 'workflow:impl-m1', 0, 5, { agentGroup: 'workflow:impl' }),
      run('l2', 'workflow:verify-m1', 6, 9, { agentGroup: 'workflow:verify' }),
      run('l3', 'workflow-subagent', 10, 12, { agentGroup: 'workflow' }),
    ]);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ id: 't1~workflow', key: 'workflow', kind: 'legacy-workflow', stages: ['impl', 'verify', 'workflow'] });
  });

  it('Agent-tool runs: one sequence flow per connected component over stored + derived links', () => {
    const flows = build(
      [
        run('b', 'Plan', 0, 5), // derived sequence: b -> a (a starts after b ended, same parent)
        run('a', 'general-purpose', 6, 9),
        run('d', 'Explore', 0, 20, { parentRunId: 'p' }), // overlaps c (same parent p): only a stored link joins them
        run('c', 'Explore', 1, 3, { parentRunId: 'p' }),
        run('lonely', 'Explore', 0, 30, { parentRunId: 'q' }),
      ],
      [{ fromRunId: 'c', toRunId: 'd', kind: 'item' }],
    );
    expect(flows.map((f) => [f.key, f.kind, f.steps.map((s) => s.runId)])).toEqual([
      ['seq-a', 'sequence', ['b', 'a']],
      ['seq-c', 'sequence', ['d', 'c']],
    ]);
    expect(flows[0]!.links).toEqual([{ fromRunId: 'b', toRunId: 'a', kind: 'sequence' }]);
    expect(flows[0]!.steps[1]!.inLinks).toEqual([{ fromRunId: 'b', kind: 'sequence' }]);
    expect(flows[0]!.steps[0]!.inLinks).toEqual([]);
  });

  it('never mixes turns, and skips runs whose turn is unknown', () => {
    const flows = build([run('a', 'Plan', 0, 5), run('b', 'Plan', 6, 9, { turnId: 't2' }), run('c', 'Plan', 10, 12, { turnId: 'gone' }), run('d', 'Plan', 13, 14, { turnId: 'gone' })]);
    expect(flows).toEqual([]);
  });

  it('workflow agents are never part of a sequence flow', () => {
    const flows = build([wf('w1', 'review:x', 0, 0, 5), run('a', 'Plan', 6, 9)], [{ fromRunId: 'w1', toRunId: 'a', kind: 'sequence' }]);
    expect(flows).toEqual([]);
  });
});

describe('buildFlows: a workflow flow', () => {
  const runs = [
    wf('v1', 'verify:bugs', 3, 30, 40, { outcome: 'failed', phasesMs: { testing: 8000 } }),
    wf('r2', 'review:docs', 1, 2, 12, { model: 'haiku', effort: 'low', skills: { tdd: { model: 1, user: 0 } } }),
    wf('r1', 'review:bugs', 1, 0, 10, { mcp: { github: { search: 2 } }, skills: { tdd: { model: 1, user: 1 } } }),
    wf('u1', 'misc', null, 1, 50, { outcome: 'unknown', effort: null, tokens: tok(0) }),
    wf('h1', 'review:more', 1, 5, 8, { model: 'haiku', startedMs: Date.parse('2026-10-06T00:00:00Z'), endedMs: Date.parse('2026-10-06T00:00:05Z') }),
  ];
  const links: RunLink[] = [
    { fromRunId: 'r1', toRunId: 'v1', kind: 'item' },
    { fromRunId: 'r1', toRunId: 'v1', kind: 'item' },
    { fromRunId: 'zz', toRunId: 'v1', kind: 'item' }, // source not in the flow
  ];
  const [flow] = build(runs, links);

  it('stages from the ordinals (compacted), steps ordered by stage (nulls last), start, id; offsets from the flow start', () => {
    expect(flow!.stages).toEqual(['review', 'verify']);
    expect(flow!.name).toBe('review → verify');
    expect(flow!.steps.map((s) => [s.runId, s.stageIndex, s.stageName])).toEqual([
      ['r1', 0, 'review'],
      ['r2', 0, 'review'],
      ['h1', 0, 'review'],
      ['v1', 1, 'verify'],
      ['u1', null, null],
    ]);
  });

  it('timing: start / end / duration of the whole flow, step offsets', () => {
    expect(flow!.startedMs).toBe(T0);
    expect(flow!.endedMs).toBe(Date.parse('2026-10-06T00:00:05Z'));
    expect(flow!.durationMs).toBe(flow!.endedMs - flow!.startedMs);
    expect(flow!.steps.find((s) => s.runId === 'r2')!.offsetMs).toBe(2 * S);
    expect(flow!.steps.find((s) => s.runId === 'r1')!.offsetMs).toBe(0);
  });

  it('outcome is the worst step; links inside the flow only, deduplicated', () => {
    expect(flow!.outcome).toBe('failed');
    expect(flow!.links).toEqual([{ fromRunId: 'r1', toRunId: 'v1', kind: 'item' }]);
    expect(flow!.steps.find((s) => s.runId === 'v1')!.inLinks).toEqual([{ fromRunId: 'r1', kind: 'item' }]);
  });

  it('cost: each step at its model and UTC start day, summed; a step without tokens costs $0', () => {
    const step = (id: string) => flow!.steps.find((s) => s.runId === id)!;
    expect(step('r1').cost.usd).toBeCloseTo(10, 9); // 1M input at opus $10
    expect(step('r2').cost.usd).toBeCloseTo(1, 9); // haiku before the change
    expect(step('h1').cost.usd).toBeCloseTo(2, 9); // haiku on 2026-10-06
    expect(step('u1').cost).toEqual({ usd: 0, partial: false, unknownModels: [] });
    expect(flow!.cost.usd).toBeCloseTo(10 + 1 + 10 + 2, 9);
    expect(flow!.cost.partial).toBe(false);
    expect(flow!.tokens.total).toBe(4_000_000);
  });

  it('models / efforts distinct and sorted; skills / MCP merged over the steps', () => {
    expect(flow!.models).toEqual(['haiku', 'opus']);
    expect(flow!.efforts).toEqual(['high', 'low']);
    expect(flow!.skills).toEqual({ tdd: { model: 2, user: 1 } });
    expect(flow!.mcp).toEqual({ github: { search: 2 } });
    expect(flow!.steps.find((s) => s.runId === 'v1')!.phasesMs).toEqual({ testing: 8000 });
    expect(flow!.steps.find((s) => s.runId === 'r2')!.phasesMs).toBeNull();
  });

  it('flow-level skills / MCP are null when no step carries any; an unpriced model makes the cost partial', () => {
    const [f] = build([wf('a', 'impl:x', 0, 0, 5, { skills: {}, mcp: {} }), wf('b', 'impl:y', 0, 6, 9, { model: 'mystery' })]);
    expect(f!.skills).toBeNull();
    expect(f!.mcp).toBeNull();
    expect(f!.steps[0]!.skills).toBeNull();
    expect(f!.cost).toEqual({ usd: 10, partial: true, unknownModels: ['mystery'] });
    expect(f!.steps[1]!.cost.usd).toBeNull();
  });
});

describe('buildFlows: stages fallback and names', () => {
  it('without ordinals, stages by group in order of first start', () => {
    const [f] = build([
      wf('v', 'verify:a', null, 10, 12),
      wf('i', 'impl:a', null, 0, 5),
      wf('i2', 'impl:b', null, 6, 9),
    ]);
    expect(f!.stages).toEqual(['impl', 'verify']);
    expect(f!.steps.map((s) => [s.runId, s.stageIndex])).toEqual([['i', 0], ['i2', 0], ['v', 1]]);
    expect(f!.name).toBe('impl → verify');
  });

  it('a workflow with only bare `workflow` groups has no stages and is named "workflow"', () => {
    const [f] = build([wf('a', 'x', null, 0, 1, { agentGroup: 'workflow' }), wf('b', 'y', null, 2, 3, { agentGroup: 'workflow' })]);
    expect(f!.stages).toEqual([]);
    expect(f!.name).toBe('workflow');
  });

  it('a sequence is named by its first four step labels, then …', () => {
    const chain = ['Plan', 'Explore', 'general-purpose', 'Explore', 'Plan'].map((t, i) => run(`r${i}`, t, i * 10, i * 10 + 5));
    const [f] = build(chain);
    expect(f!.kind).toBe('sequence');
    expect(f!.stages).toEqual([]);
    expect(f!.name).toBe('Plan → Explore → general-purpose → Explore → …');
    expect(f!.steps.every((s) => s.stageIndex === null && s.stageName === null)).toBe(true);
    const [short] = build(chain.slice(0, 2));
    expect(short!.name).toBe('Plan → Explore');
  });
});

describe('flowTotals and keys', () => {
  it('sums steps, tokens and cost over flows', () => {
    const flows = build([wf('a', 'impl:x', 0, 0, 5), wf('b', 'impl:y', 0, 6, 9), run('c', 'Plan', 0, 1, { turnId: 't2' }), run('d', 'Plan', 2, 3, { turnId: 't2' })]);
    const t = flowTotals(flows, prices);
    expect(t.flows).toBe(2);
    expect(t.steps).toBe(4);
    expect(t.tokens.total).toBe(4_000_000);
    expect(t.cost.usd).toBeCloseTo(40, 9);
    expect(flowTotals([], prices)).toMatchObject({ flows: 0, steps: 0, cost: { usd: 0 } });
  });

  it('flow keys are URL safe', () => {
    for (const k of ['wf_1', 'workflow', 'seq-0b6c2f7e-1111-4222-8333-944445555666']) expect(FLOW_KEY_RE.test(k)).toBe(true);
    for (const k of ['', 'a/b', 'a b', 'x'.repeat(129)]) expect(FLOW_KEY_RE.test(k)).toBe(false);
  });

  it('an orchestration id the URL key rule rejects (the protocol allows any 1–128 chars) gets a derived key', () => {
    const flows = build([
      wf('w2', 'impl:a', 0, 0, 5, { orchestrationId: 'build 1/2' }),
      wf('w1', 'verify:a', 1, 6, 9, { orchestrationId: 'build 1/2' }),
      wf('s1', 'impl:b', 0, 0, 5, { orchestrationId: 'seq-x' }),
      wf('s2', 'verify:b', 1, 6, 9, { orchestrationId: 'seq-x' }),
    ]);
    expect(flows.map((f) => f.key).sort()).toEqual(['orch-s1', 'orch-w1']);
    for (const f of flows) expect(FLOW_KEY_RE.test(f.key)).toBe(true);
    expect(orchestrationKey('wf_1', [{ id: 'z' }])).toBe('wf_1');
    expect(orchestrationKey('workflow', [{ id: 'z' }, { id: 'a' }])).toBe('orch-a');
    expect(orchestrationKey('run#3', [{ id: 'b' }, { id: 'a' }])).toBe('orch-a');
  });
});
