import { describe, expect, it } from 'vitest';
import { listHref, parseStartedMs, parseTurnParams, phaseRow, toRunTree, turnFlow, turnGraph } from '../../../src/app/(dashboard)/turns/_helpers';

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
  it('turnFlow: one lane per orchestration, one "main agent spawns" lane, the turn\'s links, the turn axis', () => {
    const run = (id: string, agentType: string, agentGroup: string, orchestrationId: string | null, stageIndex: number | null, startedMs: number, endedMs: number) =>
      ({ id, parentRunId: null, agentType, agentGroup, orchestrationId, stageIndex, flowKey: null, depth: 1, model: 'm', startedMs, endedMs, outcome: 'success' });
    const turn = { id: 't1', startedMs: Date.parse('2026-10-05T10:00:00Z'), durationMs: 100_000, projectId: 'p1', projectName: 'shop', harness: 'claude-code', summary: null, outcome: 'success' };
    const T = turn.startedMs;
    const f = turnFlow({
      turn: { ...turn, endedMs: T + 100_000 },
      runs: [
        run('p', 'Plan', 'Plan', null, null, T + 1_000, T + 5_000),
        run('w1', 'workflow:review:bugs', 'workflow:review', 'wf_1', 0, T + 10_000, T + 20_000),
        run('w2', 'workflow:verify:bugs', 'workflow:verify', 'wf_1', 1, T + 21_000, T + 30_000),
        run('g', 'general-purpose', 'general-purpose', null, null, T + 40_000, T + 120_000),
      ],
      links: [
        { fromRunId: 'w1', toRunId: 'w2', kind: 'item' },
        { fromRunId: 'p', toRunId: 'g', kind: 'sequence' },
        { fromRunId: 'zz', toRunId: 'g', kind: 'sequence' },
      ],
    } as never);
    expect(f.lanes).toEqual([
      { id: 't:t1', label: 'main agent spawns', sublabel: 'shop · 10:00', stages: [] },
      { id: 'o:wf_1', label: 'review → verify', sublabel: 'shop · 10:00', stages: ['review', 'verify'] },
    ]);
    expect(f.nodes.map((n) => [n.id, n.laneId, n.label, n.stageIndex, n.href])).toEqual([
      ['p', 't:t1', 'Plan', null, null],
      ['g', 't:t1', 'general-purpose', null, null],
      ['w1', 'o:wf_1', 'review:bugs', 0, null],
      ['w2', 'o:wf_1', 'verify:bugs', 1, null],
    ]);
    expect(f.edges).toEqual([{ fromId: 'w1', toId: 'w2', kind: 'item' }, { fromId: 'p', toId: 'g', kind: 'sequence' }]);
    expect(f.hiddenLanes).toBe(0);
    // extended to the last run end (T + 120 s), padded by 2% of 120 s = 2.4 s
    expect([f.fromMs, f.toMs]).toEqual([T - 2_400, T + 122_400]);
  });
  it('turnFlow: workflow agents without an orchestration (aggregate path) share one lane', () => {
    const T = 1_000_000;
    const f = turnFlow({
      turn: { id: 't1', startedMs: T, endedMs: T + 10_000, durationMs: 10_000, projectId: null, projectName: null, harness: 'codex', summary: null, outcome: 'success' },
      runs: [
        { id: 'a', parentRunId: null, agentType: 'workflow:impl-1', agentGroup: 'workflow:impl', orchestrationId: null, stageIndex: 0, flowKey: null, depth: 1, model: null, startedMs: T, endedMs: T + 1, outcome: 'failed' },
      ],
      links: [],
    } as never);
    expect(f.lanes.map((l) => [l.id, l.label, l.stages])).toEqual([['o:workflow', 'impl', ['impl']]]);
    expect(f.lanes[0]!.sublabel).toMatch(/^no project · /);
  });
});
