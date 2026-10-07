import { describe, expect, it } from 'vitest';
import { agentTableRows, depthBars, groupAgentRows, spawnsPerTurn, tokenBars } from '../../../src/app/(dashboard)/agents/agents-view';
import type { AgentRow, AgentsResult } from '../../../src/lib/queries/agents';

const tok = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total });
const row = (agentType: string, total: number, extra: Partial<AgentRow> = {}): AgentRow => ({
  agentType, agentGroup: agentType, spawns: 2, tokens: tok(total), tokenShare: 0.5, successRate: 0.75, unknownShare: 0.1, avgDepth: 1.26, maxDepth: 2,
  outcomes: { success: 1, failed: 1, abandoned: 0, unknown: 0 }, ...extra,
});
const result = (rows: AgentRow[], depthHistogram: AgentsResult['depthHistogram'] = null): AgentsResult =>
  ({ range: {} as AgentsResult['range'], rows, totalSpawns: rows.reduce((s, r) => s + r.spawns, 0), depthHistogram, ignoredFilters: [] });

describe('agents view helpers', () => {
  it('maps rows and rounds avg depth', () => {
    const [r] = agentTableRows(result([row('explore', 100)]));
    expect(r).toMatchObject({ agentType: 'explore', agentGroup: 'explore', tokens: 100, avgDepth: 1.3, successRate: 0.75, unknownShare: 0.1 });
    expect(agentTableRows(result([row('x', 1, { avgDepth: null })]))[0]!.avgDepth).toBeNull();
  });
  it('sorts token bars, drops zeros, folds the tail', () => {
    const rows = [row('a', 5), row('b', 50), row('z', 0), row('c', 1), row('d', 2)];
    expect(tokenBars(result(rows), 2)).toEqual([
      { label: 'b', value: 50 }, { label: 'a', value: 5 }, { label: 'other', value: 3 },
    ]);
    expect(tokenBars(result(rows)).map((b) => b.label)).toEqual(['b', 'a', 'd', 'c']);
  });
  it('token bars are per group (from a result or from group rows)', () => {
    const rows = [
      row('workflow:impl-1', 10, { agentGroup: 'workflow:impl' }),
      row('workflow:impl-2', 30, { agentGroup: 'workflow:impl' }),
      row('Explore', 20),
    ];
    const want = [{ label: 'workflow:impl', value: 40 }, { label: 'Explore', value: 20 }];
    expect(tokenBars(result(rows))).toEqual(want);
    expect(tokenBars(groupAgentRows(result(rows)))).toEqual(want);
  });
  it('depth bars are null without a histogram', () => {
    expect(depthBars(result([]))).toBeNull();
    expect(depthBars(result([], [{ depth: 1, runs: 4 }]))).toEqual([{ label: 'depth 1', value: 4 }]);
  });
  it('spawns per turn guards zero turns', () => {
    expect(spawnsPerTurn(3, 6)).toBe(0.5);
    expect(spawnsPerTurn(3, 0)).toBeNull();
  });
});

describe('groupAgentRows', () => {
  const rows = [
    row('workflow:impl-a', 60, { agentGroup: 'workflow:impl', spawns: 3, avgDepth: 1, maxDepth: 1, outcomes: { success: 2, failed: 0, abandoned: 0, unknown: 1 } }),
    row('workflow:impl-b', 20, { agentGroup: 'workflow:impl', spawns: 5, avgDepth: 2, maxDepth: 3, outcomes: { success: 1, failed: 2, abandoned: 1, unknown: 1 } }),
    row('Explore', 20, { spawns: 8, avgDepth: null, maxDepth: null, outcomes: { success: 8, failed: 0, abandoned: 0, unknown: 0 } }),
    row('Plan', 0, { spawns: 1, outcomes: { success: 0, failed: 0, abandoned: 0, unknown: 1 } }),
  ];

  it('one row per group, spawns desc then name, members spawns desc', () => {
    const g = groupAgentRows(result(rows));
    expect(g.map((x) => [x.group, x.spawns])).toEqual([['Explore', 8], ['workflow:impl', 8], ['Plan', 1]]);
    expect(g[1]!.types.map((t) => t.agentType)).toEqual(['workflow:impl-b', 'workflow:impl-a']);
  });

  it('sums tokens and outcomes; share of all tokens; rates from the summed outcomes', () => {
    const impl = groupAgentRows(result(rows)).find((x) => x.group === 'workflow:impl')!;
    expect(impl.tokens.total).toBe(80);
    expect(impl.tokens.input).toBe(80);
    expect(impl.tokenShare).toBeCloseTo(0.8);
    expect(impl.outcomes).toEqual({ success: 3, failed: 2, abandoned: 1, unknown: 2 });
    expect(impl.successRate).toBeCloseTo(3 / 6);
    expect(impl.unknownShare).toBeCloseTo(2 / 8);
  });

  it('avg depth is spawn-weighted over types with a depth; max depth is the max', () => {
    const g = groupAgentRows(result(rows));
    const impl = g.find((x) => x.group === 'workflow:impl')!;
    expect(impl.avgDepth).toBeCloseTo((1 * 3 + 2 * 5) / 8);
    expect(impl.maxDepth).toBe(3);
    const explore = g.find((x) => x.group === 'Explore')!;
    expect(explore).toMatchObject({ avgDepth: null, maxDepth: null, successRate: 1, unknownShare: 0 });
    const plan = g.find((x) => x.group === 'Plan')!;
    expect(plan).toMatchObject({ successRate: null, unknownShare: 1, tokenShare: 0 });
  });

  it('empty input, and zero tokens overall', () => {
    expect(groupAgentRows(result([]))).toEqual([]);
    expect(groupAgentRows(result([row('X', 0)]))[0]!.tokenShare).toBe(0);
  });

  it('is plain serializable data', () => {
    const g = groupAgentRows(result(rows));
    expect(JSON.parse(JSON.stringify(g))).toEqual(g);
  });
});
