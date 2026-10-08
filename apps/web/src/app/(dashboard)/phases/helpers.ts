import { formatModel, modelLabels } from '../../../lib/model-name';
import { PHASE_GROUPS, PHASES, type Phase, type PhaseGroup, type PhaseRow } from '../../../lib/queries/phases';

export const GROUP_LABEL: Record<PhaseGroup, string> = { team: 'Team', project: 'Project', model: 'Model' };

/** `?group=` -> a valid group (default team). Arrays and junk fall back to the default. */
export function parseGroup(v: string | string[] | undefined): PhaseGroup {
  const s = Array.isArray(v) ? v[0] : v;
  return (PHASE_GROUPS as readonly string[]).includes(s ?? '') ? (s as PhaseGroup) : 'team';
}

export const msToHours = (ms: number): number => ms / 3_600_000;

/** "0.4 h", "12 h", "1.2k h"; zero stays "0 h". */
export function formatHours(ms: number): string {
  const h = msToHours(ms);
  if (h === 0) return '0 h';
  if (h < 10) return `${h.toFixed(h < 0.1 ? 2 : 1)} h`;
  if (h < 1000) return `${Math.round(h)} h`;
  return `${(h / 1000).toFixed(1)}k h`;
}

export function formatShare(share: number): string {
  if (share === 0) return '0%';
  const p = share * 100;
  return p < 1 ? '<1%' : `${Math.round(p)}%`;
}

/** Display label of a phase row: friendly model name when grouped by model (the key stays the raw id). */
export function rowLabel(r: { key?: string | null; label: string }, group?: PhaseGroup): string {
  return group === 'model' && typeof r.key === 'string' ? formatModel(r.key) : r.label;
}

/**
 * Rows with any time, as the chart wants them (absolute ms; the chart normalises to 100 %), in the rows' order.
 * Grouped by model the labels are friendly names, unique per row (modelLabels: the raw id where names collide).
 */
export function chartRows(rows: PhaseRow[], group?: PhaseGroup): { label: string; values: Record<Phase, number> }[] {
  const shown = rows.filter((r) => r.totalMs > 0);
  const labels = group === 'model' ? modelLabels(shown.map((r) => r.key).filter((k): k is string => typeof k === 'string')) : {};
  return shown.map((r) => ({ label: typeof r.key === 'string' ? (labels[r.key] ?? r.label) : r.label, values: r.ms }));
}

/** Time split over all rows combined (the "Total" line of the table). */
export function totalRow(rows: PhaseRow[]): { ms: Record<Phase, number>; totalMs: number; share: Record<Phase, number> } {
  const ms = Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
  for (const r of rows) for (const p of PHASES) ms[p] += r.ms[p];
  const totalMs = PHASES.reduce((s, p) => s + ms[p], 0);
  const share = Object.fromEntries(PHASES.map((p) => [p, totalMs > 0 ? ms[p] / totalMs : 0])) as Record<Phase, number>;
  return { ms, totalMs, share };
}
