import { describe, expect, it } from 'vitest';
import { groupColorIndex } from '../../../src/components/charts/agent-graph-layout';
import {
  flowChart,
  flowChartDescription,
  flowFacts,
  flowGroupOrder,
  flowsPaging,
  flowHref,
  flowKpis,
  flowsListHref,
  mcpText,
  parseFlowKey,
  skillsText,
  stageBar,
  STEP_LABEL_CHARS,
  stepPhaseBars,
  toFlowTableRows,
  toStepRows,
  turnHref,
  usesSummary,
} from '../../../src/app/(dashboard)/flows/_helpers';
import type { Flow, FlowStep } from '../../../src/lib/queries/flows';

const T0 = Date.parse('2026-10-08T10:00:00Z');
const S = 1000;
const STAGES = ['impl', 'verify'];
const tokens = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total });
const cost = (usd: number) => ({ usd, partial: false, unknownModels: [] });

const step = (runId: string, label: string, stageName: string | null, startS: number, endS: number, over: Partial<FlowStep> = {}): FlowStep => ({
  runId,
  parentRunId: null,
  agentType: `workflow:${label}`,
  label,
  group: stageName ? `workflow:${stageName}` : 'workflow',
  stageIndex: stageName === null ? null : (STAGES.indexOf(stageName) >= 0 ? STAGES.indexOf(stageName) : null),
  stageName,
  model: 'claude-opus',
  effort: 'high',
  depth: 1,
  startedMs: T0 + startS * S,
  endedMs: T0 + endS * S,
  durationMs: (endS - startS) * S,
  offsetMs: startS * S,
  tokens: tokens(100),
  cost: cost(0.5),
  outcome: 'success',
  phasesMs: null,
  skills: null,
  mcp: null,
  inLinks: [],
  ...over,
});

const flow = (over: Partial<Flow> = {}): Flow => {
  const steps = over.steps ?? [step('r1', 'impl-a', 'impl', 0, 60), step('r2', 'verify-a', 'verify', 70, 100)];
  return {
    id: 't1~wf-1',
    turnId: '11111111-1111-4111-8111-111111111111',
    key: 'wf-1',
    kind: 'workflow',
    name: 'impl → verify',
    turn: { id: '11111111-1111-4111-8111-111111111111', startedMs: T0 - 5 * S, projectId: 'p1', projectName: 'shop', harness: 'claude-code', summary: 'build it', isMine: true },
    steps,
    stages: ['impl', 'verify'],
    startedMs: T0,
    endedMs: T0 + 100 * S,
    durationMs: 100 * S,
    tokens: tokens(200),
    cost: cost(1),
    models: ['claude-opus'],
    efforts: ['high'],
    outcome: 'success',
    links: [{ fromRunId: 'r1', toRunId: 'r2', kind: 'item' }],
    skills: null,
    mcp: null,
    ...over,
  };
};

