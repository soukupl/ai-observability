import { describe, expect, it } from 'vitest';
import {
  assignFlowRows,
  chain,
  edgeChain,
  edgeKey,
  edgePath,
  fitLabel,
  FLOW_LAYOUT_DEFAULTS,
  flowLayout,
  linkCounts,
  MIN_PILL_W,
  nodeGeometry,
  nodeY,
  rowHeight,
  stageRowOf,
  tooltipPosition,
  UNSTAGED_LABEL,
  visibleSpan,
  type FlowEdge,
  type FlowLane,
  type FlowNode,
} from '../../src/components/charts/agent-flow-layout';
import { timeScale } from '../../src/components/charts/agent-graph-layout';

const MIN = 60_000;
const DAY0 = Date.parse('2026-10-08T00:00:00Z');
const at = (h: number, m = 0, s = 0) => DAY0 + h * 3_600_000 + m * MIN + s * 1000;

const lane = (id: string, stages: string[] = [], sublabel: string | null = null): FlowLane => ({ id, label: id, sublabel, stages });
const node = (id: string, laneId: string, stageIndex: number | null, startMs: number, endMs: number, extra: Partial<FlowNode> = {}): FlowNode => ({
  id,
  laneId,
  label: id,
  group: 'review',
  stageIndex,
  startMs,
  endMs,
  outcome: 'success',
  model: null,
  href: null,
  ...extra,
});
const edge = (fromId: string, toId: string, kind: FlowEdge['kind'] = 'item'): FlowEdge => ({ fromId, toId, kind });

const { top, rowH, subRowH, laneGap, labelMinH } = FLOW_LAYOUT_DEFAULTS;

describe('stageRowOf', () => {
  it('maps a known stage to its row, null / out-of-range / non-integer to the unstaged row, and everything to row 0 without stages', () => {
    const staged = lane('W', ['review', 'verify', 'fix']);
    expect(stageRowOf({ stageIndex: 1 }, staged)).toBe(1);
    expect(stageRowOf({ stageIndex: null }, staged)).toBe(3);
    expect(stageRowOf({ stageIndex: 7 }, staged)).toBe(3);
    expect(stageRowOf({ stageIndex: -1 }, staged)).toBe(3);
    expect(stageRowOf({ stageIndex: 1.5 }, staged)).toBe(3);
    expect(stageRowOf({ stageIndex: 2 }, lane('T'))).toBe(0);
    expect(stageRowOf({ stageIndex: null }, lane('T'))).toBe(0);
  });
});

