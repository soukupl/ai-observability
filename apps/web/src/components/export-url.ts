import { serializeFilters, type Filters } from '@/lib/filters';

/** Link to GET /api/export for a table view, carrying the current filters (the export re-runs them). */
export function exportUrl(view: string, filters: Filters, extra: Record<string, string | null | undefined> = {}): string {
  const p = serializeFilters(filters);
  p.set('view', view);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return `/api/export?${p.toString()}`;
}