describe('flows list helpers', () => {
  it('builds list hrefs keeping filters and resetting page', () => {
    expect(flowsListHref({ range: '7d', page: '2' }, { outcome: 'failed' })).toBe('/flows?range=7d&outcome=failed');
    expect(flowsListHref({ outcome: 'failed' }, { outcome: null })).toBe('/flows');
    expect(flowsListHref({ range: '7d', outcome: 'failed' }, { page: 2 })).toBe('/flows?range=7d&outcome=failed&page=2');
    expect(flowsListHref({ range: ['7d', '30d'] }, { page: 1 })).toBe('/flows?range=7d');
  });

  it('links a flow to its detail page and its turn', () => {
    const f = flow();
    expect(flowHref(f)).toBe(`/flows/${f.turnId}/wf-1?startedMs=${T0 - 5 * S}`);
    expect(flowHref({ ...f, key: 'a b' })).toBe(`/flows/${f.turnId}/a%20b?startedMs=${T0 - 5 * S}`);
    expect(turnHref(f.turn)).toBe(`/turns/${f.turnId}?startedMs=${T0 - 5 * S}`);
  });

  it('parses the key segment defensively', () => {
    expect(parseFlowKey('wf-1')).toBe('wf-1');
    expect(parseFlowKey('seq-abc')).toBe('seq-abc');
    expect(parseFlowKey('wf%3A1')).toBe('wf:1');
    expect(parseFlowKey('%E0%A4%A')).toBeNull();
    expect(parseFlowKey('a b')).toBeNull();
    expect(parseFlowKey('x'.repeat(129))).toBeNull();
    expect(parseFlowKey(undefined)).toBeNull();
  });

  it('maps flows to table rows', () => {
    const [row] = toFlowTableRows([flow(), flow({ kind: 'sequence', stages: [], models: [], turn: { ...flow().turn, projectId: null, projectName: null } })]);
    expect(row).toEqual({
      id: 't1~wf-1',
      href: flowHref(flow()),
      startedMs: T0,
      project: 'shop',
      name: 'impl → verify',
      kind: 'workflow',
      steps: 2,
      stages: 'impl → verify',
      durationMs: 100 * S,
      tokens: 200,
      cost: cost(1),
      models: 'claude-opus',
      outcome: 'success',
    });
    const seq = toFlowTableRows([flow({ kind: 'sequence', stages: [], models: [], turn: { ...flow().turn, projectId: null, projectName: null } })])[0]!;
    expect([seq.kind, seq.stages, seq.models, seq.project]).toEqual(['agent sequence', null, null, 'no project']);
    expect(toFlowTableRows([flow({ kind: 'legacy-workflow' })])[0]!.kind).toBe('workflow (legacy)');
  });

  it('pages the list and handles a page past the end', () => {
    expect(flowsPaging(1, 50, 42, 42)).toMatchObject({ first: 1, last: 42, lastPage: 1, pastEnd: false, hasPrev: false, hasNext: false });
    expect(flowsPaging(2, 50, 120, 50)).toMatchObject({ first: 51, last: 100, hasPrev: true, hasNext: true });
    const past = flowsPaging(2, 50, 42, 0);
    expect(past).toMatchObject({ lastPage: 1, pastEnd: true, hasPrev: false, hasNext: false });
    expect(past.emptyMessage).toMatch(/past the last page/);
    expect(flowsPaging(1, 50, 0, 0)).toMatchObject({ pastEnd: false, emptyMessage: expect.stringMatching(/No multi-step/) });
  });

  it('builds KPI tiles from the range totals', () => {
    const k = flowKpis({ flows: 4, steps: 10, tokens: 12_345, cost: cost(2.5) });
    expect(k.map((x) => x.label)).toEqual(['Flows', 'Steps', 'Tokens', '≈ Cost']);
    expect(k.map((x) => x.value)).toEqual(['4', '10', '12k', '≈ $2.50']);
    expect(k[1]!.sub).toBe('2.5 per flow');
    expect(flowKpis({ flows: 0, steps: 0, tokens: tokens(0), cost: cost(0) })[1]!.sub).toBeUndefined();
    expect(flowKpis({ flows: 1, steps: 2, tokens: tokens(5), cost: cost(0) }, true)[0]!.sub).toMatch(/cut/);
  });
});

