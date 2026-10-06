import type { TurnDetail, TurnListRow } from '@/lib/queries/turns';
import type { RunTreeNode } from '@/components/RunTree';
import type { RunNode } from '@/lib/queries/runs-tree';

export const OUTCOME_VALUES = ['success', 'failed', 'abandoned', 'unknown'] as const;
export type OutcomeFilter = (typeof OUTCOME_VALUES)[number];

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Page number (>= 1) and outcome filter from the URL; invalid values fall back to defaults. */
export function parseTurnParams(sp: Params): { page: number; outcome: OutcomeFilter | null } {
  const p = Number.parseInt(first(sp.page) ?? '', 10);
  const o = first(sp.outcome);
  return {
    page: Number.isFinite(p) && p >= 1 && p <= 100_000 ? p : 1,
    outcome: (OUTCOME_VALUES as readonly string[]).includes(o ?? '') ? (o as OutcomeFilter) : null,
  };
}

/** startedMs query param of the detail page; undefined when missing or not a number. */
export function parseStartedMs(v: string | string[] | undefined): number | undefined {
  const n = Number(first(v));
  return first(v) && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** URL for a list page: keeps the current search params, sets/clears page and outcome. */
export function listHref(sp: Params, change: { page?: number | null; outcome?: string | null }): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = first(v);
    if (val !== undefined && k !== 'page' && !(k === 'outcome' && 'outcome' in change)) p.set(k, val);
  }
  if (change.outcome) p.set('outcome', change.outcome);
  if (change.page && change.page > 1) p.set('page', String(change.page));
  const s = p.toString();
  return s ? `/turns?${s}` : '/turns';
}

/** Serializable table rows for DataTable (no user fields unless the row carries them). */
export function toTableRows(rows: TurnListRow[]) {
  return rows.map((r) => ({
    id: r.id,
    href: `/turns/${r.id}?startedMs=${r.startedMs}`,
    startedMs: r.startedMs,
    user: r.userName ?? (r.userId ? 'unknown user' : null),
    project: r.projectName,
    harness: r.harness,
    model: r.model,
    effort: r.effort,
    durationMs: r.durationMs,
    tokens: r.tokens.total,
    cost: r.cost,
    outcome: r.outcome,
    attribution: r.attribution,
    summary: r.summary,
  }));
}

/** Main agent (root) with the run tree below it, for RunTree. */
export function toRunTree(d: Pick<TurnDetail, 'turn' | 'tree'>): RunTreeNode {
  const conv = (n: RunNode): RunTreeNode => ({
    id: n.id,
    label: n.agentType,
    model: n.model,
    effort: n.effort,
    durationMs: n.durationMs,
    tokens: n.tokens.total,
    outcome: n.outcome,
    children: n.children.map(conv),
  });
  return {
    id: 'main',
    label: 'main agent',
    model: d.turn.model,
    effort: d.turn.effort,
    durationMs: d.turn.durationMs,
    tokens: d.turn.tokens.total,
    outcome: d.turn.outcome,
    children: d.tree.map(conv),
  };
}

/** Phase durations as one StackedBar100 row; null when there is nothing to draw. */
export function phaseRow(phases: Record<string, number> | null): { keys: string[]; values: Record<string, number> } | null {
  if (!phases) return null;
  const entries = Object.entries(phases).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return { keys: entries.map(([k]) => k), values: Object.fromEntries(entries) };
}
