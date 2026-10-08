import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { DEMO_COMPANY_SLUG, DEMO_SECOND_COMPANY_SLUG, seed } from '../src/seed.js';

/**
 * The demo seed writes daily_rollups with the worker's fold (ADR-0015): turn counts on the turn's
 * primary model × effort, tokens on each usage row's model × effort. Then raw reads (usage rows) and
 * rollup reads agree exactly on the seeded data. Also checks the demo tenancy (ADR-0022: alice is a member of Acme and
 * Globex, the super admin of none) and that a second run is idempotent. Own database (ai_obs_seed_test).
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
  }, 30_000);

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

  it('skill / MCP rollups equal the raw turns and runs (server rows count each turn once)', async () => {
    const raw = await q(sql`with uses as (
        select t.id, ${dayOf} as day, u.skills, u.mcp from turns t
        cross join lateral (select t.skills, t.mcp union all select r.skills, r.mcp from runs r where r.turn_id = t.id) u
      ), flat as (
        select id, day, 'skill' as kind, s.key as name, '' as tool, (s.value->>'model')::int + (s.value->>'user')::int as calls
        from uses cross join lateral jsonb_each(skills) s
        union all
        select id, day, 'mcp', m.key, tl.key, (tl.value #>> '{}')::int from uses cross join lateral jsonb_each(mcp) m cross join lateral jsonb_each(m.value) tl
      )
      select day, kind, name, tool, sum(calls)::int calls, count(distinct id)::int turns from flat group by 1, 2, 3, 4
      union all
      select day, kind, name, '', sum(calls)::int, count(distinct id)::int from flat where kind = 'mcp' group by 1, 2, 3
      order by 1, 2, 3, 4`);
    const roll = await q(sql`select day::text as day, kind, name, tool, sum(calls)::int calls, sum(turns)::int turns
      from daily_skill_mcp_rollups group by 1, 2, 3, 4 order by 1, 2, 3, 4`);
    expect(raw.length).toBeGreaterThan(0);
    expect(roll).toEqual(raw);
  });

  it('wasted / unknown tokens per day × usage model equal the usage rows of failed / abandoned / unknown turns', async () => {
    const raw = await q(sql`select ${dayOf} as day, u.model,
        coalesce(sum(u.input_tokens) filter (where t.outcome in ('failed', 'abandoned')), 0)::bigint::text w,
        coalesce(sum(u.input_tokens) filter (where t.outcome = 'unknown'), 0)::bigint::text unk
      from usage u join turns t on t.id = u.turn_id group by 1, 2 order by 1, 2`);
    const roll = await q(sql`select day::text as day, model, sum(wasted_input_tokens)::bigint::text w, sum(unknown_input_tokens)::bigint::text unk
      from daily_rollups group by 1, 2 having sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + requests) > 0
      order by 1, 2`);
    expect(roll).toEqual(raw);
  });
  const tenancy = () =>
    q(sql`select u.email, c.slug, m.company_role, t.name as primary_team
      from company_memberships m join users u on u.id = m.user_id join companies c on c.id = m.company_id
      left join teams t on t.id = m.primary_team_id order by c.slug, u.email`);

  it('seeds Acme and Globex; alice is a member of both, the super admin of none (ADR-0022)', async () => {
    const [cos] = await q(sql`select string_agg(slug || ':' || plan, ',' order by slug) as s from companies`);
    expect(cos!.s).toBe(`${DEMO_COMPANY_SLUG}:team,${DEMO_SECOND_COMPANY_SLUG}:free`);
    const ms = await tenancy();
    expect(ms.filter((m) => m.email === 'alice@acme.example')).toEqual([
      { email: 'alice@acme.example', slug: 'acme', company_role: 'admin', primary_team: 'Platform' },
      { email: 'alice@acme.example', slug: 'globex', company_role: 'member', primary_team: 'Core' },
    ]);
    expect(ms.filter((m) => m.slug === 'globex')).toEqual([
      { email: 'alice@acme.example', slug: 'globex', company_role: 'member', primary_team: 'Core' },
      { email: 'gina@globex.example', slug: 'globex', company_role: 'admin', primary_team: 'Core' },
    ]);
    const [sa] = await q(sql`select count(m.id)::int as n from users u left join company_memberships m on m.user_id = u.id
      where u.is_super_admin group by u.id`);
    expect(sa).toEqual({ n: 0 });
    const [globexTurns] = await q(sql`select count(*)::int as n from turns t join companies c on c.id = t.company_id
      where c.slug = ${DEMO_SECOND_COMPANY_SLUG}`);
    expect(globexTurns!.n).toBe(0);
  });

  it('a second seed run is idempotent (no duplicate users, same memberships)', async () => {
    const before = await tenancy();
    const [users1] = await q(sql`select count(*)::int as n from users`);
    const quiet = console.log;
    console.log = () => {};
    try {
      await seed(url.toString());
    } finally {
      console.log = quiet;
    }
    expect(await tenancy()).toEqual(before);
    const [users2] = await q(sql`select count(*)::int as n from users`);
    expect(users2!.n).toBe(users1!.n);
    const [turns] = await q(sql`select count(*)::int as n from turns`);
    expect(turns!.n).toBe(300);
  }, 60_000);

  it('a re-seed keeps what a demo identity has in another company (users are shared identities)', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.execute(sql`with c as (insert into companies (name, slug) values ('Devco', 'devco') returning id),
        a as (select id from users where email = 'alice@acme.example')
        insert into company_memberships (company_id, user_id, company_role) select c.id, a.id, 'admin' from c, a`);
      await tx.execute(sql`insert into turns (company_id, user_id, attribution, external_id, harness, started_at, ended_at)
        select c.id, u.id, 'verified', 'devco-1', 'codex', now(), now()
        from companies c, users u where c.slug = 'devco' and u.email = 'alice@acme.example'`);
    });
    const quiet = console.log;
    console.log = () => {};
    try {
      await seed(url.toString());
    } finally {
      console.log = quiet;
    }
    expect((await tenancy()).filter((m) => m.slug === 'devco')).toEqual([
      { email: 'alice@acme.example', slug: 'devco', company_role: 'admin', primary_team: null },
    ]);
    const [devTurns] = await q(sql`select count(*)::int as n from turns t join companies c on c.id = t.company_id where c.slug = 'devco'`);
    expect(devTurns!.n).toBe(1);
    const [acmeTurns] = await q(sql`select count(*)::int as n from turns t join companies c on c.id = t.company_id where c.slug = ${DEMO_COMPANY_SLUG}`);
    expect(acmeTurns!.n).toBe(300);
  }, 60_000);
});
