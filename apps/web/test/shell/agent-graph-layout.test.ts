import { describe, expect, it } from 'vitest';
import {
  allocateSubRows,
  backgroundEnds,
  branchPath,
  branchY,
  emptyGraphMessage,
  formatClock,
  GROUP_COLORS,
  groupColorIndex,
  isShortBranch,
  LAYOUT_DEFAULTS,
  laneLayout,
  minutesToClock,
  parentY,
  snapToMinute,
  spanX,
  tickNeedsSeconds,
  tickStepMs,
  tickTimes,
  timeScale,
  zoomWindow,
  type GraphLane,
  type GraphRun,
  type GraphTurn,
} from '../../src/components/charts/agent-graph-layout';

const MIN = 60_000;
const DAY0 = Date.parse('2026-10-07T00:00:00Z');
const at = (h: number, m = 0, s = 0) => DAY0 + h * 3_600_000 + m * MIN + s * 1000;

const lane = (id: string): GraphLane => ({ id, label: id, sublabel: null, colorIndex: 0 });
const turn = (id: string, laneId: string, startMs: number, endMs: number): GraphTurn => ({
  id,
  laneId,
  label: id,
  href: null,
  startMs,
  endMs,
  outcome: 'success',
});
const run = (id: string, turnId: string, startMs: number, endMs: number, depth = 1, parentRunId: string | null = null, group = 'Explore'): GraphRun => ({
  id,
  turnId,
  parentRunId,
  label: id,
  group,
  depth,
  startMs,
  endMs,
  outcome: 'success',
  model: null,
});

describe('sub-row cap, minimum span, background tails, short branches', () => {
  const turns = new Map([['t1', turn('t1', 'A', at(9), at(9, 1))]]);
  it('caps the sub-rows of a lane and puts the rest of a burst on one shared overflow row', () => {
    const burst = Array.from({ length: 10 }, (_, i) => run(`b${i}`, 't1', at(9, 0, i), at(9, 0, 30 + i)));
    const a = allocateSubRows(burst, turns, { maxSubRows: 4 });
    expect(burst.slice(0, 4).map((r) => a.subRowOf.get(r.id))).toEqual([0, 1, 2, 3]);
    expect(burst.slice(4).every((r) => a.subRowOf.get(r.id) === 4)).toBe(true);
    expect(a.overflow.get('A')).toEqual(['b4', 'b5', 'b6', 'b7', 'b8', 'b9']);
    expect(a.laneSubRows.get('A')).toBe(5);
    const layout = laneLayout([lane('A')], [...turns.values()], burst, { ...LAYOUT_DEFAULTS, maxSubRows: 4 });
    expect(layout.lanes[0]!.height).toBe(LAYOUT_DEFAULTS.trunkRow + 5 * LAYOUT_DEFAULTS.subRow);
    expect(branchY('b9', layout)).toBe(LAYOUT_DEFAULTS.top + LAYOUT_DEFAULTS.trunkRow + 4 * LAYOUT_DEFAULTS.subRow + LAYOUT_DEFAULTS.subRow / 2);
  });
  it('holds a row for at least minSpanMs, so runs that touch on screen do not share it', () => {
    const serial = [run('s1', 't1', at(9), at(9, 0, 1)), run('s2', 't1', at(9, 0, 2), at(9, 0, 3))];
    expect(allocateSubRows(serial, turns).subRowOf.get('s2')).toBe(0);
    expect(allocateSubRows(serial, turns, { minSpanMs: 5000 }).subRowOf.get('s2')).toBe(1);
  });
  it('finds the background tail of turns whose runs outlive them', () => {
    const ts = [turn('t1', 'A', at(9), at(9, 1)), turn('t2', 'A', at(10), at(11))];
    const tails = backgroundEnds(ts, [run('r1', 't1', at(9), at(9, 30)), run('r2', 't1', at(9), at(9, 45)), run('r3', 't2', at(10), at(10, 30))]);
    expect([...tails.entries()]).toEqual([['t1', at(9, 45)]]);
  });
  it('treats a branch narrower than both curves as short', () => {
    expect(isShortBranch(100, 110)).toBe(true);
    expect(isShortBranch(100, 140)).toBe(false);
  });
});

