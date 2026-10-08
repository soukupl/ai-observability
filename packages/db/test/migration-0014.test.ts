import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { DB_ROLES } from '../src/connections.js';
import { runMigrations } from '../src/migrate.js';
import { withIngestContext, withRlsContext } from '../src/rls.js';
import { pgErrorCode } from './db-harness.js';
import { migrateTo } from './migrate-to.js';

/**
 * Migration 0014 (ADR-0022): the users columns company_id / company_role / primary_team_id move into
 * company_memberships, the session gets an active company, tokens of the old kind 'team' become (revoked) company
 * tokens and every token is revoked (clean break). Each case migrates its own database to 0013, writes old-shape
 * rows, then applies 0014 (runMigrations).
 */
const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test');
const urlOf = (name: string) => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
};
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';
const DBS = ['ai_obs_m0014_test', 'ai_obs_m0014b_test'] as const;

async function prepare(): Promise<string | null> {
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    for (const name of DBS) {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.unsafe(`create database "${name}"`);
    }
    return null;
  } catch (err) {
    return `Postgres not reachable (${(err as { code?: string }).code || (err as Error).message})`;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

const skip = await prepare();

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

describe.skipIf(skip !== null)(skip ? `migration 0014 - SKIPPED: ${skip}` : 'migration 0014 (real Postgres)', () => {
  const closers: Array<() => Promise<void>> = [];
  let owner: Database, web: Database, ingest: Database;
  const ids = {} as Record<
    'co' | 'other' | 'teamA' | 'teamB' | 'otherTeam' | 'admin' | 'member' | 'stray' | 'superAdmin' | 'turn' | 'teamTok' | 'userTok',
    string
  >;
  const lastLogin = '2026-09-30T12:00:00.000Z';
  const definer = async (q: ReturnType<typeof sql>) =>
    owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return [...(await tx.execute(q))] as Record<string, unknown>[];
    });

  beforeAll(async () => {
    const url = urlOf('ai_obs_m0014_test');
    await migrateTo(url, '0013_agent_flows');
    let c;
    ({ db: owner, close: c } = createDb({ url, max: 1 }));
    closers.push(c);

    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      const one = async (q: ReturnType<typeof sql>) => ([...(await tx.execute(q))][0] as { id: string }).id;
      ids.co = await one(sql`insert into companies (name, slug) values ('Old', 'old') returning id`);
      ids.other = await one(sql`insert into companies (name, slug) values ('Other', 'other') returning id`);
      ids.teamA = await one(sql`insert into teams (company_id, name) values (${ids.co}, 'A') returning id`);
      ids.teamB = await one(sql`insert into teams (company_id, name) values (${ids.co}, 'B') returning id`);
      ids.otherTeam = await one(sql`insert into teams (company_id, name) values (${ids.other}, 'X') returning id`);
      ids.admin = await one(sql`insert into users (company_id, email, name, company_role, primary_team_id, last_login_at)
        values (${ids.co}, 'admin@old.test', 'Admin', 'admin', ${ids.teamA}, ${lastLogin}) returning id`);
      ids.member = await one(sql`insert into users (company_id, email, name, company_role, primary_team_id)
        values (${ids.co}, 'member@old.test', 'Member', 'member', ${ids.teamB}) returning id`);
      // The old FK allowed a primary team of another company: the backfill drops it instead of failing.
      ids.stray = await one(sql`insert into users (company_id, email, name, primary_team_id)
        values (${ids.co}, 'stray@old.test', 'Stray', ${ids.otherTeam}) returning id`);
      ids.superAdmin = await one(sql`insert into users (email, name, is_super_admin) values ('root@old.test', 'Root', true) returning id`);
      await tx.execute(sql`insert into team_memberships (company_id, team_id, user_id, role) values
        (${ids.co}, ${ids.teamA}, ${ids.admin}, 'lead'), (${ids.co}, ${ids.teamB}, ${ids.member}, 'member')`);
      ids.teamTok = await one(sql`insert into ingest_tokens (company_id, team_id, kind, name, prefix, hash)
        values (${ids.co}, ${ids.teamA}, 'team', 'ci', 'old_ab', 'h-team') returning id`);
      ids.userTok = await one(sql`insert into ingest_tokens (company_id, team_id, user_id, kind, name, prefix, hash)
        values (${ids.co}, ${ids.teamB}, ${ids.member}, 'user', 'laptop', 'aiobs_u_ab', 'h-user') returning id`);
      await tx.execute(sql`insert into auth_sessions (user_id, token_hash, expires_at)
        values (${ids.member}, 'sess-member', now() + interval '1 day')`);
      ids.turn = await one(sql`insert into turns (company_id, team_id, user_id, attribution, external_id, harness, started_at, ended_at)
        values (${ids.co}, ${ids.teamB}, ${ids.member}, 'verified', 'cc:t1', 'claude-code', now(), now()) returning id`);
    });

    await quietly(() => runMigrations(url));
    ({ db: web, close: c } = createDb({ url, role: DB_ROLES.web, max: 1 }));
    closers.push(c);
    ({ db: ingest, close: c } = createDb({ url, role: DB_ROLES.ingest, max: 1 }));
    closers.push(c);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    for (const name of DBS) await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
  }, 30_000);

  it('backfills one membership per company user with role, primary team and last_active_at = last_login_at', async () => {
    const ms = await definer(sql`select user_id, company_id, company_role, primary_team_id, last_active_at
      from company_memberships order by company_role, user_id`);
    const byUser = new Map(ms.map((m) => [m.user_id as string, m]));
    expect(ms).toHaveLength(3);
    expect(byUser.get(ids.admin)).toMatchObject({ company_id: ids.co, company_role: 'admin', primary_team_id: ids.teamA });
    expect(new Date(byUser.get(ids.admin)!.last_active_at as string).toISOString()).toBe(lastLogin);
    expect(byUser.get(ids.member)).toMatchObject({ company_id: ids.co, company_role: 'member', primary_team_id: ids.teamB, last_active_at: null });
    expect(byUser.get(ids.stray)).toMatchObject({ company_id: ids.co, primary_team_id: null });
    expect(byUser.has(ids.superAdmin)).toBe(false);
  });

  it('drops the company columns from users and team_id from ingest_tokens', async () => {
    const cols = await definer(sql`select table_name, column_name from information_schema.columns
      where (table_name = 'users' and column_name in ('company_id', 'company_role', 'primary_team_id'))
         or (table_name = 'ingest_tokens' and column_name = 'team_id')`);
    expect(cols).toEqual([]);
  });

  it('revokes every token (clean break); the old team-kind token is now a company token; lookups return nothing', async () => {
    const toks = await definer(sql`select hash, kind::text, user_id, revoked_at is not null as revoked from ingest_tokens order by hash`);
    expect(toks).toEqual([
      { hash: 'h-team', kind: 'company', user_id: null, revoked: true },
      { hash: 'h-user', kind: 'user', user_id: ids.member, revoked: true },
    ]);
    for (const h of ['h-team', 'h-user']) {
      const found = await withIngestContext(ingest, ids.co, async (tx) => [...(await tx.execute(sql`select * from lookup_ingest_token(${h})`))]);
      expect(found, h).toHaveLength(0);
    }
    const kinds = await definer(sql`select unnest(enum_range(null::token_kind))::text as k`);
    expect(kinds.map((k) => k.k)).toEqual(['user', 'company']);
  });

  it('points existing sessions at the user’s company and keeps the telemetry', async () => {
    const [s] = [...(await web.execute(sql`select active_company_id from auth_sessions where token_hash = 'sess-member'`))];
    expect(s).toEqual({ active_company_id: ids.co });
    expect(await definer(sql`select id, user_id from turns`)).toEqual([{ id: ids.turn, user_id: ids.member }]);
  });

  it('a team membership requires a company membership (23503)', async () => {
    const insert = definer(sql`insert into team_memberships (company_id, team_id, user_id) values (${ids.other}, ${ids.otherTeam}, ${ids.member})`);
    expect(await pgErrorCode(insert)).toBe('23503');
  });

  it('app_definer owns the replaced helpers and the new functions', async () => {
    const owners = await definer(sql`select proname, pg_get_userbyid(proowner) as owner from pg_proc
      where proname in ('app_company', 'app_is_admin', 'lookup_ingest_token', 'admin_remove_member') order by proname`);
    expect(owners).toEqual([
      { proname: 'admin_remove_member', owner: 'app_definer' },
      { proname: 'app_company', owner: 'app_definer' },
      { proname: 'app_is_admin', owner: 'app_definer' },
      { proname: 'lookup_ingest_token', owner: 'app_definer' },
    ]);
  });

  it('the RLS context works after the upgrade (helpers read memberships, not the dropped column)', async () => {
    const ctx = { companyId: ids.co, userId: ids.member, role: 'member' as const };
    const seen = await withRlsContext(web, ctx, async (tx) => ({
      turns: [...(await tx.execute(sql`select id from turns`))].map((r) => r.id),
      users: [...(await tx.execute(sql`select email from users order by email`))].map((r) => r.email),
      company: [...(await tx.execute(sql`select app_company() as c`))][0]!.c,
    }));
    expect(seen).toEqual({ turns: [ids.turn], users: ['admin@old.test', 'member@old.test', 'stray@old.test'], company: ids.co });
    const outside = await withRlsContext(web, { ...ctx, companyId: ids.other }, async (tx) =>
      [...(await tx.execute(sql`select app_company() as c`))][0]!.c);
    expect(outside).toBeNull();
  });

  it('refuses to migrate a super admin who is also a company user (ADR-0022 message)', async () => {
    const url = urlOf('ai_obs_m0014b_test');
    await migrateTo(url, '0013_agent_flows');
    const { db, close } = createDb({ url, max: 1 });
    closers.push(close);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      const [co] = [...(await tx.execute(sql`insert into companies (name, slug) values ('Both', 'both') returning id`))] as { id: string }[];
      await tx.execute(sql`insert into users (company_id, email, is_super_admin) values (${co!.id}, 'both@old.test', true)`);
    });
    const err = await quietly(() => runMigrations(url)).then(() => null, (e: unknown) => e as Error & { cause?: Error });
    expect(err).not.toBeNull();
    expect(`${err!.message} ${err!.cause?.message ?? ''}`).toMatch(/ADR-0022: super admins cannot be company members.*both@old\.test/);
    // Nothing of 0014 was applied (one transaction).
    const [cols] = [...(await db.execute(sql`select count(*)::int as n from information_schema.columns
      where table_name = 'users' and column_name = 'company_id'`))] as { n: number }[];
    expect(cols!.n).toBe(1);
  }, 60_000);
});
