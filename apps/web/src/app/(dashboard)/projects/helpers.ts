import type { Column, Row } from '../../../components/DataTable';
import type { ModelRow } from '../../../lib/queries/models';
import type { PhaseRow } from '../../../lib/queries/phases';
import { PHASES } from '../../../lib/queries/phases';
import type { ProjectRow } from '../../../lib/queries/projects';
import type { ProjectRef } from '../../../lib/queries/lookups';
import { projectLabel } from '../../../lib/queries/lookups';
import type { StackedRow } from '../../../components/charts/StackedBar100';
import { serializeFilters, type Filters } from '../../../lib/filters';

/** A hashed key without an admin-given name: the page tells admins where to name it. */
export function isUnnamedHash(p: Pick<ProjectRef, 'key' | 'name'>): boolean {
  return p.key.startsWith('sha256:') && p.name === projectLabel(p.key, null);
}

/** Link to /projects/[id] keeping the current filters except the project one. */
export function projectHref(id: string, f: Filters): string {
  const p = serializeFilters({ ...f, projectId: null });
  const q = p.toString();
  return `/projects/${id}${q ? `?${q}` : ''}`;
}

/** Link to the turns explorer for one project, carrying the other filters. */
export function turnsHref(id: string, f: Filters): string {
  const p = serializeFilters({ ...f, projectId: id });
  return `/turns?${p.toString()}`;
}

export const PROJECT_COLUMNS: Column[] = [
  { key: 'name', header: 'Project', kind: 'text', hrefKey: 'href' },
  { key: 'team', header: 'Team', kind: 'text' },
  { key: 'turns', header: 'Turns', kind: 'int' },
  { key: 'tokens', header: 'Tokens', kind: 'tokens' },
  { key: 'cost', header: '≈ Cost', kind: 'cost', hint: '≈ at API list prices; n/a when no price is known' },
  { key: 'successRate', header: 'Success', kind: 'percent', hint: 'success / turns with a known outcome' },
  { key: 'unknownShare', header: 'Unknown', kind: 'percent', hint: 'Share of turns whose outcome is unknown' },
  { key: 'spark', header: 'Tokens, 14 days', kind: 'sparkline' },
];

export function projectTableRows(rows: ProjectRow[], f: Filters): Row[] {
  return rows.map((r) => ({
    id: r.projectId ?? 'none',
    name: r.name,
    href: r.projectId ? projectHref(r.projectId, f) : undefined,
    team: r.teamName,
    turns: r.turns,
    tokens: r.tokens.total,
    cost: r.costSkipped ? { usd: null, partial: false } : r.cost,
    successRate: r.successRate,
    unknownShare: r.unknownShare,
    spark: r.spark,
  }));
}

export const MODEL_COLUMNS: Column[] = [
  { key: 'model', header: 'Model', kind: 'text' },
  { key: 'effort', header: 'Effort', kind: 'text' },
  { key: 'turns', header: 'Turns', kind: 'int' },
  { key: 'tokens', header: 'Tokens', kind: 'tokens' },
  { key: 'cost', header: '≈ Cost', kind: 'cost' },
  { key: 'successRate', header: 'Success', kind: 'percent' },
  { key: 'unknownShare', header: 'Unknown', kind: 'percent' },
  { key: 'median', header: 'Median turn', kind: 'duration' },
];

export function modelTableRows(rows: ModelRow[]): Row[] {
  return rows.map((r) => ({
    model: r.model ?? 'unknown model',
    effort: r.effort,
    turns: r.turns,
    tokens: r.tokens.total,
    cost: r.cost,
    successRate: r.successRate,
    unknownShare: r.unknownShare,
    median: r.medianDurationMs,
  }));
}

export function phaseStackRows(rows: PhaseRow[]): { rows: StackedRow[]; keys: string[] } {
  const keys = PHASES.filter((p) => rows.some((r) => r.ms[p] > 0));
  return { keys: [...keys], rows: rows.filter((r) => r.totalMs > 0).map((r) => ({ label: r.label, values: Object.fromEntries(keys.map((k) => [k, r.ms[k]])) })) };
}