describe('allocateSubRows', () => {
  const turns = new Map([
    ['t1', turn('t1', 'A', at(9), at(10))],
    ['t2', turn('t2', 'B', at(9), at(10))],
  ]);

  it('stacks parallel runs and reuses a row for serial ones', () => {
    const { subRowOf, laneSubRows } = allocateSubRows(
      [run('r1', 't1', at(9, 0), at(9, 10)), run('r2', 't1', at(9, 5), at(9, 15)), run('r3', 't1', at(9, 10), at(9, 20)), run('r4', 't1', at(9, 12), at(9, 13))],
      turns,
    );
    expect(subRowOf.get('r1')).toBe(0);
    expect(subRowOf.get('r2')).toBe(1);
    expect(subRowOf.get('r3')).toBe(0); // r1 ended exactly when r3 starts
    expect(subRowOf.get('r4')).toBe(2);
    expect(laneSubRows.get('A')).toBe(3);
  });

  it('allocates per lane', () => {
    const { subRowOf, laneSubRows } = allocateSubRows([run('a', 't1', at(9), at(9, 30)), run('b', 't2', at(9), at(9, 30))], turns);
    expect(subRowOf.get('a')).toBe(0);
    expect(subRowOf.get('b')).toBe(0);
    expect(laneSubRows.get('A')).toBe(1);
    expect(laneSubRows.get('B')).toBe(1);
  });

  it('places a parent before a child that starts at the same time, independent of input order', () => {
    const child = run('a-child', 't1', at(9), at(9, 5), 2, 'z-parent');
    const parent = run('z-parent', 't1', at(9), at(9, 10), 1);
    const { subRowOf } = allocateSubRows([child, parent], turns);
    expect(subRowOf.get('z-parent')).toBe(0);
    expect(subRowOf.get('a-child')).toBe(1);
  });

  it('breaks start / depth ties by id and skips runs of unknown turns', () => {
    const { subRowOf, laneOfRun } = allocateSubRows([run('b', 't1', at(9), at(9, 5)), run('a', 't1', at(9), at(9, 5)), run('x', 'missing', at(9), at(9, 5))], turns);
    expect(subRowOf.get('a')).toBe(0);
    expect(subRowOf.get('b')).toBe(1);
    expect(subRowOf.has('x')).toBe(false);
    expect(laneOfRun.get('a')).toBe('A');
  });
});

describe('laneLayout / branchY / parentY', () => {
  const lanes = [lane('A'), lane('B'), lane('C')];
  const turns = [turn('t1', 'A', at(9), at(10)), turn('t2', 'B', at(9), at(10))];
  const runs = [
    run('p', 't1', at(9), at(9, 30), 1),
    run('c', 't1', at(9, 5), at(9, 10), 2, 'p'),
    run('orphan', 't1', at(9, 40), at(9, 50), 2, 'gone'),
    run('q', 't2', at(9), at(9, 10), 1),
  ];
  const layout = laneLayout(lanes, turns, runs, { trunkRow: 28, subRow: 18, top: 28 });

  it('stacks lanes under the axis with trunk row + sub-rows', () => {
    const [a, b, c] = layout.lanes;
    expect(a).toMatchObject({ id: 'A', top: 28, trunkY: 42, subRows: 2, height: 28 + 2 * 18 });
    expect(b).toMatchObject({ id: 'B', top: 28 + 64, trunkY: 28 + 64 + 14, subRows: 1, height: 46 });
    expect(c).toMatchObject({ id: 'C', top: 28 + 64 + 46, subRows: 0, height: 28 });
    expect(layout.height).toBe(28 + 64 + 46 + 28);
  });

  it('puts branches on their sub-rows below the trunk', () => {
    expect(branchY('p', layout)).toBe(28 + 28 + 9);
    expect(branchY('c', layout)).toBe(28 + 28 + 18 + 9);
    expect(branchY('nope', layout)).toBeNull();
  });

  it('forks depth-1 and orphaned runs from the trunk, nested runs from their parent branch', () => {
    expect(parentY(runs[0]!, layout)).toBe(42);
    expect(parentY(runs[1]!, layout)).toBe(branchY('p', layout));
    expect(parentY(runs[2]!, layout)).toBe(42);
    expect(parentY(runs[3]!, layout)).toBe(layout.laneById.get('B')!.trunkY);
    expect(parentY(run('x', 'unknown', 0, 1), layout)).toBeNull();
  });
});

