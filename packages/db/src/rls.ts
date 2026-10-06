import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import type { CompanyRole } from './schema/enums.js';

/** Request-scoped identity that RLS policies read via current_setting('app.*') (ADR-0006). */
export interface RlsContext {
  companyId: string;
  userId: string;
  /** Company role. Team-lead rights are derived in the DB from team_memberships, not passed in. */
  role: CompanyRole;
}

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: readonly CompanyRole[] = ['admin', 'member'];

export function assertUuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new TypeError(`${name} must be a UUID`);
}

export function assertRlsContext(ctx: RlsContext): void {
  assertUuid(ctx?.companyId, 'companyId');
  assertUuid(ctx.userId, 'userId');
  if (!ROLES.includes(ctx.role)) throw new TypeError(`role must be one of ${ROLES.join(', ')}`);
}

/**
 * Runs `fn` in a transaction with the dashboard RLS context set transaction-locally. Use with
 * dbFor('web'). set_config(name, value, is_local => true) is `SET LOCAL` with bind parameters, so
 * values cannot inject SQL and vanish at COMMIT/ROLLBACK (safe with pooled connections).
 * The DB re-checks the claims: a user outside companyId sees nothing; role 'admin' only counts if
 * users.company_role is admin.
 */
export async function withRlsContext<T>(db: Database, ctx: RlsContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertRlsContext(ctx);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.company_id', ${ctx.companyId}, true),
      set_config('app.user_id', ${ctx.userId}, true),
      set_config('app.role', ${ctx.role}, true)`);
    return fn(tx);
  });
}

/**
 * Ingest context (use with dbFor('ingest')): binds every insert/patch to the company resolved by
 * lookup_ingest_token(). There is no user context; app_ingest cannot read telemetry back.
 */
export async function withIngestContext<T>(db: Database, companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertUuid(companyId, 'companyId');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
    return fn(tx);
  });
}
