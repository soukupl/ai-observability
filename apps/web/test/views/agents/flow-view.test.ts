import { describe, expect, it } from 'vitest';
import { FLOW_MAX_LANES, flowGraph, orchestrationStages, stageName, type FlowRun } from '../../../src/app/(dashboard)/agents/flow-view';
import type { TimelineRun, TimelineTurn, TimelineWindow } from '../../../src/lib/queries/agent-timeline';
import type { RunLink } from '../../../src/lib/queries/run-links';

const DAY = Date.parse('2026-10-05T00:00:00Z');
const M = 60_000;
const window: TimelineWindow = { day: '2026-10-05', fromMin: 0, toMin: 1440, fromMs: DAY, toMs: DAY + 1440 * M };

const turn = (id: string, startMin: number, over: Partial<TimelineTurn> = {}): TimelineTurn => ({
  id,
  sessionId: null,
  projectId: 'p-shop',
  projectName: 'shop',
  harness: 'claude-code',
  model: 'm',
  startedMs: DAY + startMin * M,
  endedMs: DAY + (startMin + 60) * M,
  durationMs: 60 * M,
  outcome: 'success',
  summary: null,
  tokens: 1,
  isMine: true,
  ...over,
});
const run = (id: string, turnId: string, agentType: string, agentGroup: string, startMin: number, endMin: number, over: Partial<TimelineRun> = {}): TimelineRun => ({
  id,
  turnId,
  parentRunId: null,
  agentType,
  agentGroup,
  orchestrationId: null,
  stageIndex: null,
  flowKey: null,
  depth: 1,
  model: 'm',
  startedMs: DAY + startMin * M,
  endedMs: DAY + endMin * M,
  durationMs: (endMin - startMin) * M,
  tokens: 1,
  outcome: 'success',
  ...over,
});
const wf = (id: string, label: string, stage: number | null, startMin: number, endMin: number, orch = 'wf_1', turnId = 't1') =>
  run(id, turnId, `workflow:${label}`, `workflow:${label.split(':')[0]}`, startMin, endMin, { orchestrationId: orch, stageIndex: stage, flowKey: label.split(':')[1] ?? null });

describe('stageName', () => {
  it('strips the workflow prefix; a bare workflow group has no stage name', () => {
    expect(stageName('workflow:verify')).toBe('verify');
    expect(stageName('workflow')).toBeNull();
    expect(stageName('Explore')).toBe('Explore');
  });
});

describe('orchestrationStages', () => {
  const fr = (id: string, group: string, stage: number | null, start: number): FlowRun => ({
    id, turnId: 't', agentType: `workflow:${id}`, agentGroup: group, orchestrationId: 'wf', stageIndex: stage, startedMs: start, endedMs: start + 1, outcome: 'success', model: null,
  });

  it('compacts stage ordinals and names them by the most common phase; unstaged runs get null', () => {
    const s = orchestrationStages([fr('a', 'workflow:review', 0, 1), fr('b', 'workflow:fix', 3, 5), fr('c', 'workflow:fix', 3, 6), fr('d', 'workflow:x', 3, 4), fr('e', 'workflow:verify', null, 2)]);
    expect(s.stages).toEqual(['review', 'fix']);
    expect(Object.fromEntries(s.indexOf)).toEqual({ a: 0, b: 1, c: 1, d: 1, e: null });
  });

  it('names a stage without a phase name "stage N"', () => {
    expect(orchestrationStages([fr('a', 'workflow', 2, 1)]).stages).toEqual(['stage 3']);
  });

  it('without ordinals, derives stages from groups in order of first start; a bare workflow lane has none', () => {
    const s = orchestrationStages([fr('v', 'workflow:verify', null, 5), fr('i', 'workflow:impl', null, 1), fr('i2', 'workflow:impl', null, 7)]);
    expect(s.stages).toEqual(['impl', 'verify']);
    expect(Object.fromEntries(s.indexOf)).toEqual({ i: 0, v: 1, i2: 0 });
    const bare = orchestrationStages([fr('a', 'workflow', null, 1), fr('b', 'workflow', null, 2)]);
    expect(bare.stages).toEqual([]);
    expect([...bare.indexOf.values()]).toEqual([null, null]);
  });
});

