import { sql } from 'drizzle-orm';
import { createDb, DB_ROLES, type Database, type Tx } from '@ai-obs/db';
// Test-only: reuse the real migrate entry point so the test DB has the exact production schema + RLS.
import { runMigrations } from '../../../../packages/db/src/migrate';

/**
 * Own Postgres database for the ingest integration tests (ai_obs_ingest_test), dropped and
 * re-created per run and dropped again afterwards. Never touches the dev database.
 */
export const INGEST_TEST_URL =
  process.env.INGEST_TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_ingest_test';

function admin() {
  const u = new URL(INGEST_TEST_URL);
  const name = decodeURIComponent(u.pathname.slice(1));
  u.pathname = '/postgres';
  return { name, url: u.toString() };
}

const closers: Array<() => Promise<void>> = [];

async function withAdmin<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const { db, close } = createDb({ url: admin().url, max: 1 });
  try {
    return await fn(db);
  } finally {
    await close().catch(() => {});
  }
}

/** Returns null when ready, else the reason to skip. */
export async function prepareIngestTestDb(): Promise<string | null> {
  const { name, url } = admin();
  if (!/_test$/.test(name)) return `refusing to reset database "${name}" (name must end in _test)`;
  try {
    await withAdmin(async (db) => {
      await db.$client`select 1`;
      await db.$client.unsafe(`drop database if exists "${name}" with (force)`);
      await db.$client.unsafe(`create database "${name}"`);
    });
  } catch (err) {
    return `Postgres not reachable at ${url.replace(/:[^:@/]*@/, ':***@')} (${(err as { code?: string }).code || (err as Error).message})`;
  }
  const quiet = console.log;
  console.log = () => {};
  try {
    await runMigrations(INGEST_TEST_URL);
  } finally {
    console.log = quiet;
  }
  return null;
}

export async function dropIngestTestDb(): Promise<void> {
  await Promise.all(closers.splice(0).map((c) => c()));
  const { name } = admin();
  await withAdmin((db) => db.$client.unsafe(`drop database if exists "${name}" with (force)`)).catch(() => {});
}

/** Pool running as app_ingest — what the route uses via dbFor('ingest'). */
export function connectIngest(): Database {
  const { db, close } = createDb({ url: INGEST_TEST_URL, role: DB_ROLES.ingest, max: 2 });
  closers.push(close);
  return db;
}

/** Owner pool; every transaction runs as app_definer so FORCE RLS is honoured for fixtures and checks. */
export function connectOwner(): { run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> } {
  const { db, close } = createDb({ url: INGEST_TEST_URL, max: 1 });
  closers.push(close);
  return {
    run: (fn) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        return fn(tx);
      }),
  };
}

/** Pool running as another service role (app_web for dashboard reads, app_worker for rollups). */
export function connectRole(role: 'web' | 'worker'): Database {
  const { db, close } = createDb({ url: INGEST_TEST_URL, role: DB_ROLES[role], max: 2 });
  closers.push(close);
  return db;
}
