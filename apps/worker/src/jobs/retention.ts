import { sql } from 'drizzle-orm';
import type { WorkerContext } from '../context.js';
import { DAY_MS, utcDay } from '../lib/dates.js';
import { effectiveRetentionDays, retentionCutoff } from '../lib/retention-policy.js';
import type { Job } from '../scheduler.js';
import { recomputeDay } from './rollups.js';

const BATCH = 2000;
const INGEST_EVENT_DAYS = 30;
/** Parked turn patches whose turn never arrived are dropped after this many days (ADR-0015). */
const PENDING_PATCH_DAYS = 30;
const LAST_DAY_KEY = 'retention.lastDay';

export interface RetentionSummary {
  skipped?: boolean;
  companies: number;
  turns: number;
  runs: number;
  usage: number;
  sessions: number;
  ingestEvents: number;
  pendingPatches: number;
  magicLinks: number;
  authSessions: number;
}

const rows = <T>(r: unknown): T[] => r as T[];
const n = (v: unknown): number => Number(v ?? 0);

async function deleteExpiredForCompany(ctx: WorkerContext, companyId: string, cutoff: Date, signal?: AbortSignal) {
  const cut = cutoff.toISOString();
  const total = { turns: 0, runs: 0, usage: 0, sessions: 0 };

  // 1. Make sure expiring days are in the permanent rollups first. recomputeDay never shrinks a rollup: a day
  //    whose raw rows are complete is rebuilt, and a day whose raw rows were already partly deleted (an earlier
  //    pass, or turns that arrived after the day expired) only gets the turns it has not rolled up yet.
  const days = rows<{ day: string }>(
    await ctx.db.execute(sql`
      select distinct (started_at at time zone 'UTC')::date::text as day from turns
      where company_id = ${companyId} and started_at < ${cut}::timestamptz order by 1`),
  );
  for (const { day } of days) {
    if (signal?.aborted) return total;
    await recomputeDay(ctx.db, companyId, day);
  }

  // 2. Expired turns with their runs and usage, in bounded batches.
  for (;;) {
    if (signal?.aborted) return total;
    const [r] = rows<{ usage: string; runs: string; turns: string }>(
      await ctx.db.execute(sql`
        with ids as (select id from turns where company_id = ${companyId} and started_at < ${cut}::timestamptz order by started_at limit ${BATCH}),
        du as (delete from usage where company_id = ${companyId} and turn_id in (select id from ids) returning 1),
        dr as (delete from runs where company_id = ${companyId} and turn_id in (select id from ids) returning 1),
        dt as (delete from turns where company_id = ${companyId} and id in (select id from ids) returning 1)
        select (select count(*) from du) as usage, (select count(*) from dr) as runs, (select count(*) from dt) as turns`),
    );
    total.usage += n(r?.usage);
    total.runs += n(r?.runs);
    total.turns += n(r?.turns);
    if (n(r?.turns) < BATCH) break;
  }

  // 3. Orphans that never got linked to a turn (run arrived first and its turn never did).
  for (;;) {
    if (signal?.aborted) return total;
    const [r] = rows<{ usage: string; runs: string }>(
      await ctx.db.execute(sql`
        with ids as (select id from runs where company_id = ${companyId} and turn_id is null and started_at < ${cut}::timestamptz limit ${BATCH}),
        du as (delete from usage where company_id = ${companyId} and run_id in (select id from ids) returning 1),
        dr as (delete from runs where company_id = ${companyId} and id in (select id from ids) returning 1)
        select (select count(*) from du) as usage, (select count(*) from dr) as runs`),
    );
    total.usage += n(r?.usage);
    total.runs += n(r?.runs);
    if (n(r?.runs) < BATCH) break;
  }
  const [orphanUsage] = rows<{ n: string }>(
    await ctx.db.execute(sql`
      with d as (delete from usage where company_id = ${companyId} and turn_id is null and run_id is null and started_at < ${cut}::timestamptz returning 1)
      select count(*) as n from d`),
  );
  total.usage += n(orphanUsage?.n);

  // 4. Sessions that started before the cutoff and have no turn left (a session still holding newer turns stays).
  for (;;) {
    if (signal?.aborted) return total;
    const [r] = rows<{ n: string }>(
      await ctx.db.execute(sql`
        with ids as (select s.id from agent_sessions s where s.company_id = ${companyId} and s.started_at < ${cut}::timestamptz
                       and not exists (select 1 from turns t where t.session_id = s.id) limit ${BATCH}),
        d as (delete from agent_sessions where company_id = ${companyId} and id in (select id from ids) returning 1)
        select count(*) as n from d`),
    );
    total.sessions += n(r?.n);
    if (n(r?.n) < BATCH) break;
  }
  return total;
}

