import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import type { MemberRole } from './schema/enums.js';

/**
 * Request-scoped identity that RLS policies read via current_setting('app.*') (ADR-0006, ADR-0028). There is no
 * company any more: one deployment = one company, so the context is the user and the role the dashboard believes
 * they have.
 */
export interface RlsContext {
  userId: string;
  /**
   * The member's deployment role (memberships.role). The DB re-checks it: 'admin' only counts while the membership
   * says admin. Team-lead rights are derived in the DB from team_memberships, not passed in.
   */
  role: MemberRole;
}

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: readonly MemberRole[] = ['admin', 'member'];

export function assertUuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new TypeError(`${name} must be a UUID`);
}

export function assertRlsContext(ctx: RlsContext): void {
  assertUuid(ctx?.userId, 'userId');
  if (!ROLES.includes(ctx.role)) throw new TypeError(`role must be one of ${ROLES.join(', ')}`);
}

/**
 * Runs `fn` in a transaction with the dashboard RLS context set transaction-locally. Use with dbFor('web').
 * set_config(name, value, is_local => true) is `SET LOCAL` with bind parameters, so values cannot inject SQL and
 * vanish at COMMIT/ROLLBACK (safe with pooled connections). The DB re-checks the claims: a user without a membership
 * sees nothing (app_user() is null); role 'admin' only counts if the membership has role admin.
 */
export async function withRlsContext<T>(db: Database, ctx: RlsContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertRlsContext(ctx);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.user_id', ${ctx.userId}, true),
      set_config('app.role', ${ctx.role}, true)`);
    return fn(tx);
  });
}

/**
 * Ingest context (use with dbFor('ingest')): binds every insert / patch to the token's user resolved by
 * lookup_ingest_token() (the ingest write guard: the policies check user_id = app_user()). app_ingest still cannot
 * read telemetry back beyond identity columns.
 */
export async function withIngestContext<T>(db: Database, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertUuid(userId, 'userId');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
