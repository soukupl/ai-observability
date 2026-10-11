import { describe, expect, it } from 'vitest';
import { NO_PROJECT, runHrefs, timelineFlowInput, timelineGraph, timelineHref, timelineNav, turnHref } from '../../../src/app/(dashboard)/agents/timeline-view';
import { buildFlows } from '../../../src/lib/queries/flows';
import { PriceBook } from '../../../src/lib/cost';
import type { AgentTimelineResult, TimelineRun, TimelineTurn, TimelineWindow } from '../../../src/lib/queries/agent-timeline';

const DAY = Date.parse('2026-10-05T00:00:00Z');
const M = 60_000;
const window: TimelineWindow = { day: '2026-10-05', fromMin: 0, toMin: 1440, fromMs: DAY, toMs: DAY + 1440 * M };

const turn = (id: string, sessionId: string | null, project: [string, string] | null, startMin: number, over: Partial<TimelineTurn> = {}): TimelineTurn => ({
  id,
  sessionId,
  projectId: project?.[0] ?? null,
  projectName: project?.[1] ?? null,
  harness: 'claude-code',
  model: 'm',
  startedMs: DAY + startMin * M,
  endedMs: DAY + (startMin + 10) * M,
  durationMs: 10 * M,
  outcome: 'success',
  summary: null,
  tokens: 1,
  isMine: true,
  ...over,
});
const run = (id: string, turnId: string, agentType: string, agentGroup: string, over: Partial<TimelineRun> = {}): TimelineRun => ({
  id,
  turnId,
  parentRunId: null,
  agentType,
  agentGroup,
  orchestrationId: null,
  depth: 1,
  model: 'm',
  startedMs: DAY + M,
  endedMs: DAY + 2 * M,
  durationMs: M,
  tokens: 1,
  outcome: 'success',
  ...over,
});

const ZOO: [string, string] = ['p-zoo', 'zoo'];
const API: [string, string] = ['p-api', 'API'];
const SHOP: [string, string] = ['p-shop', 'shop'];

