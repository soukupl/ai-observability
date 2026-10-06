import postgres from 'postgres';
import { createDb, type Database } from '../src/client.js';
import { DB_ROLES, type DbRoleKind } from '../src/connections.js';
import { runMigrations } from '../src/migrate.js';

/**
 * Real-Postgres test harness. Uses TEST_DATABASE_URL, else the docker-compose postgres
 * (`docker compose up -d postgres`) with a dedicated `ai_obs_test` database that is dropped and
 * re-created per run. Refuses to touch a database whose name does not end in `_test`.
 */
export const TEST_URL =
  process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test';

function adminUrl(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = '/postgres';
  return { name, url: u.toString() };
}

/** Returns null when ready, or the reason the DB tests must be skipped. */
export async function prepareTestDatabase(): Promise<string | null> {
  const { name, url } = adminUrl(TEST_URL);
  if (!/_test$/.test(name)) return `refusing to reset database "${name}" (name must end in _test)`;
  const admin = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
  } catch (err) {
    return `Postgres not reachable at ${url.replace(/:[^:@/]*@/, ':***@')} (${(err as { code?: string }).code || (err as Error).message}). ` +
      'Start it with `docker compose up -d postgres` or set TEST_DATABASE_URL.';
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
  await runMigrations(TEST_URL);
  return null;
}

const opened: Array<() => Promise<void>> = [];

/** A pool whose connections run as the service role (same mechanism as dbFor()). */
export function connectAs(kind: DbRoleKind): Database {
  const { db, close } = createDb({ url: TEST_URL, role: DB_ROLES[kind], max: 2 });
  opened.push(close);
  return db;
}

/** Owner pool (fixtures); writes go through `set local role app_definer` so FORCE RLS is honoured. */
export function connectOwner(): Database {
  const { db, close } = createDb({ url: TEST_URL, max: 1 });
  opened.push(close);
  return db;
}

export async function closeAll() {
  await Promise.all(opened.splice(0).map((c) => c()));
}

/** Postgres error code of a rejected promise (e.g. 42501 insufficient_privilege). */
export async function pgErrorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code;
  }
}