describe('flow detail helpers', () => {
  it('lists the facts', () => {
    const facts = flowFacts(flow({ efforts: [] }));
    const by = Object.fromEntries(facts.map((f) => [f.label, f]));
    expect(by.Outcome).toMatchObject({ value: 'success', kind: 'outcome' });
    expect(by.Turn).toMatchObject({ value: 'build it', href: turnHref(flow().turn) });
    expect(by.Started!.value).toBe('2026-10-08 10:00:00 UTC');
    expect(by.Duration!.value).toBe('1m 40s');
    expect(by.Stages!.value).toBe('impl → verify');
    expect(by['Models · efforts']!.value).toBe('claude-opus · —');
    expect(by.Kind!.value).toBe('workflow');
  });

  it('maps steps to rows with skills and MCP calls', () => {
    const f = flow({
      steps: [
        step('r1', 'impl-a', 'impl', 0, 60, { skills: { tdd: { model: 2, user: 1 }, 'sha256:0123456789abcdef0123': { model: 1, user: 0 } } }),
        step('r2', 'verify-a', 'verify', 70, 100, { mcp: { github: { search: 1, get: 3 } }, outcome: 'failed' }),
      ],
    });
    const rows = toStepRows(f);
    expect(rows.map((r) => [r.n, r.stage, r.label, r.offsetMs, r.durationMs, r.tokens, r.outcome])).toEqual([
      [1, 'impl', 'impl-a', 0, 60 * S, 100, 'success'],
      [2, 'verify', 'verify-a', 70 * S, 30 * S, 100, 'failed'],
    ]);
    expect(rows[0]!.skills).toBe('tdd ×3, sha256:01234567… ×1');
    expect(rows[0]!.mcp).toBeNull();
    expect(rows[1]!.mcp).toBe('github/get ×3, github/search ×1');
  });

  it('formats skills and MCP text, null when empty', () => {
    expect(skillsText(null)).toBeNull();
    expect(skillsText({ a: { model: 0, user: 0 } })).toBeNull();
    expect(mcpText({ s: {} })).toBeNull();
  });

  it('summarizes the flow skills & MCP like turn detail', () => {
    expect(usesSummary({ skills: null, mcp: null })).toEqual({ skills: null, mcp: [] });
    const u = usesSummary({ skills: { b: { model: 1, user: 0 }, a: { model: 2, user: 2 } }, mcp: { zed: { x: 1 }, alpha: { q: 2, r: 5 }, none: { y: 0 } } });
    expect(u.skills).toBe('a (typed ×2) (by the model ×2), b (by the model ×1)');
    expect(u.mcp).toEqual([
      { server: 'alpha', label: 'alpha', calls: 'r ×5, q ×2' },
      { server: 'zed', label: 'zed', calls: 'x ×1' },
    ]);
  });

  it('sums step time per stage, only with more than one stage', () => {
    expect(stageBar(flow())).toEqual({ keys: ['impl', 'verify'], values: { impl: 60 * S, verify: 30 * S }, colorIndex: { impl: 0, verify: 1 } });
    expect(stageBar(flow({ stages: ['impl'] }))).toBeNull();
    expect(stageBar(flow({ stages: [] }))).toBeNull();
    const withLoose = flow({ steps: [step('r1', 'a', 'impl', 0, 10), step('r2', 'b', 'verify', 10, 20), step('r3', 'c', null, 0, 5)] });
    expect(stageBar(withLoose)).toEqual({
      keys: ['impl', 'verify', 'unstaged'],
      values: { impl: 10 * S, verify: 10 * S, unstaged: 5 * S },
      colorIndex: { impl: 0, verify: 1, unstaged: 2 },
    });
  });

  it('gives each stage the colour its main group has in the Flow card, in stage order', () => {
    // Group counts would rank verify (3 steps) and fix (2) before review (1); the stage ranking must win.
    const STG = ['review', 'verify', 'fix'];
    const at = (runId: string, group: string, stage: number, startS: number) =>
      step(runId, `${group}-${runId}`, null, startS, startS + 10, { group: `workflow:${group}`, stageIndex: stage, stageName: STG[stage]! });
    const f = flow({
      stages: STG,
      steps: [at('a', 'review', 0, 0), at('b', 'verify', 1, 20), at('c', 'verify', 1, 20), at('d', 'verify', 1, 20), at('e', 'fix', 2, 40), at('g', 'fix', 2, 40), at('h', 'odd', 2, 40)],
    });
    expect(flowGroupOrder(f)).toEqual(['workflow:review', 'workflow:verify', 'workflow:fix']);
    const bar = stageBar(f)!;
    expect(bar.keys).toEqual(['review', 'verify', 'fix']);
    expect(bar.colorIndex).toEqual({ review: 0, verify: 1, fix: 2 });
    // the same palette index AgentFlow computes for the stage's main group from the chart props
    const chart = flowChart(f);
    const idx = groupColorIndex(chart.nodes.map((n) => n.group), chart.groupOrder);
    expect(STG.map((st) => idx.get(`workflow:${st}`))).toEqual([0, 1, 2]);
    expect(idx.get('workflow:odd')).toBe(3);
  });

  it('builds per-step phase rows with unique labels', () => {
    expect(stepPhaseBars(flow())).toBeNull();
    const f = flow({
      steps: [
        step('r1', 'impl', 'impl', 0, 60, { phasesMs: { coding: 30_000, testing: 10_000, idle: 0 } }),
        step('r2', 'impl', 'impl', 60, 70),
        step('r3', 'impl', 'verify', 70, 100, { phasesMs: { testing: 25_000 } }),
      ],
    });
    expect(stepPhaseBars(f)).toEqual({
      keys: ['testing', 'coding'],
      rows: [
        { label: '#1 impl', values: { coding: 30_000, testing: 10_000 } },
        { label: '#3 impl', values: { testing: 25_000 } },
      ],
    });
  });

  it('cuts long step labels at the end so the right-aligned axis keeps #n and the start of the name', () => {
    const long = 'review-collector-math-and-more';
    const bars = stepPhaseBars(flow({ steps: [step('r1', long, 'impl', 0, 10, { phasesMs: { coding: 1 } }), step('r2', 'short', 'verify', 10, 20, { phasesMs: { coding: 1 } })] }))!;
    expect(bars.rows.map((r) => r.label)).toEqual([`#1 ${long.slice(0, STEP_LABEL_CHARS - 1)}…`, '#2 short']);
  });

  it('describes the Flow card by kind', () => {
    expect(flowChartDescription(flow())).toMatch(/one row per stage/);
    expect(flowChartDescription(flow({ kind: 'sequence', stages: [] }))).not.toMatch(/per stage/);
    expect(flowChartDescription(flow({ kind: 'legacy-workflow', stages: [] }))).toMatch(/no stages/);
  });

  it('draws the flow as one lane with its stages, steps and links', () => {
    const f = flow({
      steps: [step('r1', 'impl-a', 'impl', 0, 60), step('r2', 'verify-a', 'verify', 70, 100), step('r3', 'odd', null, 80, 90)],
      links: [
        { fromRunId: 'r1', toRunId: 'r2', kind: 'item' },
        { fromRunId: 'r1', toRunId: 'r2', kind: 'item' },
        { fromRunId: 'r2', toRunId: 'r2', kind: 'sequence' },
        { fromRunId: 'zz', toRunId: 'r2', kind: 'sequence' },
      ],
    });
    const c = flowChart(f);
    expect(c.lanes).toEqual([{ id: 'flow', label: 'impl → verify', sublabel: 'shop · claude-code', stages: ['impl', 'verify'] }]);
    expect(c.nodes.map((n) => [n.id, n.laneId, n.stageIndex, n.href])).toEqual([
      ['r1', 'flow', 0, null],
      ['r2', 'flow', 1, null],
      ['r3', 'flow', null, null],
    ]);
    expect(c.edges).toEqual([{ fromId: 'r1', toId: 'r2', kind: 'item' }]);
    // 2% of 100 s = 2 s padding on each side
    expect([c.fromMs, c.toMs]).toEqual([T0 - 2 * S, T0 + 102 * S]);
  });

  it('pads a short flow by at least a second', () => {
    const c = flowChart(flow({ steps: [step('r1', 'a', null, 0, 0), step('r2', 'b', null, 0, 0)], stages: [], endedMs: T0 }));
    expect([c.fromMs, c.toMs]).toEqual([T0 - S, T0 + S]);
    expect(c.lanes[0]!.stages).toEqual([]);
    expect(c.nodes.every((n) => n.stageIndex === null)).toBe(true);
  });
});
