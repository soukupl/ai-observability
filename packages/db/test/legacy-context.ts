import { sql } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import type { Tx } from '../src/rls.js';

/**
 * The company-era RLS contexts (migrations 0001–0017), for the migration tests that pin an old schema with
 * migrateTo(). src/rls.ts implements the current context (ADR-0028: no company).
 */
export async function legacyRlsContext<T>(
  db: Database,
  ctx: { companyId: string; userId: string; role: 'admin' | 'member' },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${ctx.companyId}, true),
      set_config('app.user_id', ${ctx.userId}, true), set_config('app.role', ${ctx.role}, true)`);
    return fn(tx);
  });
}

export async function legacyIngestContext<T>(db: Database, companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
    return fn(tx);
  });
}

/** The super-admin role of the company era (dropped by migration 0018). */
export const LEGACY_PLATFORM_ROLE = 'app_platform';