describe('timeScale', () => {
  it('maps the window onto [x0, x0 + width] and inverts with clamping', () => {
    const s = timeScale(at(9), at(10), 160, 600);
    expect(s.x(at(9))).toBe(160);
    expect(s.x(at(10))).toBe(760);
    expect(s.x(at(9, 30))).toBe(460);
    expect(s.invert(460)).toBe(at(9, 30));
    expect(s.invert(0)).toBe(at(9));
    expect(s.invert(10_000)).toBe(at(10));
  });
});

describe('tickTimes', () => {
  it('uses 3 h ticks for a whole day, aligned to midnight', () => {
    expect(tickStepMs(at(0), at(24))).toBe(180 * MIN);
    const ticks = tickTimes(at(0), at(24));
    expect(ticks).toHaveLength(9);
    expect(ticks[0]).toBe(at(0));
    expect(ticks[8]).toBe(at(24));
  });
  it.each([
    [60, 10],
    [120, 15],
    [30, 5],
    [240, 30],
    [8 * 60, 60],
    [12 * 60, 120],
    [36 * 60, 360],
  ])('a %d minute window -> %d minute steps', (minutes, step) => {
    expect(tickStepMs(at(9), at(9) + minutes * MIN)).toBe(step * MIN);
  });
  it('aligns ticks to the step, not to the window start', () => {
    expect(tickTimes(at(9, 7), at(10, 7))).toEqual([at(9, 10), at(9, 20), at(9, 30), at(9, 40), at(9, 50), at(10)]);
  });
  it('uses second steps for windows under a few minutes (short turns on turn detail)', () => {
    // A 32 s turn padded by the turn-detail graph: 10:00:19..10:00:51 -> 5 s ticks with seconds in the labels.
    const from = at(10, 0, 19);
    const to = at(10, 0, 51);
    expect(tickStepMs(from, to)).toBe(5000);
    expect(tickNeedsSeconds(tickStepMs(from, to))).toBe(true);
    expect(tickTimes(from, to)).toEqual([20, 25, 30, 35, 40, 45, 50].map((sec) => at(10, 0, sec)));
    expect(tickStepMs(at(10), at(10, 1, 30))).toBe(15_000);
    expect(tickStepMs(at(10), at(10, 0, 5))).toBe(1000);
    expect(tickNeedsSeconds(tickStepMs(at(9), at(10)))).toBe(false);
  });
});

