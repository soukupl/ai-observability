import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, migrationsFolder } from '../src/migrate.js';
import * as schema from '../src/schema/index.js';
import { adminDbUrl, testDbName, testDbUrl } from './test-db.js';

/**
 * The hand-written migrations and the Drizzle schema agree (ADR-0028 migration 0018 was written by hand):
 *  1. the latest snapshot in migrations/meta equals src/schema, so `drizzle-kit generate` has nothing to do;
 *  2. a database migrated from scratch has exactly the tables, columns, constraints, indexes and enums that the
 *     schema's own DDL creates in an empty database (policies, functions and grants are migration-only).
 */
const DBS = { migrated: testDbName('drift'), ddl: testDbName('driftddl') } as const;
const adminUrl = adminDbUrl();

async function prepare(): Promise<string | null> {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    for (const name of Object.values(DBS)) {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.unsafe(`create database "${name}"`);
    }
    return null;
  } catch (err) {
    return `Postgres not reachable (${(err as { code?: string }).code || (err as Error).message})`;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

const CATALOG = `
select 'col|' || c.table_name || '|' || c.column_name || '|' || c.udt_name || '|' || c.is_nullable || '|' || coalesce(c.column_default, '') as x
  from information_schema.columns c where c.table_schema = 'public'
union all
select 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) from pg_constraint
  where connamespace = 'public'::regnamespace and contype <> 't'
union all
select 'idx|' || tablename || '|' || indexname || '|' || indexdef from pg_indexes where schemaname = 'public'
union all
select 'enum|' || t.typname || '|' || string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_type t
  join pg_enum e on e.enumtypid = t.oid group by t.typname
order by 1`;

const skip = await prepare();

describe.skipIf(skip !== null)(skip ? `schema drift - SKIPPED: ${skip}` : 'migrations vs Drizzle schema', () => {
  const current = generateDrizzleJson(schema as unknown as Record<string, unknown>);

  beforeAll(async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await runMigrations(testDbUrl('drift'));
    } finally {
      console.log = log;
    }
  }, 60_000);

  afterAll(async () => {
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    for (const name of Object.values(DBS)) await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
  });

  it('the latest snapshot equals src/schema (drizzle-kit generate is a no-op)', async () => {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const last = journal.entries.at(-1)!;
    const snapshot = JSON.parse(readFileSync(join(migrationsFolder, 'meta', `${String(last.idx).padStart(4, '0')}_snapshot.json`), 'utf8'));
    expect(await generateMigration(snapshot, current)).toEqual([]);
  });

  it('a migrated database has exactly the structure the schema DDL creates', async () => {
    const ddl = await generateMigration(generateDrizzleJson({}), current);
    const fresh = postgres(testDbUrl('driftddl'), { max: 1, onnotice: () => {} });
    const migrated = postgres(testDbUrl('drift'), { max: 1, onnotice: () => {} });
    try {
      for (const stmt of ddl) await fresh.unsafe(stmt);
      const want = (await fresh.unsafe(CATALOG)).map((r) => r.x as string);
      const got = (await migrated.unsafe(CATALOG)).map((r) => r.x as string);
      expect(want.length).toBeGreaterThan(400);
      expect(got.filter((x) => !want.includes(x))).toEqual([]);
      expect(want.filter((x) => !got.includes(x))).toEqual([]);
    } finally {
      await fresh.end({ timeout: 1 });
      await migrated.end({ timeout: 1 });
    }
  });
});