describe('timelineGraph', () => {
  const turns = [
    turn('t1', 's-zoo', ZOO, 10),
    turn('t2', 's-shop-late', SHOP, 300, { harness: 'codex' }),
    turn('t3', 's-shop-early', SHOP, 60),
    turn('t4', 's-api', API, 500),
    turn('t5', null, null, 5),
    turn('t6', 's-shop-late', SHOP, 200, { harness: 'codex' }),
  ];
  const g = timelineGraph({ window, turns, runs: [] });

  it('orders lanes by project name (case-insensitive, no project last), then by first turn of the session', () => {
    expect(g.lanes.map((l) => l.id)).toEqual(['s:s-api', 's:s-shop-early', 's:s-shop-late', 's:s-zoo', 't:t5']);
    expect(g.lanes.map((l) => l.label)).toEqual(['API', 'shop', 'shop', 'zoo', NO_PROJECT]);
    expect(g.lanes.find((l) => l.id === 's:s-shop-late')!.sublabel).toBe('codex · 03:20');
  });

  it('tells two sessions of one project apart by when their first turn started, never by session id', () => {
    const shop = g.lanes.filter((l) => l.label === 'shop').map((l) => l.sublabel);
    expect(shop).toEqual(['claude-code · 01:00', 'codex · 03:20']);
    for (const l of g.lanes) expect(l.sublabel).not.toMatch(/s-/);
    // A turn that started the day before the window says so.
    const early = timelineGraph({ window, turns: [turn('t0', 's-x', ZOO, -30)], runs: [] });
    expect(early.lanes[0]!.sublabel).toBe('claude-code · 10-04 23:30');
  });

  it('passes the group ranking through for stable branch colours', () => {
    expect(g.groupOrder).toBeUndefined();
    expect(timelineGraph({ window, turns, runs: [] }, ['workflow:impl', 'Explore']).groupOrder).toEqual(['workflow:impl', 'Explore']);
  });

  it('colours a lane by the index of its project in the sorted legend', () => {
    expect(g.projectLegend).toEqual([
      { label: 'API', colorIndex: 0 },
      { label: 'shop', colorIndex: 1 },
      { label: 'zoo', colorIndex: 2 },
      { label: NO_PROJECT, colorIndex: 3 },
    ]);
    expect(g.lanes.map((l) => l.colorIndex)).toEqual([0, 1, 1, 2, 3]);
  });

  it('puts every turn on its session lane and links it to the turn detail', () => {
    const t6 = g.turns.find((t) => t.id === 't6')!;
    expect(t6).toMatchObject({ laneId: 's:s-shop-late', label: 'turn', href: `/turns/t6?startedMs=${DAY + 200 * M}` });
    expect(g.turns.find((t) => t.id === 't5')!.laneId).toBe('t:t5');
    expect(timelineGraph({ window, turns: [turn('x', 's', ZOO, 0, { summary: 'fix the build' })], runs: [] }).turns[0]!.label).toBe('fix the build');
    expect([g.fromMs, g.toMs]).toEqual([window.fromMs, window.toMs]);
    expect(g.ariaLabel).toBe('Agent timeline: 6 turns and 0 sub-agent runs in 5 sessions');
  });

  it('labels runs by their type, without the workflow: prefix, and keeps the group', () => {
    const r = timelineGraph({
      window,
      turns: [turn('t1', 's', ZOO, 0)],
      runs: [
        run('r1', 't1', 'workflow:impl-m08-t02b', 'workflow:impl'),
        run('r2', 't1', 'Explore', 'Explore', { parentRunId: 'r1', depth: 2 }),
        run('r3', 't1', 'workflow:', 'workflow'),
        run('r4', 'missing-turn', 'Plan', 'Plan'),
      ],
    });
    expect(r.runs.map((x) => [x.id, x.label, x.group, x.parentRunId, x.depth])).toEqual([
      ['r1', 'impl-m08-t02b', 'workflow:impl', null, 1],
      ['r2', 'Explore', 'Explore', 'r1', 2],
      ['r3', 'workflow', 'workflow', null, 1],
    ]);
  });

  it('names a project that is no longer listed "unknown project" and keeps it apart from no project', () => {
    const r = timelineGraph({ window, turns: [turn('a', 's1', ['p-gone', null as unknown as string], 0), turn('b', 's2', null, 0)], runs: [] });
    expect(r.lanes.map((l) => [l.label, l.colorIndex])).toEqual([
      ['unknown project', 0],
      [NO_PROJECT, 1],
    ]);
  });
});

describe('timeline links', () => {
  const sp = { range: '7d', projectId: 'p1', day: '2026-10-03', fromH: '09:00', toH: '10:00', harness: ['a', 'b'], empty: undefined };

  it('keeps every other param, sets the day and drops or sets the window', () => {
    expect(timelineHref('/agents', sp, '2026-10-04')).toBe('/agents?range=7d&projectId=p1&harness=a&harness=b&day=2026-10-04');
    expect(timelineHref('/agents', sp, '2026-10-04', { from: '01:00', to: '24:00' })).toBe(
      '/agents?range=7d&projectId=p1&harness=a&harness=b&day=2026-10-04&fromH=01%3A00&toH=24%3A00',
    );
    // the filter bar's custom range (from / to) is not the window and is kept
    expect(timelineHref('/agents', { range: 'custom', from: '2026-10-01', to: '2026-10-05' }, '2026-10-02')).toBe(
      '/agents?range=custom&from=2026-10-01&to=2026-10-05&day=2026-10-02',
    );
  });

  it('prev / next step to the neighbouring days that have turns; whole day only when zoomed', () => {
    const days = ['2026-10-01', '2026-10-03', '2026-10-05'];
    const zoomed: Pick<AgentTimelineResult, 'window' | 'days'> = { days, window: { ...window, day: '2026-10-03', fromMin: 60, toMin: 120 } };
    const nav = timelineNav('/agents', { range: '7d' }, zoomed);
    expect(nav).toEqual({
      prevHref: '/agents?range=7d&day=2026-10-01',
      nextHref: '/agents?range=7d&day=2026-10-05',
      wholeDayHref: '/agents?range=7d&day=2026-10-03',
    });
    // a day without turns (picked from the URL) still finds its neighbours
    expect(timelineNav('/agents', {}, { days, window: { ...window, day: '2026-10-02' } })).toMatchObject({
      prevHref: '/agents?day=2026-10-01',
      nextHref: '/agents?day=2026-10-03',
      wholeDayHref: null,
    });
    expect(timelineNav('/agents', {}, { days, window: { ...window, day: '2026-10-05' } }).nextHref).toBeNull();
    expect(timelineNav('/agents', {}, { days: [], window }).prevHref).toBeNull();
  });
});