describe('assignFlowRows', () => {
  const lanes = [lane('W', ['review', 'verify']), lane('T')];

  it('puts nodes on their stage rows and keeps empty stage rows', () => {
    const a = assignFlowRows([lane('W', ['plan', 'review', 'verify'])], [node('v', 'W', 2, at(9), at(9, 5))]);
    expect(a.placement.get('v')).toEqual({ laneId: 'W', row: 2, subRow: 0 });
    expect(a.rowSubRows.get('W')).toEqual([1, 1, 1]);
    expect(a.unstaged.get('W')).toBe(false);
  });

  it('adds an unstaged last row only when a staged lane has nodes without a stage', () => {
    const a = assignFlowRows(lanes, [node('r', 'W', 0, at(9), at(9, 5)), node('u', 'W', null, at(9), at(9, 5)), node('t', 'T', null, at(9), at(9, 5))]);
    expect(a.placement.get('u')).toEqual({ laneId: 'W', row: 2, subRow: 0 });
    expect(a.rowSubRows.get('W')).toEqual([1, 1, 1]);
    expect(a.unstaged.get('W')).toBe(true);
    // A lane without stages has one row and never an unstaged one.
    expect(a.placement.get('t')).toEqual({ laneId: 'T', row: 0, subRow: 0 });
    expect(a.rowSubRows.get('T')).toEqual([1]);
    expect(a.unstaged.get('T')).toBe(false);
  });

  it('gives nodes that overlap in time inside one row their own sub-rows and reuses a sub-row for serial nodes', () => {
    const a = assignFlowRows(lanes, [
      node('r1', 'W', 0, at(9, 0), at(9, 10)),
      node('r2', 'W', 0, at(9, 5), at(9, 15)),
      node('r3', 'W', 0, at(9, 10), at(9, 20)), // r1 ended exactly at its start
      node('r4', 'W', 0, at(9, 12), at(9, 13)),
      node('v1', 'W', 1, at(9, 5), at(9, 15)), // other row: does not compete with r*
    ]);
    expect(['r1', 'r2', 'r3', 'r4'].map((id) => a.placement.get(id)!.subRow)).toEqual([0, 1, 0, 2]);
    expect(a.placement.get('v1')!.subRow).toBe(0);
    expect(a.rowSubRows.get('W')).toEqual([3, 1]);
  });

  it('breaks start ties by id, independent of input order', () => {
    const a = assignFlowRows(lanes, [node('b', 'W', 0, at(9), at(9, 5)), node('a', 'W', 0, at(9), at(9, 5))]);
    expect(a.placement.get('a')!.subRow).toBe(0);
    expect(a.placement.get('b')!.subRow).toBe(1);
  });

  it('holds a sub-row for at least minSpanMs', () => {
    const serial = [node('s1', 'T', null, at(9), at(9, 0, 1)), node('s2', 'T', null, at(9, 0, 2), at(9, 0, 3))];
    expect(assignFlowRows(lanes, serial).placement.get('s2')!.subRow).toBe(0);
    expect(assignFlowRows(lanes, serial, { minSpanMs: 5000 }).placement.get('s2')!.subRow).toBe(1);
  });

  it('caps the sub-rows of a row and shares one overflow sub-row', () => {
    const burst = Array.from({ length: 5 }, (_, i) => node(`b${i}`, 'T', null, at(9, 0, i), at(9, 1)));
    const a = assignFlowRows(lanes, burst, { maxSubRows: 2 });
    expect(burst.map((n) => a.placement.get(n.id)!.subRow)).toEqual([0, 1, 2, 2, 2]);
    expect(a.rowSubRows.get('T')).toEqual([3]);
    expect([...a.overflow.values()]).toEqual([['b2', 'b3', 'b4']]);
  });

  it('skips nodes of unknown lanes', () => {
    const a = assignFlowRows(lanes, [node('x', 'gone', 0, at(9), at(9, 5))]);
    expect(a.placement.has('x')).toBe(false);
  });
});

describe('flowLayout / nodeY', () => {
  const lanes = [lane('W', ['review', 'verify']), lane('T', [], 'session abc'), lane('E')];
  const nodes = [
    node('r1', 'W', 0, at(9, 0), at(9, 10)),
    node('r2', 'W', 0, at(9, 5), at(9, 15)),
    node('v1', 'W', 1, at(9, 20), at(9, 30)),
    node('u1', 'W', null, at(9, 20), at(9, 30)),
    node('t1', 'T', null, at(9), at(9, 5)),
  ];
  const layout = flowLayout(lanes, nodes);

  it('row heights: rowH for the first sub-row, subRowH for each further one', () => {
    expect(rowHeight(1)).toBe(22);
    expect(rowHeight(3)).toBe(22 + 2 * 20);
    expect(rowHeight(0)).toBe(22);
  });

  it('stacks lanes under the axis, laneGap apart, with stage rows and the unstaged row', () => {
    const [w, tl, e] = layout.lanes;
    expect(w!.top).toBe(top);
    expect(w!.rows.map((r) => [r.index, r.label, r.unstaged, r.subRows, r.top, r.height])).toEqual([
      [0, 'review', false, 2, top, rowH + subRowH],
      [1, 'verify', false, 1, top + rowH + subRowH, rowH],
      [2, UNSTAGED_LABEL, true, 1, top + 2 * rowH + subRowH, rowH],
    ]);
    expect(w!.height).toBe(3 * rowH + subRowH);
    // A lane with a sublabel is at least labelMinH tall; its single row has no stage label.
    expect(tl!.top).toBe(w!.top + w!.height + laneGap);
    expect(tl!.rows).toEqual([{ index: 0, label: null, unstaged: false, top: tl!.top, height: rowH, subRows: 1, overflow: 0 }]);
    expect(tl!.height).toBe(labelMinH);
    // An empty lane still gets its row.
    expect(e!.top).toBe(tl!.top + labelMinH + laneGap);
    expect(e!.height).toBe(rowH);
    expect(layout.height).toBe(e!.top + rowH);
  });

  it('computes the total height from options', () => {
    const l = flowLayout([lane('A'), lane('B')], [], { top: 0, rowH: 10, laneGap: 4 });
    expect(l.height).toBe(10 + 4 + 10);
    expect(flowLayout([], []).height).toBe(top);
  });

  it('centres a node on its sub-row', () => {
    expect(nodeY('r1', layout)).toBe(top + rowH / 2);
    expect(nodeY('r2', layout)).toBe(top + rowH / 2 + subRowH);
    expect(nodeY('v1', layout)).toBe(top + rowH + subRowH + rowH / 2);
    expect(nodeY('missing', layout)).toBeNull();
  });

  it('reports overflow counts on the row', () => {
    const l = flowLayout([lane('A', ['s'])], Array.from({ length: 4 }, (_, i) => node(`n${i}`, 'A', 0, at(9), at(9, 1))), { maxSubRows: 2 });
    expect(l.lanes[0]!.rows[0]).toMatchObject({ subRows: 3, overflow: 2 });
  });
});

