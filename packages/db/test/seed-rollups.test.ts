import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { DEMO_DEPLOYMENT, DEMO_SERVICE_USER, seed } from '../src/seed.js';
import { adminDbUrl, testDbName, testDbUrl } from './test-db.js';

/**
 * The demo seed writes daily_rollups with the worker's fold (ADR-0015): turn counts on the turn's
 * primary model × effort, tokens on each usage row's model × effort. Then raw reads (usage rows) and
 * rollup reads agree exactly on the seeded data. Also checks the demo deployment (ADR-0028: one deployment SPECTADO,
 * the ADMIN_EMAILS admin, a service user, tokens with an expiry, no super admin) and that a second run is idempotent.
 * Own database.
 */
const DB = testDbName('seed');
const url = new URL(testDbUrl('seed'));
const admin = new URL(adminDbUrl());

async function prepare(): Promise<string | null> {
  const a = postgres(admin.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await a`select 1`;
    await a.unsafe(`drop database if exists "${DB}" with (force)`);
    await a.unsafe(`create database "${DB}"`);
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
    await a.unsafe(`drop database if exists "${DB}" with (force)`).catch(() => {});
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
    q(sql`select coalesce(u.email, u.name) as who, u.kind, m.role, t.name as primary_team,
        (select string_agg(tt.name || ':' || tm.role, ',' order by tt.name) from team_memberships tm join teams tt on tt.id = tm.team_id
         where tm.user_id = u.id) as teams
      from memberships m join users u on u.id = m.user_id left join teams t on t.id = m.primary_team_id order by u.kind, coalesce(u.email, u.name) collate "C"`);

  it('seeds one deployment SPECTADO with the demo people, the ADMIN_EMAILS admin and a service user (ADR-0028)', async () => {
    expect(await q(sql`select name, slug from deployment`)).toEqual([{ name: DEMO_DEPLOYMENT.name, slug: DEMO_DEPLOYMENT.slug }]);
    expect(await tenancy()).toEqual([
      { who: 'admin@example.com', kind: 'person', role: 'admin', primary_team: null, teams: null },
      { who: 'alice@acme.example', kind: 'person', role: 'admin', primary_team: 'Platform', teams: 'Platform:member' },
      { who: 'bob@acme.example', kind: 'person', role: 'member', primary_team: 'Platform', teams: 'Platform:lead' },
      { who: 'carol@acme.example', kind: 'person', role: 'member', primary_team: 'Platform', teams: 'Platform:member' },
      { who: 'dave@acme.example', kind: 'person', role: 'member', primary_team: 'Mobile', teams: 'Mobile:member' },
      { who: DEMO_SERVICE_USER, kind: 'service', role: 'member', primary_team: 'Platform', teams: 'Platform:member' },
    ]);
    expect(await q(sql`select name, slug from teams order by name`)).toEqual([
      { name: 'Mobile', slug: 'mobile' },
      { name: 'Platform', slug: 'platform' },
    ]);
    const toks = await q(sql`select coalesce(u.email, u.name) as who, t.source, t.label, t.expires_at > now() as live
      from ingest_tokens t join users u on u.id = t.user_id order by u.kind, coalesce(u.email, u.name) collate "C"`);
    expect(toks).toEqual([
      { who: 'alice@acme.example', source: 'manual', label: null, live: true },
      { who: 'bob@acme.example', source: 'device', label: 'bob-macbook', live: true },
      { who: 'carol@acme.example', source: 'manual', label: null, live: true },
      { who: DEMO_SERVICE_USER, source: 'manual', label: null, live: true },
    ]);
  });

  it('a second seed run is idempotent (no duplicate users, same memberships, same telemetry)', async () => {
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
    const [toks] = await q(sql`select count(*)::int as n from ingest_tokens`);
    expect(toks!.n).toBe(4);
  }, 60_000);

  it('a re-seed keeps what is not demo data (another team, its member and telemetry; an existing admin)', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.execute(sql`with t as (insert into teams (name) values ('Devco') returning id),
        u as (insert into users (email, name) values ('eve@devco.example', 'Eve') returning id),
        m as (insert into memberships (user_id, role, primary_team_id) select u.id, 'member', t.id from u, t returning user_id)
        insert into team_memberships (team_id, user_id) select t.id, m.user_id from t, m`);
      await tx.execute(sql`insert into turns (team_id, user_id, attribution, external_id, harness, started_at, ended_at)
        select t.id, u.id, 'verified', 'devco-1', 'codex', now(), now() from teams t, users u
        where t.name = 'Devco' and u.email = 'eve@devco.example'`);
    });
    const quiet = console.log;
    console.log = () => {};
    try {
      await seed(url.toString());
    } finally {
      console.log = quiet;
    }
    expect((await tenancy()).filter((m) => m.who === 'eve@devco.example')).toEqual([
      { who: 'eve@devco.example', kind: 'person', role: 'member', primary_team: 'Devco', teams: 'Devco:member' },
    ]);
    const [devTurns] = await q(sql`select count(*)::int as n from turns where external_id = 'devco-1'`);
    expect(devTurns!.n).toBe(1);
    const [all] = await q(sql`select count(*)::int as n from turns`);
    expect(all!.n).toBe(301);
  }, 60_000);
});