describe('run links to flows', () => {
  const t1 = turn('t1', 's', ZOO, 0);
  const t2 = turn('t2', 's', ZOO, 30);
  const wf = (id: string, label: string, stage: number, startMin: number) =>
    run(id, 't1', `workflow:${label}`, `workflow:${label.split(':')[0]}`, { orchestrationId: 'wf_1', stageIndex: stage, flowKey: label.split(':')[1] ?? null, startedMs: DAY + startMin * M, endedMs: DAY + (startMin + 1) * M });
  const runs = [wf('w1', 'impl:x', 0, 1), wf('w2', 'verify:x', 1, 3), run('solo', 't2', 'Explore', 'Explore', { startedMs: DAY + 31 * M, endedMs: DAY + 32 * M })];
  const flows = buildFlows({ ...timelineFlowInput({ turns: [t1, t2], runs }), links: [], prices: new PriceBook([]) });

  it('maps the window to buildFlows input (one token total, no effort) and finds the workflow flow', () => {
    const input = timelineFlowInput({ turns: [t1], runs: [runs[0]!] });
    expect([...input.turns.keys()]).toEqual(['t1']);
    expect(input.turns.get('t1')).toMatchObject({ id: 't1', startedMs: t1.startedMs, projectId: 'p-zoo', projectName: 'zoo', harness: 'claude-code', isMine: true });
    expect(input.runs[0]).toMatchObject({ id: 'w1', turnId: 't1', agentGroup: 'workflow:impl', orchestrationId: 'wf_1', effort: null, tokens: { total: 1, input: 0 } });
    expect(flows.map((f) => [f.key, f.steps.map((s) => s.runId)])).toEqual([['wf_1', ['w1', 'w2']]]);
  });

  it('links flow steps to the flow detail and every other run to its turn; runs of unknown turns get nothing', () => {
    const hrefs = runHrefs(flows, [t1, t2], [...runs, run('ghost', 'missing', 'Plan', 'Plan')]);
    expect(hrefs.get('w1')).toBe(`/turns/t1?startedMs=${t1.startedMs}#flow-wf_1`);
    expect(hrefs.get('w2')).toBe(hrefs.get('w1'));
    expect(hrefs.get('solo')).toBe(`/turns/t2?startedMs=${t2.startedMs}`);
    expect(hrefs.has('ghost')).toBe(false);
  });

  it('timelineGraph puts the href on each run, falling back to the turn', () => {
    const g = timelineGraph({ window, turns: [t1, t2], runs }, undefined, runHrefs(flows, [t1, t2], runs));
    expect(g.runs.map((x) => [x.id, x.href])).toEqual([
      ['w1', `/turns/t1?startedMs=${t1.startedMs}#flow-wf_1`],
      ['w2', `/turns/t1?startedMs=${t1.startedMs}#flow-wf_1`],
      ['solo', turnHref(t2)],
    ]);
    expect(timelineGraph({ window, turns: [t1], runs: [runs[0]!] }).runs[0]!.href).toBe(turnHref(t1));
  });
});
