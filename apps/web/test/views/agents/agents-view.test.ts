import { describe, expect, it } from 'vitest';
import { agentTableRows, depthBars, spawnsPerTurn, tokenBars } from '../../../src/app/(dashboard)/agents/agents-view';
import type { AgentRow, AgentsResult } from '../../../src/lib/queries/agents';

const tok = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total });
const row = (agentType: string, total: number, extra: Partial<AgentRow> = {}): AgentRow => ({
  agentType, spawns: 2, tokens: tok(total), tokenShare: 0.5, successRate: 0.75, unknownShare: 0.1, avgDepth: 1.26, maxDepth: 2, ...extra,
});
const result = (rows: AgentRow[], depthHistogram: AgentsResult['depthHistogram'] = null): AgentsResult =>
  ({ range: {} as AgentsResult['range'], rows, totalSpawns: rows.reduce((s, r) => s + r.spawns, 0), depthHistogram, ignoredFilters: [] });

describe('agents view helpers', () => {
  it('maps rows and rounds avg depth', () => {
    const [r] = agentTableRows(result([row('explore', 100)]));
    expect(r).toMatchObject({ agentType: 'explore', tokens: 100, avgDepth: 1.3, successRate: 0.75, unknownShare: 0.1 });
    expect(agentTableRows(result([row('x', 1, { avgDepth: null })]))[0]!.avgDepth).toBeNull();
  });
  it('sorts token bars, drops zeros, folds the tail', () => {
    const rows = [row('a', 5), row('b', 50), row('z', 0), row('c', 1), row('d', 2)];
    expect(tokenBars(result(rows), 2)).toEqual([
      { label: 'b', value: 50 }, { label: 'a', value: 5 }, { label: 'other', value: 3 },
    ]);
    expect(tokenBars(result(rows)).map((b) => b.label)).toEqual(['b', 'a', 'd', 'c']);
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
