import { describe, expect, it } from 'vitest';
import { orchestrationStages, stageName, type FlowRun } from '../../../src/app/(dashboard)/agents/flow-view';

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
