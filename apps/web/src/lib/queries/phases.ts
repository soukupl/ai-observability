import { sql } from 'drizzle-orm';
import type { Filters } from '../filters';
import { aggArgs, dims, turnConds } from './providers';
import { listProjects, listTeams } from './lookups';
import { rawRange, rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { num, rows, where } from './sqlutil';

/** BRIEF §5.4. `delegating` is not stored (excluded from totals); unknown keys are folded into `other`. */
export const PHASES = ['thinking', 'exploring', 'coding', 'documenting', 'testing', 'validating', 'other'] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseGroup = 'team' | 'project' | 'model';
export const PHASE_GROUPS: readonly PhaseGroup[] = ['team', 'project', 'model'];

export interface PhaseRow {
  /** team id / project id / model name; null = none. */
  key: string | null;
  label: string;
  ms: Record<Phase, number>;
  totalMs: number;
  /** Share of totalMs per phase (0..1): the 100 % stacked bar. */
  share: Record<Phase, number>;
}

export interface PhasesResult {
  range: ResolvedRange;
  group: PhaseGroup;
  rows: PhaseRow[];
  ignoredFilters: string[];
}

const zero = (): Record<Phase, number> => Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;

/**
 * Time split per team / project / model. Always reads raw turns (rollups keep phase time too, but
 * agg_rollups does not expose it), so ranges beyond the raw retention are empty.
 */
export async function getPhases(ctx: QueryCtx, f: Filters, group: PhaseGroup = 'team'): Promise<PhasesResult> {
  const range = rawRange(rangeFor(ctx, f));
  const d = dims(ctx, f, range);
  let out: { key: string | null; phase: string; ms: unknown }[];
  const ignored = ctx.agg && d.effort ? ['effort'] : [];
  if (ctx.agg) {
    out = await rows(ctx.tx, sql`select group_key as key, phase, ms from agg_phases(${group}, ${aggArgs(d, 'ts')})`);
  } else {
    const keyExpr = group === 'team' ? sql`t.team_id::text` : group === 'project' ? sql`t.project_id::text` : sql`t.model`;
    out = await rows(
      ctx.tx,
      sql`select ${keyExpr} as key, p.key as phase, sum(p.value::bigint)::bigint as ms
          from turns t cross join lateral jsonb_each_text(t.phases_ms) p ${where(turnConds(ctx, d))} group by 1, 2`,
    );
  }
  const labels = new Map<string, string>();
  if (group === 'team') for (const t of await listTeams(ctx)) labels.set(t.id, t.name);
  if (group === 'project') for (const p of await listProjects(ctx)) labels.set(p.id, p.name);

  const byKey = new Map<string | null, Record<Phase, number>>();
  for (const r of out) {
    const key = r.key ?? null;
    const ms = byKey.get(key) ?? byKey.set(key, zero()).get(key)!;
    const phase = (PHASES as readonly string[]).includes(r.phase) ? (r.phase as Phase) : 'other';
    ms[phase] += num(r.ms);
  }
  const result: PhaseRow[] = [...byKey.entries()].map(([key, ms]) => {
    const totalMs = PHASES.reduce((s, p) => s + ms[p], 0);
    const share = zero();
    for (const p of PHASES) share[p] = totalMs > 0 ? ms[p] / totalMs : 0;
    const label = key === null ? (group === 'model' ? '(unknown model)' : `(no ${group})`) : (labels.get(key) ?? key);
    return { key, label, ms, totalMs, share };
  });
  result.sort((a, b) => b.totalMs - a.totalMs || a.label.localeCompare(b.label));
  return { range, group, rows: result, ignoredFilters: ignored };
}
