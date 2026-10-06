import { dailyRollups, runs, turns, usage, type Database } from '@ai-obs/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { WorkerContext } from '../context.js';
import { addDays, dayStart, utcDay } from '../lib/dates.js';
import { effectiveRetentionDays, retentionCutoffDay } from '../lib/retention-policy.js';
import { aggregateDay, planDays, type RollupRow, type TurnRow, type UsageRow } from '../rollups/aggregate.js';
import { rollupRowId, sliceMode } from '../rollups/slice.js';
import type { Job } from '../scheduler.js';

/** Rows changed this long before the previous run still count as "since the watermark" (commit skew). */
const WATERMARK_OVERLAP_MS = 10 * 60_000;
const WATERMARK_KEY = 'rollups.watermark';
const INSERT_CHUNK = 500;

const num = (v: unknown): number => Number(v ?? 0);

/** daily_rollups rows whose user was deleted after they were written (see src/rollups/slice.ts). */
const ANONYMISED = sql`(user_id is null and substr(id::text, 15, 2) = '8a')`;

/**
 * Rewrites one (company, day) slice from raw rows in one transaction (daily_rollups has no unique key, see
 * packages/db/README.md). Returns null, touching nothing, when the day has no raw turns (their rows were
 * expired or never existed; the permanent rollup stays as it is) or nothing new to add.
 *
 * History is never lost (ADR-0012, src/rollups/slice.ts): rows anonymised by a user deletion are kept, and
 * when raw rows of the day were already deleted (raw turns < rolled-up turns) only turns that arrived after
 * the last rewrite are added on top instead of rebuilding the slice from partial raw rows.
 */
export async function recomputeDay(db: Database, companyId: string, day: string): Promise<{ turns: number; rows: number } | null> {
  const from = dayStart(day);
  const to = dayStart(addDays(day, 1));
  return db.transaction(async (tx) => {
    // Serialise workers recomputing the same slice.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rollups:${companyId}:${day}`}))`);
    const inDay = and(eq(turns.companyId, companyId), gte(turns.startedAt, from), lt(turns.startedAt, to));
    const inSlice = sql`company_id = ${companyId} and day = ${day}::date`;

    const [slice] = (await tx.execute(sql`
      select coalesce(sum(turns) filter (where not ${ANONYMISED}), 0)::int as rolled
      from daily_rollups where ${inSlice}`)) as unknown as Array<{ rolled: number }>;
    // A turn created no later than the newest rollup row of the slice was there when the slice was last written.
    const lastWrite = sql`(select max(updated_at) from daily_rollups where ${inSlice})`;

    const turnRows = await tx
      .select({
        id: turns.id, teamId: turns.teamId, userId: turns.userId, projectId: turns.projectId, harness: turns.harness,
        model: turns.model, effort: turns.effort, durationMs: turns.durationMs, phasesMs: turns.phasesMs, outcome: turns.outcome,
        known: sql<boolean>`coalesce(${turns.createdAt} <= ${lastWrite}, false)`,
      })
      .from(turns)
      .where(inDay);
    if (turnRows.length === 0) return null;

    const mode = sliceMode({ knownRawTurns: turnRows.filter((t) => t.known).length, rolledTurns: num(slice?.rolled) });
    const picked = mode === 'rebuild' ? turnRows : turnRows.filter((t) => !t.known);
    if (picked.length === 0) return null;

    const usageRows: UsageRow[] = await tx
      .select({
        turnId: usage.turnId, model: usage.model, effort: usage.effort,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens, reasoningTokens: usage.reasoningTokens, requests: usage.requests,
      })
      .from(usage)
      .innerJoin(turns, and(eq(usage.turnId, turns.id), eq(usage.companyId, turns.companyId)))
      .where(inDay)
      .then((rows) => rows.map((r) => ({ ...r, turnId: r.turnId! })));

    const runCounts = new Map<string, number>();
    const runAgg = await tx
      .select({ turnId: runs.turnId, n: sql<number>`count(*)` })
      .from(runs)
      .innerJoin(turns, and(eq(runs.turnId, turns.id), eq(runs.companyId, turns.companyId)))
      .where(inDay)
      .groupBy(runs.turnId);
    for (const r of runAgg) if (r.turnId) runCounts.set(r.turnId, num(r.n));

    // aggregateDay ignores usage rows of turns that were not picked.
    const rows = aggregateDay(picked as TurnRow[], usageRows, runCounts);
    if (mode === 'rebuild') await tx.delete(dailyRollups).where(sql`${inSlice} and not ${ANONYMISED}`);
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(dailyRollups).values(rows.slice(i, i + INSERT_CHUNK).map((r) => toInsert(companyId, day, r)));
    }
    return { turns: picked.length, rows: rows.length };
  });
}

