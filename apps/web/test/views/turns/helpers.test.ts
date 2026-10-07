import { describe, expect, it } from 'vitest';
import { listHref, parseStartedMs, parseTurnParams, phaseRow, toRunTree, turnGraph } from '../../../src/app/(dashboard)/turns/_helpers';

describe('turns helpers', () => {
  it('parses page and outcome defensively', () => {
    expect(parseTurnParams({})).toEqual({ page: 1, outcome: null });
    expect(parseTurnParams({ page: '3', outcome: 'failed' })).toEqual({ page: 3, outcome: 'failed' });
    expect(parseTurnParams({ page: '-2', outcome: 'bogus' })).toEqual({ page: 1, outcome: null });
    expect(parseTurnParams({ page: ['4', '5'] }).page).toBe(4);
  });
  it('parses startedMs', () => {
    expect(parseStartedMs('1700000000000')).toBe(1700000000000);
    expect(parseStartedMs('x')).toBeUndefined();
    expect(parseStartedMs(undefined)).toBeUndefined();
  });
  it('builds list hrefs keeping filters and resetting page', () => {
    expect(listHref({ range: '7d', page: '2' }, { outcome: 'failed' })).toBe('/turns?range=7d&outcome=failed');
    expect(listHref({ outcome: 'failed' }, { outcome: null })).toBe('/turns');
    expect(listHref({ range: '7d', outcome: 'failed' }, { page: 2 })).toBe('/turns?range=7d&outcome=failed&page=2');
  });
  it('phaseRow sorts and drops zeros', () => {
    expect(phaseRow(null)).toBeNull();
    expect(phaseRow({ a: 0 })).toBeNull();
    expect(phaseRow({ a: 1, b: 5, c: 0 })?.keys).toEqual(['b', 'a']);
  });
  it('toRunTree roots at the main agent', () => {
    const tokens = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3 };
    const t = toRunTree({
      turn: { model: 'm', effort: 'high', durationMs: 10, tokens, outcome: 'success' },
      tree: [{ id: 'r1', agentType: 'explore', model: null, effort: null, durationMs: 4, tokens, outcome: 'unknown', children: [] }],
    } as never);
    expect(t.label).toBe('main agent');
    expect(t.children[0]).toMatchObject({ id: 'r1', label: 'explore', tokens: 3 });
  });
  it('turnGraph draws the turn as one project lane with its runs as branches', () => {
    const run = (id: string, parentRunId: string | null, agentType: string, agentGroup: string, startedMs: number, endedMs: number) =>
      ({ id, parentRunId, agentType, agentGroup, depth: parentRunId ? 2 : 1, model: 'm', startedMs, endedMs, outcome: 'success' });
    const g = turnGraph({
      turn: { id: 't1', startedMs: 10_000, endedMs: 110_000, durationMs: 100_000, projectId: 'p1', projectName: 'shop', harness: 'claude-code', summary: null, outcome: 'success' },
      runs: [run('r1', null, 'workflow:impl-m08-t02b', 'workflow:impl', 20_000, 60_000), run('r2', 'r1', 'Explore', 'Explore', 30_000, 40_000)],
    } as never);
    expect(g.lanes).toEqual([{ id: 'turn', label: 'shop', sublabel: 'claude-code', colorIndex: 0 }]);
    expect(g.projectLegend).toEqual([{ label: 'shop', colorIndex: 0 }]);
    expect(g.turns).toEqual([{ id: 't1', laneId: 'turn', label: 'main agent', href: null, startMs: 10_000, endMs: 110_000, outcome: 'success' }]);
    expect(g.runs.map((r) => [r.label, r.group, r.turnId, r.parentRunId])).toEqual([
      ['impl-m08-t02b', 'workflow:impl', 't1', null],
      ['Explore', 'Explore', 't1', 'r1'],
    ]);
    // 2% of 100 s = 2 s of padding on each side
    expect([g.fromMs, g.toMs]).toEqual([8_000, 112_000]);
    expect(g).not.toHaveProperty('onZoom');
  });
  it('turnGraph pads at least a second and names a turn without a project', () => {
    const g = turnGraph({
      turn: { id: 't1', startedMs: 5_000, endedMs: 5_000, durationMs: 0, projectId: null, projectName: null, harness: 'codex', summary: 'fix', outcome: 'failed' },
      runs: [],
    } as never);
    expect([g.fromMs, g.toMs]).toEqual([4_000, 6_000]);
    expect(g.lanes[0]!.label).toBe('no project');
    expect(g.turns[0]!.label).toBe('fix');
  });
});
