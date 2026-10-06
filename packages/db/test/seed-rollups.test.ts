import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { seed } from '../src/seed.js';

/**
 * The demo seed writes daily_rollups with the worker's fold (ADR-0015): turn counts on the turn's
 * primary model × effort, tokens on each usage row's model × effort. Then raw reads (usage rows) and
 * rollup reads agree exactly on the seeded data. Own database (ai_obs_seed_test).
 */
const url = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test');
url.pathname = '/ai_obs_seed_test';
const admin = new URL(url);
admin.pathname = '/postgres';

async function prepare(): Promise<string | null> {
  const a = postgres(admin.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await a`select 1`;
    await a.unsafe('drop database if exists "ai_obs_seed_test" with (force)');
    await a.unsafe('create database "ai_obs_seed_test"');
    return null;
  } catch (err) {
    return `Postgres not reachable (${(err as { code?: string }).code || (err as Error).message})`;
  } finally {
    await a.end({ timeout: 1 }).catch(() => {});
  }
}

const skip = await prepare();

describe.skipIf(skip !== null)(skip ? `seed rollups - SKIPPED: ${skip}` : 'seed rollups match the worker fold (real Postgres)', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const quiet = console.log;
    console.log = () => {};
    try {
      await runMigrations(url.toString());
      await seed(url.toString());
    } finally {
      console.log = quiet;
    }
    ({ db, close } = createDb({ url: url.toString(), max: 1 }));
  }, 60_000);

  afterAll(async () => {
    await close?.();
    const a = postgres(admin.toString(), { max: 1, onnotice: () => {} });
    await a.unsafe('drop database if exists "ai_obs_seed_test" with (force)').catch(() => {});
    await a.end({ timeout: 1 }).catch(() => {});
  });

  const q = async (query: ReturnType<typeof sql>) => [...(await db.execute(query))] as Record<string, unknown>[];
  const dayOf = sql.raw(`(t.started_at at time zone 'UTC')::date::text`);

  it('tokens per day × model × effort equal the usage rows (sub-agent models included)', async () => {
    const raw = await q(sql`select ${dayOf} as day, u.model, u.effort, sum(u.input_tokens)::bigint::text i, sum(u.output_tokens)::bigint::text o,
        sum(u.cache_read_tokens)::bigint::text cr, sum(u.cache_write_tokens)::bigint::text cw, sum(u.requests)::bigint::text rq
      from usage u join turns t on t.id = u.turn_id group by 1, 2, 3 order by 1, 2, 3 nulls first`);
    const roll = await q(sql`select day::text as day, model, effort, sum(input_tokens)::bigint::text i, sum(output_tokens)::bigint::text o,
        sum(cache_read_tokens)::bigint::text cr, sum(cache_write_tokens)::bigint::text cw, sum(requests)::bigint::text rq
      from daily_rollups group by 1, 2, 3 having sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + requests) > 0
      order by 1, 2, 3 nulls first`);
    expect(raw.length).toBeGreaterThan(0);
    expect(roll).toEqual(raw);
    expect(roll.some((r) => r.model === 'claude-haiku-4-5')).toBe(true);
  });

  it('turns and outcomes per day × primary model × effort equal the turns', async () => {
    const raw = await q(sql`select ${dayOf} as day, t.model, t.effort, count(*)::int turns,
        count(*) filter (where t.outcome = 'unknown')::int unknown from turns t group by 1, 2, 3 order by 1, 2, 3 nulls first`);
    const roll = await q(sql`select day::text as day, model, effort, sum(turns)::int turns, sum(unknown)::int unknown
      from daily_rollups group by 1, 2, 3 having sum(turns) > 0 order by 1, 2, 3 nulls first`);
    expect(roll).toEqual(raw);
    const [sub] = await q(sql`select sum(turns)::int turns from daily_rollups where model in ('claude-haiku-4-5', 'gpt-5.4-mini')`);
    expect(sub!.turns).toBe(0); // sub-agent-only models carry tokens, never turns
  });
});
