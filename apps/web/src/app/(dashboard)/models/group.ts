import type { CostValue } from '@/lib/cost';
import type { ModelRow } from '@/lib/queries/models';
import { modelKey, sumParts, wastedShare, type WastedPart } from '../../../lib/queries/wasted';

export type Grouping = 'model' | 'effort';

export const parseGrouping = (v: string | string[] | undefined): Grouping => ((Array.isArray(v) ? v[0] : v) === 'model' ? 'model' : 'effort');

const UNKNOWN_LABEL = '(unknown)';

export const PRIMARY_TURNS_HINT =
  'Turns whose primary model (and effort) is this row. Tokens and cost also include sub-agent runs; — means the model only ran inside sub-agents.';

export type TableRow = {
  key: string;
  model: string;
  effort: string;
  /** Turns whose primary model is this row; null (shown as —) for a row that has tokens but no such turn (sub-agent-only). */
  turns: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: CostValue;
  successRate: number | null;
  unknownShare: number | null;
  medianDurationMs: number | null;
  /** ≈ cost of failed / abandoned turns (null when unknown) and its share of the row's ≈ cost */
  wasted?: CostValue | null;
  wastedShare?: number | null;
};

/** 0 primary turns next to tokens reads as a contradiction; show "no value" instead (review V2). */
export function primaryTurns(turns: number, totalTokens: number): number | null {
  return turns === 0 && totalTokens > 0 ? null : turns;
}

/** Sum two costs; unknown (usd null) stays unknown only if nothing is priced. */
function addCost(a: CostValue | null, b: CostValue): CostValue {
  if (!a) return b;
  const usd = a.usd === null && b.usd === null ? null : (a.usd ?? 0) + (b.usd ?? 0);
  return { ...a, usd, partial: a.partial || b.partial || a.usd === null !== (b.usd === null), unknownModels: [...new Set([...a.unknownModels, ...b.unknownModels])] };
}

/**
 * Collapse model x effort rows to one row per model (group = 'model'). Success and unknown shares are
 * re-weighted by turns, which is exact when every row has the same known-outcome basis and a close
 * approximation otherwise. Median is only kept when a single row feeds the model (medians do not add).
 */
export function toTableRows(rows: ModelRow[], group: Grouping): TableRow[] {
  return collapse(rows, group).map((t) => ({ ...t, turns: primaryTurns(t.turns ?? 0, t.total) }));
}

function collapse(rows: ModelRow[], group: Grouping): TableRow[] {
  const base = (r: ModelRow): TableRow => ({
    key: `${r.model ?? ''}|${r.effort ?? ''}`,
    model: r.model ?? UNKNOWN_LABEL,
    effort: r.effort ?? UNKNOWN_LABEL,
    turns: r.turns,
    input: r.tokens.input,
    output: r.tokens.output,
    cacheRead: r.tokens.cacheRead,
    cacheWrite: r.tokens.cacheWrite,
    total: r.tokens.total,
    cost: r.cost,
    successRate: r.successRate,
    unknownShare: r.unknownShare,
    medianDurationMs: r.medianDurationMs,
  });
  if (group === 'effort') return rows.map(base);

  const acc = new Map<string, { t: TableRow; n: number; succ: number; succW: number; unk: number; med: number | null; cost: CostValue | null }>();
  for (const r of rows) {
    const b = base(r);
    const k = b.model;
    const g = acc.get(k);
    const knownW = r.unknownShare === null ? r.turns : r.turns * (1 - r.unknownShare);
    const succ = r.successRate === null ? 0 : r.successRate * knownW;
    if (!g) {
      acc.set(k, { t: { ...b, key: k, effort: 'all' }, n: 1, succ, succW: r.successRate === null ? 0 : knownW, unk: (r.unknownShare ?? 0) * r.turns, med: r.medianDurationMs, cost: r.cost });
      continue;
    }
    g.n++;
    g.t.turns = (g.t.turns ?? 0) + (b.turns ?? 0);
    g.t.input += b.input;
    g.t.output += b.output;
    g.t.cacheRead += b.cacheRead;
    g.t.cacheWrite += b.cacheWrite;
    g.t.total += b.total;
    g.succ += succ;
    g.succW += r.successRate === null ? 0 : knownW;
    g.unk += (r.unknownShare ?? 0) * r.turns;
    g.cost = addCost(g.cost, r.cost);
  }
  return [...acc.values()]
    .map((g) => ({
      ...g.t,
      cost: g.cost as CostValue,
      successRate: g.succW > 0 ? g.succ / g.succW : null,
      unknownShare: (g.t.turns ?? 0) > 0 ? g.unk / (g.t.turns ?? 1) : null,
      medianDurationMs: g.n === 1 ? g.med : null,
    }))
    .sort((a, b) => (b.cost.usd ?? -1) - (a.cost.usd ?? -1) || b.total - a.total);
}

/** Chart data: one bar per table row, label "model" or "model / effort"; zero/unknown values dropped. */
export function chartData(rows: TableRow[], group: Grouping, pick: (r: TableRow) => number | null, limit = 12) {
  return rows
    .map((r) => ({ label: group === 'model' ? r.model : `${r.model} / ${r.effort}`, value: pick(r) }))
    .filter((d): d is { label: string; value: number } => d.value !== null && d.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/** Adds wasted ≈ cost per row: by model × effort, or summed over a model's efforts (group = 'model'). */
export function withWasted(rows: TableRow[], byModel: ReadonlyMap<string, WastedPart>, group: Grouping): TableRow[] {
  return rows.map((r) => {
    const part =
      group === 'effort'
        ? byModel.get(r.key)
        : sumParts([...byModel].filter(([k]) => k.slice(0, k.lastIndexOf('|')) === (r.model === UNKNOWN_LABEL ? '' : r.model)).map(([, v]) => v));
    return { ...r, wasted: part?.wasted ?? null, wastedShare: wastedShare(part) };
  });
}
