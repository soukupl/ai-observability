import { sql } from 'drizzle-orm';
import type { QueryCtx } from './scope';
import { num, rows } from './sqlutil';

/** One event type of the ingest ledger (`ingest_events`), deployment-wide (docs/briefs/dashboard-followups-2026-10-10.md). */
export interface IngestStatRow {
  type: string;
  events24h: number;
  events7d: number;
  /** null when the ledger holds no event of this type (it keeps 30 days). */
  lastReceivedMs: number | null;
}

let warned = false;

/**
 * Events received from collectors per type: counts of the last 24 h / 7 days and the last arrival, through
 * `agg_ingest_stats()` (SECURITY DEFINER, migration 0015; the ledger is not readable by app_web directly). Not filtered:
 * ingest is a deployment-wide fact. Returns null when the function is missing (a deployment that has not run migration
 * 0015 yet) so the page still renders; the failed statement is rolled back to a savepoint so the page's transaction
 * stays usable.
 */
export async function getIngestStats(ctx: QueryCtx): Promise<IngestStatRow[] | null> {
  await ctx.tx.execute(sql`savepoint ingest_stats`);
  try {
    const out = await rows<Record<string, unknown>>(ctx.tx, sql`select type, events_24h, events_7d, last_received_at from agg_ingest_stats()`);
    await ctx.tx.execute(sql`release savepoint ingest_stats`);
    return out.map((r) => ({
      type: String(r.type),
      events24h: num(r.events_24h),
      events7d: num(r.events_7d),
      lastReceivedMs: r.last_received_at ? new Date(r.last_received_at as string).getTime() : null,
    }));
  } catch (err) {
    await ctx.tx.execute(sql`rollback to savepoint ingest_stats`);
    if (!warned) {
      warned = true;
      console.warn('[overview] ingest stats unavailable (migration 0015 not applied?)', err instanceof Error ? err.message : err);
    }
    return null;
  }
}
