import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Database } from './client.js';
import { DB_ROLES } from './connections.js';
import { ensureDefaultModelPrices } from './prices.js';

/** Resolves the same from src/ (tsx) and dist/ (Docker image). */
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** DB_APP_WEB_PASSWORD, DB_APP_INGEST_PASSWORD, ... → makes that role a LOGIN role with this password. */
export const passwordEnvName = (role: string) => `DB_${role.toUpperCase()}_PASSWORD`;

/**
 * Turns the NOLOGIN app_* roles into LOGIN roles when a password is configured (production: each
 * service then connects as its own role via DATABASE_URL_<SERVICE>). Re-run on every deploy so
 * passwords can be rotated. Roles without a password stay NOLOGIN and are reached via SET ROLE.
 */
export async function applyRolePasswords(db: Database, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const applied: string[] = [];
  for (const role of Object.values(DB_ROLES)) {
    const password = env[passwordEnvName(role)];
    if (!password) continue;
    // DDL takes no bind parameters: pass the secret through a transaction-local setting and quote it
    // server-side with format(%L), so it never appears in the statement text or the logs.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('ai_obs.role_password', ${password}, true)`);
      await tx.execute(
        sql.raw(`do $$ begin execute format('alter role ${role} login password %L',
          current_setting('ai_obs.role_password')); end $$`),
      );
    });
    applied.push(role);
  }
  return applied;
}

/**
 * One-shot migrate entry point (docker `migrate` service, `pnpm db:migrate`). Idempotent: Drizzle
 * records applied migrations in drizzle.__drizzle_migrations; 0001_roles_rls.sql creates roles,
 * grants, RLS policies and functions; default model prices are inserted
 * only when missing. Must connect as the schema owner (MIGRATE_DATABASE_URL,
 * falling back to DATABASE_URL) — a superuser in dev, or a role with CREATEROLE in production.
 */
export async function runMigrations(url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL) {
  const { db, close } = createDb({ url, max: 1 });
  try {
    await migrate(db, { migrationsFolder });
    const prices = await ensureDefaultModelPrices(db);
    if (prices) console.log(`inserted ${prices} default model prices`);
    const roles = await applyRolePasswords(db);
    if (roles.length) console.log(`login enabled for: ${roles.join(', ')}`);
  } finally {
    await close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations().then(
    () => console.log('migrations complete'),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
