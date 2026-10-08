import { describe, expect, it } from 'vitest';
import { chartRows, formatHours, formatShare, parseGroup, totalRow } from '../../../src/app/(dashboard)/phases/helpers';
import { PHASES, type Phase, type PhaseRow } from '../../../src/lib/queries/phases';

const mk = (label: string, part: Partial<Record<Phase, number>>): PhaseRow => {
  const ms = Object.fromEntries(PHASES.map((p) => [p, part[p] ?? 0])) as Record<Phase, number>;
  const totalMs = PHASES.reduce((s, p) => s + ms[p], 0);
  const share = Object.fromEntries(PHASES.map((p) => [p, totalMs ? ms[p] / totalMs : 0])) as Record<Phase, number>;
  return { key: label, label, ms, totalMs, share };
};

describe('parseGroup', () => {
  it('defaults and validates', () => {
    expect(parseGroup(undefined)).toBe('team');
    expect(parseGroup('nope')).toBe('team');
    expect(parseGroup('model')).toBe('model');
    expect(parseGroup(['project', 'model'])).toBe('project');
  });
});

describe('formatting', () => {
  it('hours', () => {
    expect(formatHours(0)).toBe('0 h');
    expect(formatHours(1_800_000)).toBe('0.5 h');
    expect(formatHours(36_000)).toBe('0.01 h');
    expect(formatHours(12 * 3_600_000)).toBe('12 h');
    expect(formatHours(2500 * 3_600_000)).toBe('2.5k h');
  });
  it('share', () => {
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.004)).toBe('<1%');
    expect(formatShare(0.456)).toBe('46%');
  });
});

describe('rows', () => {
  const rows = [mk('a', { coding: 3_600_000, testing: 3_600_000 }), mk('empty', {}), mk('b', { coding: 7_200_000 })];
  it('chartRows drops empty rows', () => {
    expect(chartRows(rows).map((r) => r.label)).toEqual(['a', 'b']);
  });
  it('chartRows shows friendly model names only when grouped by model; one row per id, raw id where names collide', () => {
    const models = [mk('claude-opus-5-5', { coding: 1000 }), mk('claude-sonnet-4-5', { coding: 500 }), mk('claude-sonnet-4-5-20250929', { testing: 250 })];
    expect(chartRows(models, 'team').map((r) => r.label)).toEqual(['claude-opus-5-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']);
    const byModel = chartRows(models, 'model');
    expect(byModel.map((r) => r.label)).toEqual(['Opus 5.5', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929']);
    expect(byModel.map((r) => r.values.coding)).toEqual([1000, 500, 0]);
    expect(chartRows([mk('claude-haiku-4-5', { coding: 1 })], 'model')[0]!.label).toBe('Haiku 4.5');
    expect(chartRows([{ ...mk('(unknown model)', { coding: 1 }), key: null }], 'model')[0]!.label).toBe('(unknown model)');
  });
  it('totalRow sums and normalises', () => {
    const t = totalRow(rows);
    expect(t.totalMs).toBe(4 * 3_600_000);
    expect(t.share.coding).toBeCloseTo(0.75);
    expect(totalRow([]).share.coding).toBe(0);
  });
});