describe('groupColorIndex', () => {
  it('follows the given ranking, so a group keeps its colour whatever else is in the window', () => {
    const ranking = ['workflow:impl', 'workflow:verify', 'Explore'];
    // workflow:impl is absent from this window: the others keep the colours of their rank anyway.
    expect([...groupColorIndex(['Explore', 'workflow:verify'], ranking).entries()]).toEqual([
      ['Explore', 2],
      ['workflow:verify', 1],
    ]);
    const all = groupColorIndex(['Explore', 'workflow:verify', 'workflow:impl', 'unranked'], ranking);
    expect(all.get('workflow:impl')).toBe(0);
    expect(all.get('workflow:verify')).toBe(1);
    expect(all.get('Explore')).toBe(2);
    expect(all.get('unranked')).toBe(3);
  });
  it('never reuses a colour: groups beyond the palette are grey (null)', () => {
    const groups = Array.from({ length: GROUP_COLORS + 3 }, (_, i) => `g${String(i).padStart(2, '0')}`);
    const m = groupColorIndex(groups, groups);
    const indices = [...m.values()].filter((v) => v !== null);
    expect(new Set(indices).size).toBe(GROUP_COLORS);
    expect([...m.values()].filter((v) => v === null)).toHaveLength(3);
    expect(m.get('g10')).toBeNull();
    // Head groups keep their rank's colour; other groups take the colours no present head group uses.
    const few = groupColorIndex(['g00', 'g09', 'new'], ['g00', 'g01']);
    expect([...few.entries()]).toEqual([
      ['g00', 0],
      ['g09', 1],
      ['new', 2],
    ]);
    const full = groupColorIndex(['g00', 'g09', 'g10'], groups);
    expect([...full.entries()]).toEqual([
      ['g00', 0],
      ['g09', 1],
      ['g10', 2],
    ]);
    const crowded = groupColorIndex([...groups.slice(0, GROUP_COLORS), 'g10'], groups);
    expect(crowded.get('g07')).toBe(7);
    expect(crowded.get('g10')).toBeNull();
  });
  it('without a ranking, ranks by run count then name', () => {
    const m = groupColorIndex(['workflow:review', 'Explore', 'workflow:impl', 'Explore']);
    expect([...m.entries()]).toEqual([
      ['Explore', 0],
      ['workflow:impl', 1],
      ['workflow:review', 2],
    ]);
  });
});

describe('spanX / branchPath', () => {
  const s = timeScale(at(9), at(10), 100, 600);
  it('clips to the plot with a small overhang and enforces a minimum width', () => {
    expect(spanX(at(8), at(9, 30), s)).toEqual({ x1: 76, x2: 400 });
    expect(spanX(at(10, 1), at(10, 2), s)).toBeNull();
    const tiny = spanX(at(9, 30), at(9, 30), s)!;
    expect(tiny.x2 - tiny.x1).toBe(2);
    expect(tiny.x1).toBe(399);
  });
  it('draws fork, line and merge between the parent and the branch row', () => {
    expect(branchPath(100, 200, 40, 60)).toBe('M100,40C104,40 104,60 108,60L192,60C196,60 196,40 200,40');
    expect(branchPath(100, 200, 60, 60)).toBe('M100,60L200,60');
    // Short spans shrink the curves to a third of the span each.
    expect(branchPath(100, 106, 40, 60)).toBe('M100,40C101,40 101,60 102,60L104,60C105,60 105,40 106,40');
  });
});

describe('formatting and zoom', () => {
  it('formats UTC clock times', () => {
    expect(formatClock(at(9, 5, 7))).toBe('09:05');
    expect(formatClock(at(9, 5, 7), { seconds: true })).toBe('09:05:07');
    expect(formatClock(at(24))).toBe('00:00');
    expect(formatClock(at(24), { dayStartMs: DAY0 })).toBe('24:00');
    expect(minutesToClock(0)).toBe('00:00');
    expect(minutesToClock(615)).toBe('10:15');
    expect(minutesToClock(1440)).toBe('24:00');
  });
  it('snaps to whole minutes', () => {
    expect(snapToMinute(at(9, 10, 29))).toBe(at(9, 10));
    expect(snapToMinute(at(9, 10, 31))).toBe(at(9, 11));
  });
  it('turns a selection into an HH:MM window of the day', () => {
    expect(zoomWindow(at(9, 10, 20), at(11, 45, 40), '2026-10-07')).toEqual({ from: '09:10', to: '11:46' });
    expect(zoomWindow(at(11), at(9), '2026-10-07')).toEqual({ from: '09:00', to: '11:00' });
    expect(zoomWindow(at(23, 30), at(24), '2026-10-07')).toEqual({ from: '23:30', to: '24:00' });
    expect(zoomWindow(at(9, 0, 10), at(9, 0, 20), '2026-10-07')).toBeNull();
    expect(zoomWindow(at(9), at(10), 'nope')).toBeNull();
  });
});

describe('emptyGraphMessage', () => {
  it('names the window for a plain graph and the running turn on a live session page', () => {
    expect(emptyGraphMessage(undefined)).toBe('No turns in this window.');
    expect(emptyGraphMessage(1_760_000_000_000)).toBe('No finished turn yet.');
  });
});
