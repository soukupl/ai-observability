import { describe, expect, it } from 'vitest';
import { applyZoom, zoomRange } from '../../src/components/charts/zoom-range';

const rows = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((x, i) => ({ x, v: i }));

describe('zoomRange', () => {
  it('returns the inclusive index range between two labels', () => {
    expect(zoomRange(rows, '2026-10-02', '2026-10-04')).toEqual({ from: 1, to: 3 });
  });
  it('normalises a reversed drag', () => {
    expect(zoomRange(rows, '2026-10-04', '2026-10-02')).toEqual({ from: 1, to: 3 });
  });
  it('is null for the same label (a click, not a drag)', () => {
    expect(zoomRange(rows, '2026-10-03', '2026-10-03')).toBeNull();
  });
  it('is null for an unknown, undefined or null label', () => {
    expect(zoomRange(rows, '2026-10-02', '2026-11-01')).toBeNull();
    expect(zoomRange(rows, undefined, '2026-10-02')).toBeNull();
    expect(zoomRange(rows, '2026-10-02', null)).toBeNull();
  });
  it('is null with fewer than two points', () => {
    expect(zoomRange([rows[0]!], '2026-10-01', '2026-10-01')).toBeNull();
    expect(zoomRange([], 'a', 'b')).toBeNull();
  });
  it('accepts a numeric label by its string form', () => {
    const numeric = [{ x: '1' }, { x: '2' }, { x: '3' }];
    expect(zoomRange(numeric, 1, 3)).toEqual({ from: 0, to: 2 });
  });
  it('can select the two ends', () => {
    expect(zoomRange(rows, '2026-10-01', '2026-10-05')).toEqual({ from: 0, to: 4 });
  });
});

describe('applyZoom', () => {
  it('slices inclusively', () => {
    expect(applyZoom(rows, { from: 1, to: 3 }).map((r) => r.x)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04']);
  });
  it('returns a copy of everything without a range', () => {
    const out = applyZoom(rows, null);
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });
  it('ignores a range that no longer fits the data (data changed under the zoom)', () => {
    expect(applyZoom(rows.slice(0, 2), { from: 1, to: 3 })).toHaveLength(2);
    expect(applyZoom(rows, { from: -1, to: 2 })).toHaveLength(5);
    expect(applyZoom(rows, { from: 3, to: 1 })).toHaveLength(5);
  });
});