async function pruneGlobal(ctx: WorkerContext, signal?: AbortSignal) {
  const now = ctx.now().toISOString();
  const eventCut = new Date(ctx.now().getTime() - INGEST_EVENT_DAYS * DAY_MS).toISOString();
  const batched = async (statement: (limit: number) => ReturnType<typeof sql>): Promise<number> => {
    let total = 0;
    for (;;) {
      if (signal?.aborted) return total;
      const [r] = rows<{ n: string }>(await ctx.db.execute(statement(BATCH)));
      total += n(r?.n);
      if (n(r?.n) < BATCH) return total;
    }
  };
  const ingestEvents = await batched(
    (limit) => sql`with d as (delete from ingest_events where id in (
        select id from ingest_events where received_at < ${eventCut}::timestamptz limit ${limit}) returning 1) select count(*) as n from d`,
  );
  const patchCut = new Date(ctx.now().getTime() - PENDING_PATCH_DAYS * DAY_MS).toISOString();
  // Parked turn patches (ADR-0015) and session titles (ADR-0026) whose turn / session never came.
  let pendingPatches = 0;
  for (const table of ['pending_turn_patches', 'pending_session_patches']) {
    pendingPatches += await batched(
      (limit) => sql`with d as (delete from ${sql.identifier(table)} where id in (
          select id from ${sql.identifier(table)} where received_at < ${patchCut}::timestamptz limit ${limit}) returning 1) select count(*) as n from d`,
    );
  }
  const magicLinks = await batched(
    (limit) => sql`with d as (delete from magic_links where id in (
        select id from magic_links where expires_at < ${now}::timestamptz limit ${limit}) returning 1) select count(*) as n from d`,
  );
  const authSessions = await batched(
    (limit) => sql`with d as (delete from auth_sessions where id in (
        select id from auth_sessions where expires_at < ${now}::timestamptz limit ${limit}) returning 1) select count(*) as n from d`,
  );
  return { ingestEvents, pendingPatches, magicLinks, authSessions };
}

/** Whether the nightly pass is due: once per UTC day, not before RETENTION_HOUR_UTC. */
export function retentionDue(now: Date, lastDay: string | undefined, hourUtc: number): boolean {
  return lastDay !== utcDay(now) && now.getUTCHours() >= hourUtc;
}

/** One retention pass. `force` skips the once-per-day guard (RUN_ONCE). Exported for tests. */
export async function runRetention(ctx: WorkerContext, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<RetentionSummary> {
  const now = ctx.now();
  const empty: RetentionSummary = { companies: 0, turns: 0, runs: 0, usage: 0, sessions: 0, ingestEvents: 0, pendingPatches: 0, magicLinks: 0, authSessions: 0 };
  if (!opts.force && !retentionDue(now, ctx.state.get(LAST_DAY_KEY), ctx.config.retentionHourUtc)) return { ...empty, skipped: true };

  const companies = rows<{ id: string; slug: string; plan: 'free' | 'team' | 'business'; settings: { retentionDays?: number } }>(
    await ctx.db.execute(sql`select id, slug, plan, settings from companies`),
  );
  const summary = { ...empty, companies: companies.length };
  let failed = 0;
  for (const c of companies) {
    if (opts.signal?.aborted) return summary;
    const days = effectiveRetentionDays(c.plan, c.settings);
    try {
      const r = await deleteExpiredForCompany(ctx, c.id, retentionCutoff(now, days), opts.signal);
      summary.turns += r.turns;
      summary.runs += r.runs;
      summary.usage += r.usage;
      summary.sessions += r.sessions;
      if (r.turns + r.runs + r.usage + r.sessions > 0) {
        ctx.log.info(`retention: company=${c.slug} retentionDays=${days} turns=${r.turns} runs=${r.runs} usage=${r.usage} sessions=${r.sessions}`);
      }
    } catch (err) {
      failed += 1;
      ctx.log.error(`retention: company ${c.slug} failed`, err);
    }
  }
  try {
    Object.assign(summary, await pruneGlobal(ctx, opts.signal));
  } catch (err) {
    failed += 1;
    ctx.log.error('retention: pruning ingest_events / pending patches / auth failed', err);
  }
  if (failed > 0) throw new Error(`retention: ${failed} step(s) failed`);
  if (!opts.signal?.aborted) ctx.state.set(LAST_DAY_KEY, utcDay(now));
  return summary;
}

export const createRetentionJob = (ctx: WorkerContext): Job => ({
  name: 'retention',
  intervalMs: 60 * 60_000,
  async run(signal, opts) {
    const s = await runRetention(ctx, { force: opts?.force, signal });
    if (s.skipped) return 'skipped=already-ran-today-or-not-yet-due';
    return `companies=${s.companies} turns=${s.turns} runs=${s.runs} usage=${s.usage} sessions=${s.sessions} ingest_events=${s.ingestEvents} pending_patches=${s.pendingPatches} magic_links=${s.magicLinks} auth_sessions=${s.authSessions}`;
  },
});
