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
  it('totalRow sums and normalises', () => {
    const t = totalRow(rows);
    expect(t.totalMs).toBe(4 * 3_600_000);
    expect(t.share.coding).toBeCloseTo(0.75);
    expect(totalRow([]).share.coding).toBe(0);
  });
});
