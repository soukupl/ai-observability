import { describe, expect, it } from 'vitest';
import {
  allFlowsHref,
  COMPLEX_MAX_ROWS,
  COMPLEX_MIN_DURATION_MS,
  COMPLEX_MIN_STEPS,
  COMPLEX_MIN_TOKENS,
  complexFlows,
  complexReasons,
  ingestSummary,
  relativeAgo,
} from '../../../src/app/(dashboard)/overview/helpers';
import type { Flow, FlowStep } from '../../../src/lib/queries/flows';
import { ZERO_COST } from '../../../src/lib/cost';

const step = (i: number): FlowStep => ({
  runId: `r${i}`, parentRunId: null, agentType: 'Explore', label: 'Explore', group: 'Explore', stageIndex: null, stageName: null,
  model: 'm', effort: null, depth: 1, startedMs: 0, endedMs: 1000, durationMs: 1000, offsetMs: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }, cost: ZERO_COST, outcome: 'success',
  phasesMs: null, skills: null, mcp: null, inLinks: [],
});

const flow = (o: { id: string; steps?: number; durationMs?: number; tokens?: number; startedMs?: number }): Flow => ({
  id: o.id,
  turnId: 't1',
  key: o.id,
  kind: 'sequence',
  name: `flow ${o.id}`,
  turn: { id: 't1', startedMs: o.startedMs ?? 1_700_000_000_000, projectId: 'p', projectName: 'proj', harness: 'claude-code', summary: null, isMine: true },
  steps: Array.from({ length: o.steps ?? 2 }, (_, i) => step(i)),
  stages: [],
  startedMs: o.startedMs ?? 1_700_000_000_000,
  endedMs: (o.startedMs ?? 1_700_000_000_000) + (o.durationMs ?? 1000),
  durationMs: o.durationMs ?? 1000,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: o.tokens ?? 0 },
  cost: ZERO_COST,
  models: ['m'],
  efforts: [],
  outcome: 'success',
  links: [],
  skills: null,
  mcp: null,
});

describe('complexReasons / complexFlows', () => {
  it('passes on any one threshold, in a fixed reason order', () => {
    expect(complexReasons(flow({ id: 'a' }))).toEqual([]);
    expect(complexReasons(flow({ id: 'b', steps: COMPLEX_MIN_STEPS }))).toEqual(['steps']);
    expect(complexReasons(flow({ id: 'c', durationMs: COMPLEX_MIN_DURATION_MS }))).toEqual(['duration']);
    expect(complexReasons(flow({ id: 'd', tokens: COMPLEX_MIN_TOKENS }))).toEqual(['tokens']);
    expect(complexReasons(flow({ id: 'e', steps: 9, durationMs: 3_600_000, tokens: 2e6 }))).toEqual(['steps', 'duration', 'tokens']);
  });

  it('sorts by duration then tokens and cuts at the cap', () => {
    const flows = [
      flow({ id: 'short-many-tokens', steps: 5, durationMs: 1000, tokens: 5e6 }),
      flow({ id: 'long', steps: 2, durationMs: 60 * 60_000 }),
      flow({ id: 'plain' }),
      flow({ id: 'short-few-tokens', steps: 5, durationMs: 1000, tokens: 10 }),
      ...Array.from({ length: 10 }, (_, i) => flow({ id: `mid${i}`, steps: 6, durationMs: 30 * 60_000 })),
    ];
    const rows = complexFlows(flows);
    expect(rows).toHaveLength(COMPLEX_MAX_ROWS);
    expect(rows[0]!.id).toBe('long');
    expect(rows.map((r) => r.id)).not.toContain('plain');
    // the two 1-second flows fall off the end (10 mid flows are longer)
    expect(rows.map((r) => r.id)).not.toContain('short-many-tokens');
    const two = complexFlows([flows[0]!, flows[3]!]);
    expect(two.map((r) => r.id)).toEqual(['short-many-tokens', 'short-few-tokens']);
  });

  it('shapes a row with link, labels and counts', () => {
    const [r] = complexFlows([flow({ id: 'seq-r0', steps: 5, startedMs: 1_700_000_000_000 })]);
    expect(r).toMatchObject({
      id: 'seq-r0',
      href: '/turns/t1?startedMs=1700000000000#flow-seq-r0',
      name: 'flow seq-r0',
      kind: 'agent sequence',
      projectName: 'proj',
      steps: 5,
      stages: 0,
      outcome: 'success',
      reasons: ['steps'],
    });
  });
});

describe('allFlowsHref', () => {
  it('keeps the filters and drops page / outcome', () => {
    expect(allFlowsHref({ range: '7d', teamId: 't', page: '3', outcome: 'failed', x: undefined })).toBe('/flows?range=7d&teamId=t');
    expect(allFlowsHref({})).toBe('/flows');
  });
});

describe('relativeAgo / ingestSummary', () => {
  const now = 1_700_000_000_000;
  it.each([
    [null, 'never'],
    [now - 10_000, 'just now'],
    [now - 3 * 60_000, '3 min ago'],
    [now - 5 * 3_600_000, '5 h ago'],
    [now - 3 * 86_400_000, '3 d ago'],
  ])('%s -> %s', (ms, text) => expect(relativeAgo(ms, now)).toBe(text));

  it('groups types, drops empty groups and finds the last arrival', () => {
    const s = ingestSummary(
      [
        { type: 'turn', events24h: 10, events7d: 50, lastReceivedMs: now - 60_000 },
        { type: 'run', events24h: 4, events7d: 40, lastReceivedMs: now - 120_000 },
        { type: 'turn_outcome', events24h: 3, events7d: 9, lastReceivedMs: now - 5_000 },
        { type: 'turn_summary', events24h: 3, events7d: 9, lastReceivedMs: null },
        { type: 'session_start', events24h: 0, events7d: 2, lastReceivedMs: now - 86_400_000 },
        { type: 'marker', events24h: 1, events7d: 1, lastReceivedMs: now - 10 * 60_000 },
      ],
      now,
    );
    expect(s.lastMs).toBe(now - 5_000);
    expect(s.ago).toBe('just now');
    expect(s.total24h).toBe(21);
    expect(s.total7d).toBe(111);
    expect(s.byType24h).toEqual([
      { label: 'turns', count: 10 },
      { label: 'patches', count: 6 },
      { label: 'runs', count: 4 },
      { label: 'other', count: 1 },
    ]);
  });

  it('is "never" on an empty ledger', () => {
    expect(ingestSummary([], now)).toEqual({ lastMs: null, ago: 'never', total24h: 0, total7d: 0, byType24h: [] });
  });
});
