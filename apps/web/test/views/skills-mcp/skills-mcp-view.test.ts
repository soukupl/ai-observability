import { describe, expect, it } from 'vitest';
import { anyHashed, daySeries, displayName, errorRate, isUnreliable, latencyPercentile, skillTableRows, totals } from '../../../src/app/(dashboard)/skills-mcp/skills-mcp-view';
import type { SkillsMcpResult } from '../../../src/lib/queries/skills-mcp';

const H = `sha256:${'ab'.repeat(32)}`;
const rel = { errors: 0, denied: 0, latencyMs: 0, buckets: [0, 0, 0, 0, 0] };
const result = (over: Partial<SkillsMcpResult> = {}): SkillsMcpResult => ({
  range: { fromDay: '2026-10-01', toDay: '2026-10-04', fromIso: '', toIso: '', days: 3, source: 'raw', rawCovers: true },
  skills: [
    { name: 'code-review', calls: 4, modelCalls: 3, userCalls: 1, turns: 3, users: 2 },
    { name: 'ship-check', calls: 1, modelCalls: 0, userCalls: 1, turns: 1, users: 1 },
  ],
  servers: [{ name: 'github', calls: 5, turns: 2, users: 1, ...rel, tools: [{ tool: 'search_code', calls: 5, turns: 2, users: 1, ...rel }] }],
  days: [
    { day: '2026-10-01', kind: 'skill', name: 'code-review', calls: 3 },
    { day: '2026-10-03', kind: 'skill', name: 'code-review', calls: 1 },
    { day: '2026-10-03', kind: 'skill', name: 'ship-check', calls: 1 },
    { day: '2026-10-02', kind: 'mcp', name: 'github', calls: 5 },
  ],
  ignoredFilters: [],
  ...over,
});

describe('skills & MCP view helpers', () => {
  it('maps skill rows with the typed share', () => {
    expect(skillTableRows(result())[0]).toEqual({ name: 'code-review', calls: 4, modelCalls: 3, userCalls: 1, userShare: 0.25, turns: 3, users: 2, successDelta: null, costDelta: null });
  });

  it('zero-fills every day of the range and folds the tail into other', () => {
    const s = daySeries(result(), 'skill', 1);
    expect(s.series).toEqual(['code-review', 'other']);
    expect(s.data).toEqual([
      { x: '2026-10-01', 'code-review': 3, other: 0 },
      { x: '2026-10-02', 'code-review': 0, other: 0 },
      { x: '2026-10-03', 'code-review': 1, other: 1 },
    ]);
    expect(daySeries(result(), 'mcp').data.map((r) => r.github)).toEqual([0, 5, 0]);
  });

  it('totals and hashed names', () => {
    expect(totals(result())).toEqual({ skillUses: 5, typedShare: 0.4, mcpCalls: 5, mcpTools: 1 });
    expect(totals(result({ skills: [], servers: [] })).typedShare).toBeNull();
    expect(displayName(H)).toBe('sha256:abababab…');
    expect(displayName('github')).toBe('github');
    expect(anyHashed(result())).toBe(false);
    expect(anyHashed(result({ servers: [{ name: H, calls: 1, turns: 1, users: 1, ...rel, tools: [] }] }))).toBe(true);
  });

  it('latency percentiles by bucket, error rate without refused calls, highlight rule', () => {
    expect(latencyPercentile([8, 1, 1, 0, 0], 0.5)).toBe('< 1 s');
    expect(latencyPercentile([8, 1, 1, 0, 0], 0.95)).toBe('5–30 s');
    expect(latencyPercentile([0, 0, 0, 0, 0], 0.5)).toBeNull();
    expect(errorRate({ calls: 12, errors: 1, denied: 2 })).toBeCloseTo(0.1);
    expect(errorRate({ calls: 2, errors: 0, denied: 2 })).toBeNull();
    expect(errorRate({ calls: 48, errors: 0, denied: 0, buckets: [0, 0, 0, 0, 0] })).toBeNull(); // no results recorded
    expect(errorRate({ calls: 4, errors: 0, denied: 0, buckets: [4, 0, 0, 0, 0] })).toBe(0);
    expect(isUnreliable({ calls: 20, errors: 2, denied: 0 })).toBe(true);
    expect(isUnreliable({ calls: 19, errors: 10, denied: 0 })).toBe(false);
  });
});
