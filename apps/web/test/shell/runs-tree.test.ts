import { describe, expect, it } from 'vitest';
import { buildRunTree, buildTimeline, type RunRow } from '../../src/lib/queries/runs-tree';

const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
const run = (id: string, parent: string | null, startedMs: number, over: Partial<RunRow> = {}): RunRow => ({
  id, parentRunId: parent, agentType: id, depth: parent ? 2 : 1, model: null, effort: null, startedMs, endedMs: startedMs + 1000,
  durationMs: 1000, tokens, phasesMs: {}, tools: {}, outcome: 'success', ...over,
});

describe('buildRunTree', () => {
  it('nests children under parents and orders by start', () => {
    const tree = buildRunTree([run('c2', 'a', 5000), run('b', null, 3000), run('a', null, 1000), run('c1', 'a', 2000)], 0);
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree[0]!.children.map((n) => n.id)).toEqual(['c1', 'c2']);
    expect(tree[0]!.offsetMs).toBe(1000);
  });

  it('treats a run with an unknown parent as a root', () => {
    expect(buildRunTree([run('x', 'missing', 0)], 0).map((n) => n.id)).toEqual(['x']);
  });

  it('never loops on a cycle or a self-parent', () => {
    const tree = buildRunTree([run('a', 'b', 0), run('b', 'a', 1), run('c', 'c', 2)], 0);
    const count = (ns: typeof tree): number => ns.reduce((s, n) => s + 1 + count(n.children), 0);
    expect(count(tree)).toBe(3);
    expect(tree.length).toBeGreaterThan(0);
  });

  it('clamps offsets before the turn start to 0', () => {
    expect(buildRunTree([run('a', null, 500)], 1000)[0]!.offsetMs).toBe(0);
  });
});

describe('buildTimeline', () => {
  it('puts the main agent first, then runs depth-first with their level', () => {
    const tree = buildRunTree([run('a', null, 1000), run('a1', 'a', 1500), run('b', null, 4000)], 0);
    const items = buildTimeline(tree, 6000);
    expect(items.map((i) => [i.label, i.depth, i.offsetMs])).toEqual([
      ['main agent', 0, 0], ['a', 1, 1000], ['a1', 2, 1500], ['b', 1, 4000],
    ]);
    expect(items[0]!.durationMs).toBe(6000);
  });
});