const toInsert = (companyId: string, day: string, r: RollupRow): typeof dailyRollups.$inferInsert => ({
  id: rollupRowId(r.userId !== null), companyId, day, ...r,
});

export interface RollupsSummary {
  days: number;
  rows: number;
  full: boolean;
}

/** One rollups pass. Exported for tests and RUN_ONCE. */
export async function runRollups(ctx: WorkerContext, signal?: AbortSignal): Promise<RollupsSummary> {
  const { db, state, now } = ctx;
  const startedAt = now();
  const today = utcDay(startedAt);
  const watermark = state.get(WATERMARK_KEY);
  const full = !watermark;
  const since = watermark ? new Date(Date.parse(watermark) - WATERMARK_OVERLAP_MS) : null;

  const companies = (await db.execute(sql`select id, plan, settings from companies`)) as unknown as Array<{
    id: string;
    plan: 'free' | 'team' | 'business';
    settings: { retentionDays?: number };
  }>;
  const cutoffs = companies.map((c) => ({
    id: c.id,
    cutoffDay: retentionCutoffDay(startedAt, effectiveRetentionDays(c.plan, c.settings)),
  }));

  // Slices touched since the last pass; on a cold start (no watermark) every slice that has raw turns.
  // turns.updated_at is set on insert and bumped by every ingest write to a turn (so it is never older
  // than created_at); both branches are index scans (turns_updated_idx, runs_created_idx, migration 0002).
  const dayExpr = sql`(t.started_at at time zone 'UTC')::date::text`;
  const changedRows = (await (full
    ? db.execute(sql`select distinct t.company_id as "companyId", ${dayExpr} as day from turns t`)
    : db.execute(sql`
        select t.company_id as "companyId", ${dayExpr} as day from turns t
        where t.updated_at >= ${since!.toISOString()}::timestamptz
        union
        select r.company_id, ${dayExpr} from runs r join turns t on t.id = r.turn_id and t.company_id = r.company_id
        where r.created_at >= ${since!.toISOString()}::timestamptz`))) as unknown as Array<{ companyId: string; day: string }>;

  const plan = planDays({ today, companies: cutoffs, changed: changedRows }, addDays);
  let rows = 0;
  let days = 0;
  let failed = 0;
  for (const slice of plan) {
    if (signal?.aborted) break;
    try {
      const r = await recomputeDay(db, slice.companyId, slice.day);
      if (r) {
        days += 1;
        rows += r.rows;
      }
    } catch (err) {
      failed += 1;
      ctx.log.error(`rollups: company ${slice.companyId} day ${slice.day} failed`, err);
    }
  }
  // Advance the watermark only when every slice succeeded and the pass was not interrupted.
  if (failed === 0 && !signal?.aborted) state.set(WATERMARK_KEY, startedAt.toISOString());
  if (failed > 0) throw new Error(`rollups: ${failed} slice(s) failed`);
  return { days, rows, full };
}

export const createRollupsJob = (ctx: WorkerContext): Job => ({
  name: 'rollups',
  intervalMs: 5 * 60_000,
  async run(signal) {
    const s = await runRollups(ctx, signal);
    return `days=${s.days} rows=${s.rows}${s.full ? ' full=true' : ''}`;
  },
});