describe('nodeGeometry', () => {
  const lanes = [lane('T')];
  const nodes = [node('a', 'T', null, at(9), at(10)), node('dot', 'T', null, at(11), at(11)), node('off', 'T', null, at(13), at(14))];
  const layout = flowLayout(lanes, nodes);
  const scale = timeScale(at(9), at(12), 100, 300); // 100 px per hour

  it('spans start to end on the time scale at the sub-row centre', () => {
    expect(nodeGeometry(nodes[0]!, layout, scale)).toEqual({ x1: 100, x2: 200, y: top + rowH / 2 });
  });
  it('widens a zero-length node to the minimum pill width around its time', () => {
    const g = nodeGeometry(nodes[1]!, layout, scale)!;
    expect(g.x2 - g.x1).toBeCloseTo(MIN_PILL_W);
    expect((g.x1 + g.x2) / 2).toBeCloseTo(300);
  });
  it('returns null for nodes outside the window or not placed', () => {
    expect(nodeGeometry(nodes[2]!, layout, scale)).toBeNull();
    expect(nodeGeometry({ id: 'zz', startMs: at(9), endMs: at(10) }, layout, scale)).toBeNull();
  });
});

describe('edgePath', () => {
  it('is a cubic from the source end to the target start with horizontal tangents pulled half the distance', () => {
    expect(edgePath(100, 20, 200, 60)).toBe('M100,20C150,20 150,60 200,60');
  });
  it('pulls at least minPull px so a backward edge curves out and back', () => {
    expect(edgePath(200, 20, 190, 60)).toBe('M200,20C216,20 174,60 190,60');
    expect(edgePath(0, 0, 4, 0, 10)).toBe('M0,0C10,0 -6,0 4,0');
  });
  it('rounds to one decimal', () => {
    expect(edgePath(0.123, 1.06, 100.04, 2)).toBe('M0.1,1.1C50.1,1.1 50.1,2 100,2');
  });
});

