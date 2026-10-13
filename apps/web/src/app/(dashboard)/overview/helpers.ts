import type { Outcome } from '@ai-obs/db';
import type { CostValue } from '@/lib/cost';
import type { BudgetProgress } from '@/lib/queries/budgets';
import type { Flow } from '@/lib/queries/flows';
import type { IngestStatRow } from '@/lib/queries/ingest-stats';
import { FLOW_KIND_LABEL, flowHref, projectLabel } from '../flows/_helpers';

export const OUTCOME_ORDER = ['success', 'failed', 'abandoned', 'unknown'] as const;
export type OutcomeKey = (typeof OUTCOME_ORDER)[number];

export interface OutcomeSlice {
  key: OutcomeKey;
  count: number;
  share: number;
}

/** Shares of all turns per outcome (unknown included, never hidden). Empty when there are no turns. */
export function outcomeSlices(outcomes: Record<OutcomeKey, number>): OutcomeSlice[] {
  const total = OUTCOME_ORDER.reduce((s, k) => s + (outcomes[k] ?? 0), 0);
  if (total <= 0) return [];
  return OUTCOME_ORDER.map((key) => ({ key, count: outcomes[key] ?? 0, share: (outcomes[key] ?? 0) / total }));
}

/** Bar width in percent, clamped to 0..100 (usage over the limit fills the bar). */
export function barWidth(fraction: number | null): number {
  if (fraction === null || !Number.isFinite(fraction)) return 0;
  return Math.min(100, Math.max(0, fraction * 100));
}

/** Own budget first, then teams, then names. */
export function sortBudgets(rows: BudgetProgress[]): BudgetProgress[] {
  const rank = (b: BudgetProgress) => (b.scope === 'user' && b.isMine ? 0 : b.scope === 'team' ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.teamName ?? a.userName ?? '').localeCompare(b.teamName ?? b.userName ?? ''));
}

export function budgetLabel(b: BudgetProgress): string {
  if (b.scope === 'user') return b.isMine ? 'My budget' : (b.userName ?? 'User budget');
  return b.teamName ?? 'Team budget';
}

/**
 * Rows for the stacked area chart: one per day, with EVERY series key present (0 when the model was idle
 * that day). Recharts breaks a stack on a missing key, which drew gaps and spikes (review V1).
 */
export function zeroFilledChartRows(
  points: { day: string; byModel: Record<string, number> }[],
  models: string[],
): ({ x: string } & Record<string, number | string>)[] {
  return points.map((p) => {
    const row: { x: string } & Record<string, number | string> = { x: p.day };
    for (const m of models) row[m] = p.byModel[m] ?? 0;
    return row;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Long or complex agent flows (docs/briefs/dashboard-followups-2026-10-10.md): flows of the range that pass any of the
// thresholds below, longest first. Constants, not settings, until the owner wants them configurable.
// ---------------------------------------------------------------------------------------------------------------------

export const COMPLEX_MIN_STEPS = 5;
export const COMPLEX_MIN_DURATION_MS = 20 * 60_000;
export const COMPLEX_MIN_TOKENS = 1_000_000;
export const COMPLEX_MAX_ROWS = 8;

export type ComplexReason = 'steps' | 'duration' | 'tokens';

export const COMPLEX_REASON_TEXT: Record<ComplexReason, string> = {
  steps: `${COMPLEX_MIN_STEPS}+ steps`,
  duration: `over ${Math.round(COMPLEX_MIN_DURATION_MS / 60_000)} min`,
  tokens: 'over 1M tokens',
};

export interface ComplexFlowRow {
  id: string;
  href: string;
  name: string;
  kind: string;
  projectName: string;
  startedMs: number;
  steps: number;
  stages: number;
  durationMs: number;
  tokens: number;
  cost: CostValue;
  outcome: Outcome;
  reasons: ComplexReason[];
}

/** Why a flow counts as long or complex (in a fixed order); empty when it does not. */
export function complexReasons(f: Pick<Flow, 'steps' | 'durationMs' | 'tokens'>): ComplexReason[] {
  const r: ComplexReason[] = [];
  if (f.steps.length >= COMPLEX_MIN_STEPS) r.push('steps');
  if (f.durationMs >= COMPLEX_MIN_DURATION_MS) r.push('duration');
  if (f.tokens.total >= COMPLEX_MIN_TOKENS) r.push('tokens');
  return r;
}

/** Rows of the Overview card: flows passing any threshold, by duration desc then tokens desc, at most COMPLEX_MAX_ROWS. */
export function complexFlows(flows: Flow[]): ComplexFlowRow[] {
  return flows
    .map((f) => ({ f, reasons: complexReasons(f) }))
    .filter((x) => x.reasons.length > 0)
    .sort((a, b) => b.f.durationMs - a.f.durationMs || b.f.tokens.total - a.f.tokens.total || a.f.id.localeCompare(b.f.id))
    .slice(0, COMPLEX_MAX_ROWS)
    .map(({ f, reasons }) => ({
      id: f.id,
      href: flowHref(f),
      name: f.name,
      kind: FLOW_KIND_LABEL[f.kind] ?? f.kind,
      projectName: projectLabel(f.turn),
      startedMs: f.startedMs,
      steps: f.steps.length,
      stages: f.stages.length,
      durationMs: f.durationMs,
      tokens: f.tokens.total,
      cost: f.cost,
      outcome: f.outcome,
      reasons,
    }));
}

/** `/flows` with the page's current search params kept (filters), page / outcome dropped. */
export function allFlowsHref(sp: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === 'page' || k === 'outcome' || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) p.append(k, one);
  }
  const s = p.toString();
  return s ? `/flows?${s}` : '/flows';
}

// ---------------------------------------------------------------------------------------------------------------------
// Ingest card: events received from collectors (company-wide, `agg_ingest_stats()`).
// ---------------------------------------------------------------------------------------------------------------------

/** Event type → card label; anything else is "other". */
const INGEST_TYPE_LABEL: Record<string, string> = {
  turn: 'turns',
  run: 'runs',
  turn_outcome: 'patches',
  turn_summary: 'patches',
  session_title: 'patches',
  session_start: 'sessions',
  session_end: 'sessions',
};

export interface IngestSummary {
  /** When the last event arrived; null when the ledger is empty. */
  lastMs: number | null;
  /** "3 min ago", "2 h ago", "4 d ago", "just now" or "never". */
  ago: string;
  total24h: number;
  total7d: number;
  /** Grouped by label, biggest first (zero groups left out). */
  byType24h: { label: string; count: number }[];
}

/** Relative time in whole units: "just now" under a minute, then min / h / d. `never` when null. */
export function relativeAgo(ms: number | null, nowMs: number): string {
  if (ms === null) return 'never';
  const diff = Math.max(0, nowMs - ms);
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function ingestSummary(rows: IngestStatRow[], nowMs: number): IngestSummary {
  let lastMs: number | null = null;
  let total24h = 0;
  let total7d = 0;
  const groups = new Map<string, number>();
  for (const r of rows) {
    if (r.lastReceivedMs !== null && (lastMs === null || r.lastReceivedMs > lastMs)) lastMs = r.lastReceivedMs;
    total24h += r.events24h;
    total7d += r.events7d;
    const label = INGEST_TYPE_LABEL[r.type] ?? 'other';
    groups.set(label, (groups.get(label) ?? 0) + r.events24h);
  }
  const byType24h = [...groups.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }));
  return { lastMs, ago: relativeAgo(lastMs, nowMs), total24h, total7d, byType24h };
}
