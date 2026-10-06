import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema> & { $client: Sql };

export interface CreateDbOptions {
  /** Defaults to process.env.DATABASE_URL. */
  url?: string;
  /** Max pool size (default 10). */
  max?: number;
  /**
   * DB role every pooled connection switches to at startup (Postgres `role` startup parameter, i.e.
   * `SET ROLE`). The login user must be a member of it. Used by dbFor() so RLS applies even when a
   * single owner URL is configured (dev).
   */
  role?: string;
}

/** Creates a Drizzle client over the porsager `postgres` driver. Prefer dbFor() in services. */
export function createDb(options: CreateDbOptions = {}): { db: Database; close: () => Promise<void> } {
  const url = options.url ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    ...(options.role ? { connection: { role: options.role } } : {}),
  });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}