describe('flowGraph', () => {
  const turns = [turn('t1', 600, { summary: 'Fix the bugs' }), turn('t2', 540, { projectId: null, projectName: null })];
  const runs = [
    wf('w1', 'review:bugs', 0, 601, 605),
    wf('w2', 'verify:bugs', 1, 606, 608),
    wf('w3', 'fix:bugs', 2, 609, 612),
    wf('w4', 'review:docs', 0, 601, 604),
    run('a1', 't2', 'Plan', 'Plan', 541, 545),
    run('a2', 't2', 'general-purpose', 'general-purpose', 546, 550),
    run('x1', 'gone', 'Explore', 'Explore', 1, 2), // turn not in the result: dropped
  ];
  const links: RunLink[] = [
    { fromRunId: 'w1', toRunId: 'w2', kind: 'item' },
    { fromRunId: 'w2', toRunId: 'w3', kind: 'item' },
    { fromRunId: 'a1', toRunId: 'a2', kind: 'sequence' },
    { fromRunId: 'x1', toRunId: 'a2', kind: 'sequence' }, // source not drawn
    { fromRunId: 'w1', toRunId: 'w2', kind: 'item' }, // duplicate
  ];
  const g = flowGraph({ window, turns, runs, links }, ['workflow:review']);

  it('one lane per orchestration and one per turn with Agent-tool runs, ordered by first run start', () => {
    expect(g.lanes.map((l) => l.id)).toEqual(['t:t2', 'o:wf_1']);
    expect(g.lanes[0]).toEqual({ id: 't:t2', label: 'turn', sublabel: 'no project · 09:00', stages: [] });
    expect(g.lanes[1]).toEqual({ id: 'o:wf_1', label: 'review → verify → fix', sublabel: 'shop · 10:01', stages: ['review', 'verify', 'fix'] });
    expect(g.hiddenLanes).toBe(0);
  });

  it('nodes carry the short label, group, stage row and a link to their turn', () => {
    expect(g.nodes.map((n) => n.id)).toEqual(['a1', 'a2', 'w1', 'w4', 'w2', 'w3']);
    expect(g.nodes.find((n) => n.id === 'w2')).toEqual({
      id: 'w2', laneId: 'o:wf_1', label: 'verify:bugs', group: 'workflow:verify', stageIndex: 1, startMs: DAY + 606 * M, endMs: DAY + 608 * M,
      outcome: 'success', model: 'm', href: `/turns/t1?startedMs=${DAY + 600 * M}`,
    });
    expect(g.nodes.find((n) => n.id === 'a1')).toMatchObject({ laneId: 't:t2', stageIndex: null, label: 'Plan' });
  });

  it('edges only between drawn nodes, deduplicated; window and group order pass through', () => {
    expect(g.edges).toEqual([
      { fromId: 'w1', toId: 'w2', kind: 'item' },
      { fromId: 'w2', toId: 'w3', kind: 'item' },
      { fromId: 'a1', toId: 'a2', kind: 'sequence' },
    ]);
    expect(g).toMatchObject({ fromMs: window.fromMs, toMs: window.toMs, groupOrder: ['workflow:review'] });
    expect('groupOrder' in flowGraph({ window, turns, runs: [], links: [] })).toBe(false);
  });

  it('old workflow runs without an orchestration share one pseudo lane per turn', () => {
    const old = flowGraph({
      window,
      turns,
      runs: [run('o1', 't1', 'workflow:impl-m1', 'workflow:impl', 601, 602), run('o2', 't1', 'workflow:verify-m1', 'workflow:verify', 603, 604)],
      links: [],
    });
    expect(old.lanes).toEqual([{ id: 'o:workflow@t1', label: 'impl → verify', sublabel: 'shop · 10:01', stages: ['impl', 'verify'] }]);
    expect(old.nodes.map((n) => n.stageIndex)).toEqual([0, 1]);
  });

  it('a turn that started on an earlier day shows the date in its sublabel', () => {
    const early = turn('t0', -30, { summary: 'night' });
    const f = flowGraph({ window, turns: [early], runs: [run('r', 't0', 'Explore', 'Explore', 5, 6)], links: [] });
    expect(f.lanes[0]!.sublabel).toBe('shop · 10-04 23:30');
  });

  it('caps lanes and counts the hidden ones; their nodes and edges are dropped', () => {
    const many = Array.from({ length: FLOW_MAX_LANES + 3 }, (_, i) => turn(`t${i}`, i));
    const manyRuns = many.flatMap((t, i) => [run(`r${i}a`, t.id, 'Plan', 'Plan', i, i + 0.2), run(`r${i}b`, t.id, 'Explore', 'Explore', i + 0.5, i + 0.8)]);
    const last = FLOW_MAX_LANES + 2;
    const f = flowGraph({ window, turns: many, runs: manyRuns, links: [{ fromRunId: `r${last}a`, toRunId: `r${last}b`, kind: 'sequence' }, { fromRunId: 'r0a', toRunId: 'r0b', kind: 'sequence' }] });
    expect(f.lanes).toHaveLength(FLOW_MAX_LANES);
    expect(f.hiddenLanes).toBe(3);
    expect(f.nodes).toHaveLength(FLOW_MAX_LANES * 2);
    expect(f.edges).toEqual([{ fromId: 'r0a', toId: 'r0b', kind: 'sequence' }]);
  });

  it('empty window: nothing to draw', () => {
    expect(flowGraph({ window, turns: [], runs: [], links: [] })).toEqual({ lanes: [], nodes: [], edges: [], hiddenLanes: 0, fromMs: window.fromMs, toMs: window.toMs });
  });
});
