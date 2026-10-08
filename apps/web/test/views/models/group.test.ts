import { describe, expect, it } from 'vitest';
import { chartData, parseGrouping, primaryTurns, toTableRows } from '../../../src/app/(dashboard)/models/group';
import type { ModelRow } from '../../../src/lib/queries/models';

const tok = (n: number) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2 * n });
const cost = (usd: number | null) => ({ usd, partial: false, unknownModels: usd === null ? ['x'] : [] }) as ModelRow['cost'];
const row = (model: string | null, effort: string | null, turns: number, usd: number | null, s: number | null, u: number | null, med: number | null): ModelRow => ({
  model, effort, turns, tokens: tok(turns), cost: cost(usd), successRate: s, unknownShare: u, medianDurationMs: med, avgDurationMs: med,
});

describe('parseGrouping', () => {
  it('defaults to model x effort', () => {
    expect(parseGrouping(undefined)).toBe('effort');
    expect(parseGrouping('bogus')).toBe('effort');
    expect(parseGrouping('model')).toBe('model');
    expect(parseGrouping(['model', 'x'])).toBe('model');
  });
});

describe('toTableRows', () => {
  const rows = [row('a', 'high', 10, 2, 0.5, 0, 100), row('a', 'low', 30, 1, 1, 0.5, 200), row('b', null, 5, null, null, 1, 50)];
  it('keeps rows in effort mode and labels null as (unknown)', () => {
    const t = toTableRows(rows, 'effort');
    expect(t).toHaveLength(3);
    expect(t[2]?.effort).toBe('(unknown)');
  });
  it('merges per model, weighting rates by known turns', () => {
    const t = toTableRows(rows, 'model');
    const a = t.find((r) => r.model === 'a')!;
    expect(a.turns).toBe(40);
    expect(a.total).toBe(80);
    expect(a.cost.usd).toBe(3);
    expect(a.successRate).toBeCloseTo((0.5 * 10 + 1 * 15) / 25);
    expect(a.unknownShare).toBeCloseTo(15 / 40);
    expect(a.medianDurationMs).toBeNull();
    expect(t.find((r) => r.model === 'b')!.cost.usd).toBeNull();
    expect(t[0]?.model).toBe('a');
  });
});

describe('chartData', () => {
  it('drops null/zero, sorts and limits', () => {
    const t = toTableRows([row('a', 'x', 1, 1, 1, 0, 1), row('b', 'x', 1, null, 1, 0, 1), row('c', 'x', 1, 5, 1, 0, 1)], 'effort');
    const d = chartData(t, 'effort', (r) => r.cost.usd, 5);
    expect(d.map((x) => x.label)).toEqual(['c / x', 'a / x']);
  });
});

describe('sub-agent-only models (review V2)', () => {
  // turns 0 but tokens present: rendered as "no value" instead of a contradictory 0.
  const base = row('a', 'high', 10, 2, 1, 0, 100);
  const subOnly = { ...row('haiku', null, 0, 1, null, null, null), tokens: tok(5) };
  it('shows null primary turns when there are tokens but no primary turn', () => {
    expect(primaryTurns(0, 100)).toBeNull();
    expect(primaryTurns(0, 0)).toBe(0);
    expect(primaryTurns(3, 100)).toBe(3);
    const eff = toTableRows([base, subOnly], 'effort');
    expect(eff.find((r) => r.model === 'haiku')!.turns).toBeNull();
    expect(eff.find((r) => r.model === 'a')!.turns).toBe(10);
  });
  it('same in model-only grouping, and sums raw turns when several efforts merge', () => {
    const m = toTableRows([base, row('a', 'low', 30, 1, 1, 0, 1), subOnly, { ...subOnly, effort: 'low' }], 'model');
    expect(m.find((r) => r.model === 'haiku')!.turns).toBeNull();
    expect(m.find((r) => r.model === 'a')!.turns).toBe(40);
  });
});

describe('friendly model names', () => {
  const rows = [row('claude-opus-5-5', 'high', 10, 5, 1, 0, 1), row('claude-opus-5-5-20251101', 'high', 10, 3, 1, 0, 1), row(null, null, 1, 1, 1, 0, 1)];
  it('adds provider and keeps the raw model id', () => {
    const t = toTableRows(rows, 'effort');
    expect(t.map((r) => r.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5-20251101', '(unknown)']);
    expect(t.map((r) => r.provider)).toEqual(['Anthropic', 'Anthropic', '—']);
  });
  it('labels charts with friendly names, one bar per row, raw ids where names collide', () => {
    expect(chartData(toTableRows(rows, 'effort'), 'effort', (r) => r.cost.usd)).toEqual([
      { label: 'claude-opus-5-5 / high', value: 5 },
      { label: 'claude-opus-5-5-20251101 / high', value: 3 },
      { label: '(unknown) / (unknown)', value: 1 },
    ]);
    const single = [row('claude-opus-5-5', 'high', 10, 5, 1, 0, 1), row('claude-sonnet-5-5', 'low', 10, 3, 1, 0, 1)];
    expect(chartData(toTableRows(single, 'model'), 'model', (r) => r.cost.usd).map((d) => d.label)).toEqual(['Opus 5.5', 'Sonnet 5.5']);
  });
});
