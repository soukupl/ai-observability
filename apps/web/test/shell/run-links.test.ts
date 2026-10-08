import { describe, expect, it } from 'vitest';
import { deriveSequenceLinks, flowOrchestrationId, mapRunLink, type LinkableRun, type RunLink } from '../../src/lib/queries/run-links';

const run = (id: string, startedMs: number, endedMs: number, over: Partial<LinkableRun> = {}): LinkableRun => ({
  id,
  parentRunId: null,
  orchestrationId: null,
  startedMs,
  endedMs,
  ...over,
});
const seq = (fromRunId: string, toRunId: string): RunLink => ({ fromRunId, toRunId, kind: 'sequence' });

describe('mapRunLink', () => {
  it('maps a row and drops unresolved ends or unknown kinds', () => {
    expect(mapRunLink({ from_run_id: 'a', to_run_id: 'b', kind: 'item' })).toEqual({ fromRunId: 'a', toRunId: 'b', kind: 'item' });
    expect(mapRunLink({ from_run_id: null, to_run_id: 'b', kind: 'item' })).toBeNull();
    expect(mapRunLink({ from_run_id: 'a', to_run_id: undefined, kind: 'sequence' })).toBeNull();
    expect(mapRunLink({ from_run_id: 'a', to_run_id: 'b', kind: 'continues' })).toBeNull();
  });
});

describe('deriveSequenceLinks', () => {
  it('links each Agent-tool run to the sibling that ended last before it started', () => {
    // Plan 0-10, general-purpose 12-20, code-reviewer 25-30: a chain.
    const runs = [run('plan', 0, 10), run('gp', 12, 20), run('cr', 25, 30)];
    expect(deriveSequenceLinks(runs, [])).toEqual([seq('plan', 'gp'), seq('gp', 'cr')]);
  });

  it('does not chain siblings that overlap; a later run picks the latest end', () => {
    // a 0-10 and b 5-20 overlap: b has no predecessor; c (starts 25) links to b (ended 20 > 10).
    expect(deriveSequenceLinks([run('a', 0, 10), run('b', 5, 20), run('c', 25, 30)], [])).toEqual([seq('b', 'c')]);
  });

  it('end == start counts as "ended before"; ties on the end go to the greater id', () => {
    expect(deriveSequenceLinks([run('a', 0, 10), run('b', 10, 20)], [])).toEqual([seq('a', 'b')]);
    expect(deriveSequenceLinks([run('x', 0, 10), run('y', 2, 10), run('z', 15, 20)], [])).toEqual([seq('y', 'z')]);
  });

  it('two zero-length siblings at the same instant never link both ways: only the lower id leads (collector rule)', () => {
    expect(deriveSequenceLinks([run('b', 5, 5), run('a', 5, 5)], [])).toEqual([seq('a', 'b')]);
    // a zero-length run at another run's start still follows the earlier sibling normally
    expect(deriveSequenceLinks([run('a', 0, 5), run('z', 5, 5), run('y', 5, 9)], [])).toEqual([seq('a', 'y'), seq('a', 'z')].sort((x, y) => (x.toRunId < y.toRunId ? -1 : 1)));
  });

  it('siblings share the parent (and the turn, when given); orchestrated runs are never derived', () => {
    const runs = [
      run('p', 0, 100),
      run('c1', 10, 20, { parentRunId: 'p' }),
      run('c2', 30, 40, { parentRunId: 'p' }),
      run('m2', 150, 160), // main-agent sibling of p
      run('w1', 0, 5, { orchestrationId: 'wf' }),
      run('w2', 6, 9, { orchestrationId: 'wf' }),
    ];
    expect(deriveSequenceLinks(runs, [])).toEqual([seq('c1', 'c2'), seq('p', 'm2')]);
    const twoTurns = [run('a', 0, 10, { turnId: 't1' }), run('b', 20, 30, { turnId: 't2' })];
    expect(deriveSequenceLinks(twoTurns, [])).toEqual([]);
  });

  it('keeps stored links first, deduplicated, without self-links; derives only for runs without a stored incoming link', () => {
    const stored: RunLink[] = [
      { fromRunId: 'a', toRunId: 'c', kind: 'item' },
      { fromRunId: 'a', toRunId: 'c', kind: 'item' },
      { fromRunId: 'b', toRunId: 'b', kind: 'sequence' },
    ];
    const runs = [run('a', 0, 10), run('b', 12, 20), run('c', 25, 30)];
    // c has a stored incoming link, so only b gets a derived one.
    expect(deriveSequenceLinks(runs, stored)).toEqual([{ fromRunId: 'a', toRunId: 'c', kind: 'item' }, seq('a', 'b')]);
  });

  it('never duplicates a stored edge', () => {
    // b has a stored sequence link a -> b: nothing derived for b.
    expect(deriveSequenceLinks([run('a', 0, 10), run('b', 12, 20)], [seq('a', 'b')])).toEqual([seq('a', 'b')]);
  });

  it('a single run or no runs yields only the stored links', () => {
    expect(deriveSequenceLinks([], [])).toEqual([]);
    expect(deriveSequenceLinks([run('a', 0, 1)], [])).toEqual([]);
  });
});

describe('flowOrchestrationId', () => {
  it('keeps a stored orchestration; a workflow agent without one gets a per-turn pseudo id; Agent-tool runs none', () => {
    expect(flowOrchestrationId({ orchestrationId: 'wf_1', agentType: 'workflow:x' })).toBe('wf_1');
    expect(flowOrchestrationId({ orchestrationId: null, agentType: 'workflow:impl-m1' })).toBe('workflow');
    expect(flowOrchestrationId({ orchestrationId: null, agentType: 'workflow:impl-m1', turnId: 't1' })).toBe('workflow@t1');
    expect(flowOrchestrationId({ orchestrationId: null, agentType: 'Explore', turnId: 't1' })).toBeNull();
  });

  it('an unlabelled workflow agent (workflow-subagent, or a workflow group) is a workflow agent too', () => {
    expect(flowOrchestrationId({ orchestrationId: null, agentType: 'workflow-subagent', turnId: 't1' })).toBe('workflow@t1');
    expect(flowOrchestrationId({ orchestrationId: null, agentType: 'custom', agentGroup: 'workflow:build', turnId: 't1' })).toBe('workflow@t1');
    expect(flowOrchestrationId({ orchestrationId: null, agentType: 'custom', agentGroup: 'workflow' })).toBe('workflow');
    expect(flowOrchestrationId({ orchestrationId: null, agentType: 'workflow-ish', agentGroup: 'workflowish' })).toBeNull();
    expect(flowOrchestrationId({ orchestrationId: null, agentType: 'general-purpose', agentGroup: 'general-purpose' })).toBeNull();
  });
});
