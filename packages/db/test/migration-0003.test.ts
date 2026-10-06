import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { DB_ROLES } from '../src/connections.js';
import { runMigrations } from '../src/migrate.js';
import { priceInEffect } from '../src/prices.js';
import { withRlsContext } from '../src/rls.js';

/**
 * Migration 0003: estimate_cost_usd falls back to a model's earliest price row for days before it
 * (review DP-03), and agg_turn_list pages deterministically when turns share started_at (DP-12).
 * Own database (ai_obs_m0003_test).
 */
const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test');
base.pathname = '/ai_obs_m0003_test';
const URL_ = base.toString();
const adminUrl = new URL(URL_);
adminUrl.pathname = '/postgres';

async function prepare(): Promise<string | null> {
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    await admin.unsafe('drop database if exists "ai_obs_m0003_test" with (force)');
    await admin.unsafe('create database "ai_obs_m0003_test"');
    return null;
  } catch (err) {
    return `Postgres not reachable (${(err as { code?: string }).code || (err as Error).message})`;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

describe('priceInEffect (pure)', () => {
  const rows = [
    { effectiveFrom: '2026-06-01', v: 'b' },
    { effectiveFrom: '2026-01-01', v: 'a' },
  ];
  it('picks the newest row on or before the day, in any input order', () => {
    expect(priceInEffect(rows, '2026-01-01')?.v).toBe('a');
    expect(priceInEffect(rows, '2026-05-31')?.v).toBe('a');
    expect(priceInEffect(rows, '2026-06-01')?.v).toBe('b');
    expect(priceInEffect(rows, '2026-10-06')?.v).toBe('b');
  });
  it('falls back to the earliest row before it, undefined only with no rows', () => {
    expect(priceInEffect(rows, '2025-12-31')?.v).toBe('a');
    expect(priceInEffect(rows, '2000-01-01')?.v).toBe('a');
    expect(priceInEffect([], '2026-01-01')).toBeUndefined();
  });
});

const skip = await prepare();

describe.skipIf(skip !== null)(skip ? `migration 0003 - SKIPPED: ${skip}` : 'migration 0003 (real Postgres)', () => {
  let db: Database;
  let web: Database;
  const closers: Array<() => Promise<void>> = [];
  const ids = {} as Record<'company' | 'user', string>;
  const turnIds: string[] = [];

  beforeAll(async () => {
    const quiet = console.log;
    console.log = () => {};
    try {
      await runMigrations(URL_);
    } finally {
      console.log = quiet;
    }
    let c;
    ({ db, close: c } = createDb({ url: URL_, max: 1 }));
    closers.push(c);
    ({ db: web, close: c } = createDb({ url: URL_, role: DB_ROLES.web, max: 1 }));
    closers.push(c);

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      const one = async (q: ReturnType<typeof sql>) => ([...(await tx.execute(q))][0] as { id: string }).id;
      // A second, later price for one model: the fallback must pick the EARLIEST row, not the newest.
      await tx.execute(sql`insert into model_prices (model, effective_from, input_per_mtok, output_per_mtok,
        cache_read_per_mtok, cache_write_per_mtok) values ('claude-opus-5-5', '2026-06-01', 8, 40, 0.4, 10)`);
      ids.company = await one(sql`insert into companies (name, slug) values ('Ties', 'ties') returning id`);
      const team = await one(sql`insert into teams (company_id, name) values (${ids.company}, 'T') returning id`);
      ids.user = await one(sql`insert into users (company_id, email, name, company_role)
        values (${ids.company}, 'a@ties.test', 'A', 'admin') returning id`);
      const session = await one(sql`insert into agent_sessions (company_id, team_id, user_id, external_id, harness, started_at)
        values (${ids.company}, ${team}, ${ids.user}, 'cc:s', 'claude-code', '2026-09-10T08:00:00Z') returning id`);
      // 30 turns at the SAME instant, so ordering by started_at alone leaves page contents undefined.
      for (let i = 0; i < 30; i++) {
        turnIds.push(await one(sql`insert into turns (company_id, team_id, user_id, attribution, session_id, external_id,
            harness, started_at, ended_at, outcome)
          values (${ids.company}, ${team}, ${ids.user}, 'verified', ${session}, ${`cc:t${i}`}, 'claude-code',
            '2026-09-10T09:00:00Z', '2026-09-10T09:01:00Z', 'success') returning id`));
      }
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe('drop database if exists "ai_obs_m0003_test" with (force)').catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
  });

  const cost = async (model: string, day: string | null) =>
    ([...(await db.execute(sql`select estimate_cost_usd(${model}, ${day}::date, 1000000, 0, 0, 0)::float8 as usd`))][0] as {
      usd: number | null;
    }).usd;

  it('estimate_cost_usd prices a day before the earliest row with that earliest row', async () => {
    // Defaults start 2026-01-01 (opus 5.5 input $4/MTok); 2026-06-01 adds $8.
    expect(await cost('claude-opus-5-5', '2025-12-31')).toBe(4);
    expect(await cost('claude-opus-5-5', '2024-10-01')).toBe(4);
    expect(await cost('claude-opus-5-5', '2026-01-01')).toBe(4);
    expect(await cost('claude-opus-5-5', '2026-05-31')).toBe(4);
    expect(await cost('claude-opus-5-5', '2026-06-01')).toBe(8);
    expect(await cost('claude-opus-5-5', '2026-10-06')).toBe(8);
  });

  it('estimate_cost_usd stays NULL for an unknown model or a NULL day', async () => {
    expect(await cost('no-such-model', '2026-09-10')).toBeNull();
    expect(await cost('claude-opus-5-5', null)).toBeNull();
  });

  it('agg_turn_list pages through tied started_at without duplicates or gaps', async () => {
    const page = (offset: number) =>
      withRlsContext(web, { companyId: ids.company, userId: ids.user, role: 'admin' }, async (tx) =>
        [...(await tx.execute(sql`select id from agg_turn_list('2026-09-01'::timestamptz, '2026-10-01'::timestamptz,
          null, null, null, null, null, 7, ${offset})`))].map((r) => (r as { id: string }).id));
    const seen: string[] = [];
    for (let offset = 0; offset < 35; offset += 7) seen.push(...(await page(offset)));
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect(seen).toEqual([...turnIds].sort());
  });

  it('agg_turn_list keeps its owner and app_web EXECUTE grant', async () => {
    const [r] = [...(await db.execute(sql`select pg_get_userbyid(p.proowner) as owner,
        has_function_privilege('app_web', p.oid, 'EXECUTE') as web, has_function_privilege('app_ingest', p.oid, 'EXECUTE') as ingest
      from pg_proc p where p.proname = 'agg_turn_list'`))] as Array<{ owner: string; web: boolean; ingest: boolean }>;
    expect(r).toEqual({ owner: 'app_definer', web: true, ingest: false });
  });
});
