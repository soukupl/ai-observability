import { describe, expect, it } from 'vitest';
import { defaultFilters, filtersQuery, parseFilters, serializeFilters, type Filters } from '../../src/lib/filters';
import { addDays, eachDay, RAW_MAX_DAYS, resolveRange } from '../../src/lib/queries/range';

const U1 = '3f0f7b5e-8a53-4c59-9a0e-0d1d3b1c2a11';
const U2 = '9d1c2a44-1b6f-4c21-8d2e-5a7b9c0d1e22';

describe('filters', () => {
  it('defaults to 30d and an empty query', () => {
    const f = parseFilters(new URLSearchParams());
    expect(f).toEqual(defaultFilters());
    expect(f.range).toBe('30d');
    expect(serializeFilters(f).toString()).toBe('');
    expect(filtersQuery(f)).toBe('');
  });

  it('round-trips every field', () => {
    const f: Filters = {
      range: 'custom', from: '2026-08-01', to: '2026-09-15', teamId: U1, projectId: U2, userId: U1,
      harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high',
    };
    const back = parseFilters(serializeFilters(f), { allowUser: true });
    expect(back).toEqual(f);
  });

  it.each(['7d', '90d', '12m'] as const)('round-trips preset %s', (range) => {
    const f = { ...defaultFilters(), range };
    expect(parseFilters(serializeFilters(f))).toEqual(f);
    expect(serializeFilters(f).get('range')).toBe(range);
  });

  it('accepts a plain object (Next searchParams) and takes the first of repeated values', () => {
    const f = parseFilters({ range: ['7d', '90d'], model: 'gpt-5.4', teamId: undefined });
    expect(f.range).toBe('7d');
    expect(f.model).toBe('gpt-5.4');
    expect(f.teamId).toBeNull();
  });

  it('only honours userId when allowed', () => {
    const p = new URLSearchParams({ userId: U1 });
    expect(parseFilters(p).userId).toBeNull();
    expect(parseFilters(p, { allowUser: false }).userId).toBeNull();
    expect(parseFilters(p, { allowUser: true }).userId).toBe(U1);
  });

  it('rejects malformed input instead of passing it on', () => {
    const f = parseFilters(new URLSearchParams({
      range: 'forever', teamId: "x'; drop table turns;--", projectId: 'not-a-uuid', model: 'a'.repeat(300), harness: '<script>',
    }));
    expect(f).toEqual(defaultFilters());
  });

  it('falls back to the default range for an invalid or reversed custom range', () => {
    for (const q of [
      'range=custom', 'range=custom&from=2026-09-10&to=2026-09-01', 'range=custom&from=2026-02-30&to=2026-03-01',
      'range=custom&from=2020-01-01&to=2026-10-01',
    ]) {
      const f = parseFilters(new URLSearchParams(q));
      expect(f.range, q).toBe('30d');
      expect(f.from).toBeNull();
    }
  });

  it('keeps extra params when building links', () => {
    expect(filtersQuery({ ...defaultFilters(), range: '7d' }, { page: 2, outcome: null })).toBe('?range=7d&page=2');
  });
});

describe('range and source selection', () => {
  const now = new Date('2026-10-05T18:00:00Z');

  it('presets end today inclusive', () => {
    const r = resolveRange({ range: '7d', from: null, to: null }, now);
    expect(r.fromDay).toBe('2026-09-29');
    expect(r.toDay).toBe('2026-10-06');
    expect(r.days).toBe(7);
    expect(r.fromIso).toBe('2026-09-29T00:00:00Z');
  });

  it('reads raw up to 35 days and rollups beyond', () => {
    expect(resolveRange({ range: '30d', from: null, to: null }, now).source).toBe('raw');
    expect(resolveRange({ range: '90d', from: null, to: null }, now).source).toBe('rollup');
    expect(resolveRange({ range: '12m', from: null, to: null }, now).source).toBe('rollup');
    const edge = (days: number) => resolveRange({ range: 'custom', from: addDays('2026-10-05', -(days - 1)), to: '2026-10-05' }, now);
    expect(edge(RAW_MAX_DAYS).source).toBe('raw');
    expect(edge(RAW_MAX_DAYS + 1).source).toBe('rollup');
  });

  it('custom `to` is inclusive; the upper bound is exclusive', () => {
    const r = resolveRange({ range: 'custom', from: '2026-09-01', to: '2026-09-03' }, now);
    expect(r.days).toBe(3);
    expect(r.toDay).toBe('2026-09-04');
    expect(eachDay(r.fromDay, r.toDay)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });

  it('can be forced to a source', () => {
    expect(resolveRange({ range: '7d', from: null, to: null }, now, 'rollup').source).toBe('rollup');
  });
});
