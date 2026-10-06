import { createDb, type Database } from './client.js';

/** Services and the DB role each one runs as (ADR-0006). */
export const DB_ROLES = {
  web: 'app_web',
  ingest: 'app_ingest',
  worker: 'app_worker',
  platform: 'app_platform',
} as const;
export type DbRoleKind = keyof typeof DB_ROLES;

/** DATABASE_URL_WEB / _INGEST / _WORKER / _PLATFORM, falling back to DATABASE_URL (dev). */
export function urlFor(kind: DbRoleKind, env: NodeJS.ProcessEnv = process.env): string {
  const url = env[`DATABASE_URL_${kind.toUpperCase()}`] || env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL_${kind.toUpperCase()} (or DATABASE_URL) is not set`);
  return url;
}

const pools = new Map<DbRoleKind, { db: Database; close: () => Promise<void> }>();

/**
 * Lazily created, process-wide pool for one service role. Every connection runs as the matching
 * app_* role (startup `SET ROLE`), so RLS and grants apply even with the shared dev owner URL.
 * Never call at import time (e.g. `next build` must not need a database).
 */
export function dbFor(kind: DbRoleKind, options: { max?: number } = {}): Database {
  let entry = pools.get(kind);
  if (!entry) {
    entry = createDb({ url: urlFor(kind), role: DB_ROLES[kind], max: options.max });
    pools.set(kind, entry);
  }
  return entry.db;
}

/** Closes every pool opened by dbFor() (graceful shutdown, tests). */
export async function closeAllDbs(): Promise<void> {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.all(entries.map((e) => e.close()));
}
