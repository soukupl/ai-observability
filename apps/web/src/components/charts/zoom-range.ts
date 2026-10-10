/**
 * Time zoom of the stacked-area charts (brief docs/briefs/dashboard-followups-2026-10-10.md): the user drags across
 * two x values (days) and the chart shows only the points between them. Pure index arithmetic over the chart rows,
 * so it is unit-tested without React (test/views/charts-zoom.test.ts).
 */

/** Inclusive index range into the chart's rows. */
export interface ZoomRange {
  from: number;
  to: number;
}

/** The x value of a row, as the chart gives it back in `activeLabel`. */
type Row = { x: string };

/**
 * Range between two x labels, in either order. null when a label is unknown, both are the same point, or the data
 * has fewer than two points (nothing to zoom into).
 */
export function zoomRange(data: readonly Row[], aLabel: unknown, bLabel: unknown): ZoomRange | null {
  if (data.length < 2) return null;
  const a = indexOfLabel(data, aLabel);
  const b = indexOfLabel(data, bLabel);
  if (a === null || b === null || a === b) return null;
  return a < b ? { from: a, to: b } : { from: b, to: a };
}

/** The rows inside the range (inclusive); the whole data when the range is null or does not fit. */
export function applyZoom<T extends Row>(data: readonly T[], range: ZoomRange | null): T[] {
  if (!range || range.from < 0 || range.to >= data.length || range.from > range.to) return [...data];
  return data.slice(range.from, range.to + 1);
}

/** Row index of an x label (`activeLabel` may arrive as a number for numeric axes; the charts use strings). */
function indexOfLabel(data: readonly Row[], label: unknown): number | null {
  if (label === undefined || label === null) return null;
  const key = String(label);
  const i = data.findIndex((r) => r.x === key);
  return i >= 0 ? i : null;
}
