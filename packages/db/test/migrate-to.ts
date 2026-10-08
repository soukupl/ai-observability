import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '../src/client.js';
import { migrationsFolder } from '../src/migrate.js';
import { ensureDefaultModelPrices } from '../src/prices.js';

/**
 * Migrates `url` up to and including the migration tagged `lastTag` (e.g. '0013_agent_flows'), then inserts the
 * default model prices like runMigrations does (model_prices is unchanged since 0000). Lets a migration test pin the
 * schema it was written for, or seed old-shape rows before applying later migrations with runMigrations.
 */
export async function migrateTo(url: string, lastTag: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-obs-migrate-to-'));
  const { db, close } = createDb({ url, max: 1 });
  try {
    cpSync(migrationsFolder, dir, { recursive: true });
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const last = journal.entries.findIndex((e) => e.tag === lastTag);
    if (last < 0) throw new Error(`migrateTo: no migration tagged ${lastTag}`);
    journal.entries = journal.entries.slice(0, last + 1);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: dir });
    await ensureDefaultModelPrices(db);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
}
