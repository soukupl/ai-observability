import { describe, expect, it } from 'vitest';
import { agentGroupOf } from '../../src/lib/queries/agent-groups';
import { mergeAgentRows } from '../../src/lib/queries/agents';

describe('agentGroupOf (ADR-0019 grouping rule)', () => {
  it.each([
    ['workflow:impl-m08-t02b', 'workflow:impl'],
    ['workflow:fix1-m8-brief', 'workflow:fix'],
    ['workflow:review2-docs', 'workflow:review'],
    ['workflow:skeptic-battle-rules', 'workflow:skeptic'],
    ['workflow:Verify_All', 'workflow:verify'],
    ['workflow:plan.step', 'workflow:plan'],
    ['workflow:audit/one', 'workflow:audit'],
    ['workflow:scan two', 'workflow:scan'],
    ['workflow:stage:2', 'workflow:stage'],
    ['Explore', 'Explore'],
    ['general-purpose', 'general-purpose'],
    ['code-reviewer', 'code-reviewer'],
  ])('%s -> %s', (type, group) => {
    expect(agentGroupOf(type)).toBe(group);
  });

  it('falls back to "workflow" when the label has no verb', () => {
    expect(agentGroupOf('workflow:')).toBe('workflow');
    expect(agentGroupOf('workflow:42-x')).toBe('workflow');
    expect(agentGroupOf('workflow:-x')).toBe('workflow');
  });

  it('the stored group wins (trimmed); empty / blank / null is ignored', () => {
    expect(agentGroupOf('workflow:x', 'workflow:verify')).toBe('workflow:verify');
    expect(agentGroupOf('Explore', '  research ')).toBe('research');
    expect(agentGroupOf('workflow:impl-1', '')).toBe('workflow:impl');
    expect(agentGroupOf('workflow:impl-1', '   ')).toBe('workflow:impl');
    expect(agentGroupOf('workflow:impl-1', null)).toBe('workflow:impl');
    expect(agentGroupOf('Plan', undefined)).toBe('Plan');
  });

  it('only a leading "workflow:" prefix is a workflow label', () => {
    expect(agentGroupOf('my-workflow:impl')).toBe('my-workflow:impl');
    expect(agentGroupOf('Workflow:impl')).toBe('Workflow:impl');
  });
});

describe('mergeAgentRows', () => {
  const db = (agent_type: string, agent_group: string | null, runs: number, extra: Record<string, unknown> = {}) => ({
    agent_type, agent_group, runs: String(runs), success: String(runs), failed: '0', abandoned: '0', unknown: '0',
    input_tokens: String(runs * 10), output_tokens: '0', cache_read_tokens: '0', cache_write_tokens: '0', reasoning_tokens: '0',
    avg_depth: '1', max_depth: 1, ...extra,
  });

  it('derives the group and merges a type whose stored group equals the derived one', () => {
    const out = mergeAgentRows([
      db('workflow:impl-a', null, 2, { avg_depth: '1', max_depth: 1 }),
      db('workflow:impl-a', 'workflow:impl', 1, { avg_depth: '2', max_depth: 2, failed: '1', success: '0' }),
      db('Explore', null, 1),
    ]);
    expect(out).toHaveLength(2);
    const impl = out[0]!;
    expect(impl).toMatchObject({ agentType: 'workflow:impl-a', agentGroup: 'workflow:impl', spawns: 3, maxDepth: 2 });
    expect(impl.outcomes).toEqual({ success: 2, failed: 1, abandoned: 0, unknown: 0 });
    expect(impl.avgDepth).toBeCloseTo(4 / 3);
    expect(impl.tokens.total).toBe(30);
    expect(impl.tokenShare).toBeCloseTo(30 / 40);
    expect(impl.successRate).toBeCloseTo(2 / 3);
    expect(out[1]).toMatchObject({ agentType: 'Explore', agentGroup: 'Explore', spawns: 1, tokenShare: 0.25 });
  });

  it('keeps one row per type x group when stored groups differ; sorted by spawns then type', () => {
    const out = mergeAgentRows([db('workflow:a-1', 'workflow:review', 1), db('workflow:a-1', null, 1), db('B', null, 5)]);
    expect(out.map((r) => [r.agentType, r.agentGroup])).toEqual([
      ['B', 'B'],
      ['workflow:a-1', 'workflow:a'],
      ['workflow:a-1', 'workflow:review'],
    ]);
  });

  it('null depth stays null; no tokens = zero share', () => {
    const [r] = mergeAgentRows([db('X', null, 1, { avg_depth: null, max_depth: null, input_tokens: '0' })]);
    expect(r).toMatchObject({ avgDepth: null, maxDepth: null, tokenShare: 0 });
  });
});
