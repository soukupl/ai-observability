import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { migrationsFolder } from '../src/migrate.js';

/**
 * Migration 0002 data fix: placeholder turns (session_id null) written by the old ingest become
 * pending_turn_patches; their runs are unlinked and the rollup slices they inflated are re-queued
 * (remaining turns marked updated) or deleted. Own database (ai_obs_m0002_test): migrates to 0001,
 * writes old-style rows, then applies 0002.
 */
const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test');
base.pathname = '/ai_obs_m0002_test';
const URL_ = base.toString();
const adminUrl = new URL(URL_);
adminUrl.pathname = '/postgres';

async function prepare(): Promise<string | null> {
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    await admin.unsafe('drop database if exists "ai_obs_m0002_test" with (force)');
    await admin.unsafe('create database "ai_obs_m0002_test"');
    return null;
  } catch (err) {
    return `Postgres not reachable (${(err as { code?: string }).code || (err as Error).message})`;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

const skip = await prepare();

describe.skipIf(skip !== null)(skip ? `migration 0002 - SKIPPED: ${skip}` : 'migration 0002 data fix (real Postgres)', () => {
  let db: Database;
  let close: () => Promise<void>;
  let partial: string;
  const ids = {} as Record<'company' | 'real' | 'ph1' | 'ph2' | 'run', string>;

  beforeAll(async () => {
    ({ db, close } = createDb({ url: URL_, max: 1 }));
    // Migrations 0000 + 0001 only.
    partial = mkdtempSync(join(tmpdir(), 'ai-obs-m0002-'));
    cpSync(migrationsFolder, partial, { recursive: true });
    const journalPath = join(partial, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => e.tag < '0002');
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: partial });

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      const one = async (q: ReturnType<typeof sql>) => ([...(await tx.execute(q))][0] as { id: string }).id;
      ids.company = await one(sql`insert into companies (name, slug) values ('Old', 'old') returning id`);
      const team = await one(sql`insert into teams (company_id, name) values (${ids.company}, 'T') returning id`);
      const user = await one(sql`insert into users (company_id, email, name) values (${ids.company}, 'u@old.test', 'U') returning id`);
      const session = await one(sql`insert into agent_sessions (company_id, team_id, user_id, external_id, harness, started_at)
        values (${ids.company}, ${team}, ${user}, 'cc:s', 'claude-code', '2026-09-10T08:00:00Z') returning id`);
      const turn = (ext: string, sessionId: string | null, at: string, outcome: string, summary: string | null) =>
        one(sql`insert into turns (company_id, team_id, user_id, attribution, session_id, external_id, harness, started_at,
            ended_at, outcome, outcome_provisional, summary, updated_at)
          values (${ids.company}, ${team}, ${user}, 'verified', ${sessionId}, ${ext}, 'claude-code', ${at}, ${at},
            ${outcome}, false, ${summary}, '2026-01-01T00:00:00Z') returning id`);
      ids.real = await turn('cc:real', session, '2026-09-10T09:00:00Z', 'success', null);
      // Placeholder from an outcome + summary patch (marker present), on the real turn's day.
      ids.ph1 = await turn('cc:ph1', null, '2026-09-10T10:00:00Z', 'failed', 'Patched early');
      await tx.execute(sql`insert into ingest_events (company_id, event_id, type) values (${ids.company}, 'outcome-patch:cc:ph1', 'marker')`);
      // Placeholder from a summary patch only, alone on its day; a run got linked to it.
      ids.ph2 = await turn('cc:ph2', null, '2026-09-11T10:00:00Z', 'unknown', 'Summary only');
      ids.run = await one(sql`insert into runs (company_id, team_id, user_id, turn_id, turn_external_id, external_id, agent_type,
          started_at, ended_at) values (${ids.company}, ${team}, ${user}, ${ids.ph2}, 'cc:ph2', 'r1', 'Explore',
          '2026-09-11T10:00:00Z', '2026-09-11T10:01:00Z') returning id`);
      for (const [day, turns] of [['2026-09-10', 2], ['2026-09-11', 1]] as const) {
        await tx.execute(sql`insert into daily_rollups (company_id, day, team_id, user_id, harness, model, turns)
          values (${ids.company}, ${day}, ${team}, ${user}, 'claude-code', 'unknown', ${turns})`);
      }
    });
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await close?.();
    if (partial) rmSync(partial, { recursive: true, force: true });
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe('drop database if exists "ai_obs_m0002_test" with (force)').catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
  });

  const q = async <T>(query: ReturnType<typeof sql>) => [...(await db.execute(query))] as T[];

  it('removes placeholder turns and parks their patches', async () => {
    expect(await q(sql`select external_id from turns order by 1`)).toEqual([{ external_id: 'cc:real' }]);
    const parked = await q(sql`select turn_external_id, outcome, outcome_provisional, summary from pending_turn_patches order by 1`);
    expect(parked).toEqual([
      { turn_external_id: 'cc:ph1', outcome: 'failed', outcome_provisional: false, summary: 'Patched early' },
      { turn_external_id: 'cc:ph2', outcome: null, outcome_provisional: null, summary: 'Summary only' },
    ]);
  });

  it('keeps runs of a placeholder, unlinked, for ingest to re-link', async () => {
    expect(await q(sql`select turn_id, turn_external_id from runs where id = ${ids.run}`)).toEqual([{ turn_id: null, turn_external_id: 'cc:ph2' }]);
  });

  it('re-queues rollup slices that still have turns and deletes slices that only had placeholders', async () => {
    expect(await q(sql`select updated_at > '2026-01-02'::timestamptz as bumped from turns where id = ${ids.real}`)).toEqual([{ bumped: true }]);
    expect(await q(sql`select day::text as day from daily_rollups order by 1`)).toEqual([{ day: '2026-09-10' }]);
  });

  it('adds the watermark indexes', async () => {
    const idx = await q<{ indexname: string }>(sql`select indexname from pg_indexes
      where indexname in ('turns_updated_idx', 'runs_created_idx') order by 1`);
    expect(idx.map((r) => r.indexname)).toEqual(['runs_created_idx', 'turns_updated_idx']);
  });
});
