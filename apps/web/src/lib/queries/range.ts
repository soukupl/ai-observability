import type { Filters } from '../filters';

/**
 * Source selection. A range of at most RAW_MAX_DAYS reads raw rows (`turns` / `usage` / `runs`, or the
 * agg_* functions over them); a longer range reads `daily_rollups` (or agg_rollups). Raw is exact to
 * the second and carries medians; rollups are cheap over a year and outlive raw retention (ADR-0012).
 * Both are built from the same turns with the same attribution (turn counts on the primary model,
 * tokens on the usage row's model; packages/db README), so turn counts, outcomes, tokens and ≈ cost agree
 * exactly, mixed-model turns included.
 *
 * Raw rows expire (deployment retention, 30 days minimum; the nightly job deletes whole UTC days before
 * today - retentionDays after folding them into rollups). A range that starts before that cut-off
 * would silently undercount from raw rows, so it reads rollups too, however short it is.
 */
export const RAW_MAX_DAYS = 35;
export type SourceKind = 'raw' | 'rollup';

export interface ResolvedRange {
  /** First day included, YYYY-MM-DD (UTC). */
  fromDay: string;
  /** First day NOT included (exclusive upper bound), YYYY-MM-DD (UTC). */
  toDay: string;
  fromIso: string;
  toIso: string;
  days: number;
  source: SourceKind;
  /**
   * Raw rows still cover the whole range (it starts inside the deployment's retention window). Medians
   * need raw durations, so a long range on rollups can still show one while this holds.
   */
  rawCovers: boolean;
}

const DAY_MS = 86_400_000;
export const dayString = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export function addDays(day: string, n: number): string {
  return dayString(dayMs(day) + n * DAY_MS);
}

/** UTC calendar days from `fromDay` up to (excluding) `toDay`. */
export function eachDay(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let ms = dayMs(fromDay); ms < dayMs(toDay); ms += DAY_MS) out.push(dayString(ms));
  return out;
}

const PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 } as const;

/** Presets end with today (UTC) inclusive. */
export function resolveRange(
  f: Pick<Filters, 'range' | 'from' | 'to'>,
  now: Date = new Date(),
  force?: SourceKind,
  /** Effective raw retention of the deployment in days; undefined = unknown, assume raw rows are all there. */
  retentionDays?: number,
): ResolvedRange {
  let fromDay: string;
  let toDay: string;
  if (f.range === 'custom' && f.from && f.to) {
    fromDay = f.from;
    toDay = addDays(f.to, 1);
  } else {
    const today = dayString(now.getTime());
    toDay = addDays(today, 1);
    fromDay = addDays(toDay, -PRESET_DAYS[f.range === 'custom' ? '30d' : f.range]);
  }
  const days = Math.round((dayMs(toDay) - dayMs(fromDay)) / DAY_MS);
  // First UTC day whose raw rows may still exist (the worker keeps day >= today - retentionDays).
  const rawFrom = retentionDays === undefined ? null : addDays(dayString(now.getTime()), -Math.max(0, Math.floor(retentionDays)));
  const rawComplete = days <= RAW_MAX_DAYS && (rawFrom === null || fromDay >= rawFrom);
  return {
    fromDay,
    toDay,
    fromIso: `${fromDay}T00:00:00Z`,
    toIso: `${toDay}T00:00:00Z`,
    days,
    source: force ?? (rawComplete ? 'raw' : 'rollup'),
    rawCovers: rawFrom === null || fromDay >= rawFrom,
  };
}

/** Can a median turn duration be computed for this range (from raw rows, even when the figures come from rollups)? */
export function medianAvailableFor(ctx: { forceSource?: SourceKind }, range: ResolvedRange): boolean {
  return range.source === 'raw' || (!ctx.forceSource && range.rawCovers);
}

/** Same range, forced to raw rows (phases, agents and the turns explorer have no rollup form). */
export function rawRange(r: ResolvedRange): ResolvedRange {
  return { ...r, source: 'raw' };
}

/** The range of a request: `ctx.forceSource` (tests, tooling) overrides the automatic source choice. */
export function rangeFor(ctx: { now: Date; forceSource?: SourceKind; retentionDays?: number }, f: Pick<Filters, 'range' | 'from' | 'to'>): ResolvedRange {
  return resolveRange(f, ctx.now, ctx.forceSource, ctx.retentionDays);
}