describe('chain / edgeChain / linkCounts', () => {
  // a -> b -> c -> d, b -> e (branch), x -> c (second source), y isolated
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('b', 'e', 'sequence'), edge('x', 'c', 'sequence')];
  const k = (from: string, to: string, kind: FlowEdge['kind'] = 'item') => edgeKey(edge(from, to, kind));

  it('walks upstream and downstream transitively, not into sibling branches', () => {
    const c = chain('c', edges);
    expect([...c.nodes].sort()).toEqual(['a', 'b', 'c', 'd', 'x']);
    expect([...c.edges].sort()).toEqual([k('a', 'b'), k('b', 'c'), k('c', 'd'), k('x', 'c', 'sequence')].sort());
    expect(c.nodes.has('e')).toBe(false);
  });
  it('from the middle of a fork includes every branch downstream', () => {
    const c = chain('b', edges);
    expect([...c.nodes].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(c.nodes.has('x')).toBe(false); // x is upstream of c, not of b
  });
  it('a node without links is its own chain', () => {
    expect(chain('y', edges)).toEqual({ nodes: new Set(['y']), edges: new Set() });
  });
  it('survives cycles', () => {
    const c = chain('p', [edge('p', 'q'), edge('q', 'p')]);
    expect([...c.nodes].sort()).toEqual(['p', 'q']);
    expect(c.edges.size).toBe(2);
  });
  it('an edge chain is upstream of its source, the edge and downstream of its target', () => {
    const c = edgeChain(edge('b', 'e', 'sequence'), edges);
    expect([...c.nodes].sort()).toEqual(['a', 'b', 'e']);
    expect([...c.edges].sort()).toEqual([k('a', 'b'), k('b', 'e', 'sequence')].sort());
  });
  it('edge keys distinguish kinds', () => {
    expect(k('a', 'b')).not.toBe(k('a', 'b', 'sequence'));
  });
  it('counts incoming and outgoing links per node, a duplicated edge once', () => {
    const counts = linkCounts([...edges, edge('a', 'b')]);
    expect(counts.get('b')).toEqual({ in: 1, out: 2 });
    expect(counts.get('c')).toEqual({ in: 2, out: 1 });
    expect(counts.get('a')).toEqual({ in: 0, out: 1 });
    expect(counts.has('y')).toBe(false);
  });
});

describe('fitLabel', () => {
  it('keeps a label that fits, cuts one that does not, and drops it when too little fits', () => {
    expect(fitLabel('verify', 60)).toBe('verify'); // (60 - 10) / 6 = 8 chars
    expect(fitLabel('review:bugs-in-ingest', 60)).toBe('review:…');
    expect(fitLabel('review', 30)).toBeNull(); // 3 chars
    expect(fitLabel('abc', 30)).toBe('abc');
    expect(fitLabel('', 100)).toBeNull();
  });
});

describe('visibleSpan', () => {
  it('is the part of the pill inside the plot, so a pill starting before the window labels from the plot edge', () => {
    expect(visibleSpan({ x1: 136, x2: 260 }, 160, 900)).toEqual({ x: 160, width: 100 });
    expect(visibleSpan({ x1: 200, x2: 950 }, 160, 900)).toEqual({ x: 200, width: 700 });
    expect(visibleSpan({ x1: 300, x2: 340 }, 160, 900)).toEqual({ x: 300, width: 40 });
    expect(visibleSpan({ x1: 100, x2: 150 }, 160, 900)).toEqual({ x: 160, width: 0 });
    // the label of the overhanging pill is fitted to the visible width, not the full one
    const v = visibleSpan({ x1: 136, x2: 200 }, 160, 900);
    expect(fitLabel('collector-core', v.width)).toBe('coll…'); // 40px visible: (40 - 10) / 6 = 5 chars
    expect(fitLabel('collector-core', 200 - 136)).toBe('collecto…'); // the full 64px would claim 9
  });
});

describe('tooltipPosition', () => {
  const vp = { w: 1000, h: 700 };
  const size = { w: 240, h: 170 };
  it('opens below-right of the cursor when it fits', () => {
    expect(tooltipPosition({ x: 100, y: 100 }, size, vp)).toEqual({ left: 112, top: 112 });
  });
  it('flips above near the bottom and left near the right edge', () => {
    expect(tooltipPosition({ x: 100, y: 600 }, size, vp)).toEqual({ left: 112, top: 600 - 12 - 170 });
    expect(tooltipPosition({ x: 900, y: 100 }, size, vp)).toEqual({ left: 900 - 12 - 240, top: 112 });
  });
  it('stays inside the viewport when neither side fits', () => {
    expect(tooltipPosition({ x: 100, y: 100 }, { w: 240, h: 690 }, vp)).toEqual({ left: 112, top: 4 });
    expect(tooltipPosition({ x: 5, y: 5 }, size, { w: 200, h: 150 })).toEqual({ left: 4, top: 4 });
  });
});
