import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { DB_ROLES } from '../src/connections.js';
import { runMigrations } from '../src/migrate.js';
import { withIngestContext, withRlsContext } from '../src/rls.js';
import { pgErrorCode } from './db-harness.js';
import { migrateTo } from './migrate-to.js';
import { adminDbUrl, testDbName, testDbUrl } from './test-db.js';

/**
 * Migration 0018 (ADR-0028/0029/0030): a one-company database at 0017 becomes a single deployment. Each case migrates
 * its own database to 0017, writes company-era rows, then applies 0018 (runMigrations). Checks the transforms
 * (deployment row, memberships, team slugs, token source / expiry, dropped company objects and app_platform
 * privileges), that the rewritten policies work for app_web and app_ingest, and that the guard refuses a database with
 * two companies (brief Q3) without applying anything.
 */
const DBS = { one: testDbName('m0018'), two: testDbName('m0018b'), empty: testDbName('m0018c') } as const;
const adminUrl = adminDbUrl();

async function prepare(): Promise<string | null> {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    for (const name of Object.values(DBS)) {
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

describe.skipIf(skip !== null)(skip ? `migration 0018 - SKIPPED: ${skip}` : 'migration 0018 (real Postgres)', () => {
  const closers: Array<() => Promise<void>> = [];
  let owner: Database, web: Database, ingest: Database;
  const ids = {} as Record<
    | 'co' | 'core' | 'core2' | 'mobile' | 'admin' | 'lead' | 'member' | 'superAdmin' | 'liveTok' | 'revokedTok' | 'coTok'
    | 'turnAdmin' | 'turnMember' | 'turnUnverified' | 'session' | 'invitation',
    string
  >;
  let salt: string;
  const definer = async (q: ReturnType<typeof sql>) =>
    owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return [...(await tx.execute(q))] as Record<string, unknown>[];
    });

  beforeAll(async () => {
    const url = testDbUrl('m0018');
    await quietly(() => migrateTo(url, '0017_live_session_status'));
    let c;
    ({ db: owner, close: c } = createDb({ url, max: 1 }));
    closers.push(c);

    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      const one = async (q: ReturnType<typeof sql>) => ([...(await tx.execute(q))][0] as { id: string }).id;
      ids.co = await one(sql`insert into companies (name, slug, plan, settings) values ('SPECTADO', 'spectado', 'team',
        '{"individualVisibility": "full", "projectNaming": "plain", "retentionDays": 395, "runawayCostUsd": 20}') returning id`);
      salt = ([...(await tx.execute(sql`select project_salt from companies`))][0] as { project_salt: string }).project_salt;
      // Two names that slug the same: the older team gets 'core', the newer 'core-2'.
      ids.core = await one(sql`insert into teams (company_id, name, created_at) values (${ids.co}, 'Core', now() - interval '2 days') returning id`);
      ids.core2 = await one(sql`insert into teams (company_id, name, created_at) values (${ids.co}, 'core!', now() - interval '1 day') returning id`);
      ids.mobile = await one(sql`insert into teams (company_id, name) values (${ids.co}, 'Mobile Apps') returning id`);
      ids.admin = await one(sql`insert into users (email, name) values ('admin@m18.test', 'Admin') returning id`);
      ids.lead = await one(sql`insert into users (email, name) values ('lead@m18.test', 'Lead') returning id`);
      ids.member = await one(sql`insert into users (email, name) values ('member@m18.test', 'Member') returning id`);
      ids.superAdmin = await one(sql`insert into users (email, name, is_super_admin) values ('root@m18.test', 'Root', true) returning id`);
      await tx.execute(sql`insert into company_memberships (company_id, user_id, company_role, primary_team_id, last_active_at) values
        (${ids.co}, ${ids.admin}, 'admin', ${ids.core}, now()),
        (${ids.co}, ${ids.lead}, 'member', ${ids.core}, null),
        (${ids.co}, ${ids.member}, 'member', ${ids.mobile}, null)`);
      await tx.execute(sql`insert into team_memberships (company_id, team_id, user_id, role) values
        (${ids.co}, ${ids.core}, ${ids.admin}, 'member'), (${ids.co}, ${ids.core}, ${ids.lead}, 'lead'),
        (${ids.co}, ${ids.mobile}, ${ids.member}, 'member'), (${ids.co}, ${ids.core}, ${ids.member}, 'member')`);
      ids.liveTok = await one(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${ids.co}, ${ids.member}, 'user', 'laptop', 'aiobs_u_ab', 'h-live', ${ids.member}) returning id`);
      ids.revokedTok = await one(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id, revoked_at)
        values (${ids.co}, ${ids.lead}, 'user', 'old', 'aiobs_u_cd', 'h-revoked', ${ids.lead}, now() - interval '1 day') returning id`);
      ids.coTok = await one(sql`insert into ingest_tokens (company_id, kind, name, prefix, hash, created_by_user_id)
        values (${ids.co}, 'company', 'ci', 'aiobs_c_ef', 'h-company', ${ids.admin}) returning id`);
      ids.session = await one(sql`insert into agent_sessions (company_id, team_id, user_id, external_id, harness, started_at)
        values (${ids.co}, ${ids.mobile}, ${ids.member}, 'cc:s1', 'claude-code', now() - interval '2 hours') returning id`);
      const turn = (team: string, user: string | null, ext: string) => one(sql`insert into turns (company_id, team_id, user_id,
          attribution, session_id, external_id, harness, started_at, ended_at, input_tokens)
        values (${ids.co}, ${team}, ${user}, ${user ? 'verified' : 'unverified'}, ${ids.session}, ${ext}, 'claude-code',
          now() - interval '2 hours', now() - interval '1 hour', 100) returning id`);
      ids.turnAdmin = await turn(ids.core, ids.admin, 'cc:t-admin');
      ids.turnMember = await turn(ids.mobile, ids.member, 'cc:t-member');
      ids.turnUnverified = await turn(ids.core, null, 'cc:t-unverified');
      const run = await one(sql`insert into runs (company_id, team_id, user_id, turn_id, turn_external_id, external_id, agent_type, started_at, ended_at)
        values (${ids.co}, ${ids.mobile}, ${ids.member}, ${ids.turnMember}, 'cc:t-member', 'r1', 'Explore', now() - interval '2 hours', now() - interval '1 hour') returning id`);
      await tx.execute(sql`insert into usage (company_id, team_id, user_id, turn_id, run_id, started_at, model, input_tokens) values
        (${ids.co}, ${ids.mobile}, ${ids.member}, ${ids.turnMember}, null, now() - interval '2 hours', 'claude-opus-5-5', 90),
        (${ids.co}, ${ids.mobile}, ${ids.member}, ${ids.turnMember}, ${run}, now() - interval '2 hours', 'claude-haiku-4-5', 10)`);
      await tx.execute(sql`insert into daily_rollups (company_id, day, team_id, user_id, harness, model, turns, input_tokens) values
        (${ids.co}, current_date, ${ids.mobile}, ${ids.member}, 'claude-code', 'claude-opus-5-5', 1, 100),
        (${ids.co}, current_date, ${ids.core}, ${ids.admin}, 'claude-code', 'claude-opus-5-5', 1, 100)`);
      await tx.execute(sql`insert into machines (company_id, user_id, machine_id) values (${ids.co}, ${ids.member}, 'mac-1')`);
      await tx.execute(sql`insert into projects (company_id, key, team_id) values (${ids.co}, 'github.com/acme/app', ${ids.mobile})`);
      await tx.execute(sql`insert into ingest_events (company_id, event_id, type) values (${ids.co}, 'ev-1', 'turn')`);
      await tx.execute(sql`insert into budgets (company_id, team_id, kind, limit_value) values (${ids.co}, ${ids.core}, 'cost', 100)`);
      await tx.execute(sql`insert into budgets (company_id, user_id, kind, limit_value) values (${ids.co}, ${ids.member}, 'tokens', 1000)`);
      ids.invitation = await one(sql`insert into invitations (company_id, email, team_id, team_role, company_role, invited_by_user_id, expires_at)
        values (${ids.co}, 'new@m18.test', ${ids.mobile}, 'member', 'member', ${ids.admin}, now() + interval '7 days') returning id`);
      await tx.execute(sql`insert into auth_sessions (user_id, token_hash, expires_at, active_company_id)
        values (${ids.member}, 'sess-member', now() + interval '1 day', ${ids.co}),
               (${ids.superAdmin}, 'sess-root', now() + interval '1 day', null)`);
      await tx.execute(sql`insert into audit_log (company_id, actor_user_id, action) values (${ids.co}, ${ids.admin}, 'token.revoke'),
        (null, ${ids.superAdmin}, 'platform.plan_change')`);
      await tx.execute(sql`insert into identity_providers (company_id, kind, name) values (${ids.co}, 'oidc', 'Okta')`);
      await tx.execute(sql`insert into pending_turn_patches (company_id, turn_external_id, summary, user_id)
        values (${ids.co}, 'cc:t-later', 'Parked', ${ids.member})`);
    });

    await quietly(() => runMigrations(url));
    ({ db: web, close: c } = createDb({ url, role: DB_ROLES.web, max: 1 }));
    closers.push(c);
    ({ db: ingest, close: c } = createDb({ url, role: DB_ROLES.ingest, max: 1 }));
    closers.push(c);
  }, 90_000);

  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    for (const name of Object.values(DBS)) await admin.unsafe(`drop database if exists "${name}" with (force)`).catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
  }, 30_000);

  it('creates the one deployment row from the company: name, slug, settings and project salt', async () => {
    const d = await definer(sql`select name, slug, settings, project_salt from deployment`);
    expect(d).toEqual([{
      name: 'SPECTADO', slug: 'spectado', project_salt: salt,
      settings: { individualVisibility: 'full', projectNaming: 'plain', retentionDays: 395, runawayCostUsd: 20 },
    }]);
  });

  it('moves company memberships to memberships (role, primary team) and drops the company objects', async () => {
    const ms = await definer(sql`select user_id, role, primary_team_id from memberships order by role, user_id`);
    expect(new Map(ms.map((m) => [m.user_id, m]))).toEqual(new Map([
      [ids.admin, { user_id: ids.admin, role: 'admin', primary_team_id: ids.core }],
      [ids.lead, { user_id: ids.lead, role: 'member', primary_team_id: ids.core }],
      [ids.member, { user_id: ids.member, role: 'member', primary_team_id: ids.mobile }],
    ]));
    const [left] = await definer(sql`select
      (select count(*)::int from information_schema.columns where table_schema = 'public'
        and (column_name in ('company_id', 'active_company_id', 'is_super_admin', 'last_active_at') or (table_name = 'ingest_tokens' and column_name = 'kind'))) as cols,
      (select count(*)::int from information_schema.tables where table_schema = 'public'
        and table_name in ('companies', 'company_memberships', 'identity_providers')) as tables,
      (select count(*)::int from pg_type where typname in ('plan', 'company_status', 'identity_provider_kind', 'token_kind', 'company_role')) as types,
      (select count(*)::int from pg_proc where proname in ('app_company', 'app_ingest_company', 'auth_create_solo_company',
        'auth_ensure_super_admin', 'company_has_user_capacity', 'auth_user_memberships', 'auth_set_session_company',
        'ingest_match_user_by_email', 'platform_company_counts', 'platform_invitee_status')) as functions,
      (select count(*)::int from pg_trigger where tgname in ('company_memberships_no_super_admin', 'users_super_admin_no_membership',
        'auth_sessions_mark_membership')) as triggers`);
    expect(left).toEqual({ cols: 0, tables: 0, types: 0, functions: 0, triggers: 0 });
    // The membership-less super-admin identity is deleted with its dashboard session; everyone left is a person.
    expect(await definer(sql`select email, kind from users order by email`)).toEqual([
      { email: 'admin@m18.test', kind: 'person' }, { email: 'lead@m18.test', kind: 'person' }, { email: 'member@m18.test', kind: 'person' },
    ]);
    expect(await definer(sql`select token_hash from auth_sessions order by token_hash`)).toEqual([{ token_hash: 'sess-member' }]);
    // Invitations keep team and role; audit rows stay (the platform row loses its deleted actor).
    expect(await definer(sql`select team_id, role from invitations where id = ${ids.invitation}`)).toEqual([{ team_id: ids.mobile, role: 'member' }]);
    expect(await definer(sql`select action, actor_user_id from audit_log order by action`)).toEqual([
      { action: 'platform.plan_change', actor_user_id: null }, { action: 'token.revoke', actor_user_id: ids.admin },
    ]);
  });

  it('backfills unique team slugs from the names (older team first)', async () => {
    expect(await definer(sql`select name, slug from teams order by created_at`)).toEqual([
      { name: 'Core', slug: 'core' },
      { name: 'core!', slug: 'core-2' },
      { name: 'Mobile Apps', slug: 'mobile-apps' },
    ]);
  });

  it('tokens: company tokens are gone; live user tokens become manual tokens expiring 90 days after the cutover (Q7)', async () => {
    const toks = await definer(sql`select id, source, label, revoked_at is not null as revoked,
      coalesce(expires_at between now() + interval '89 days' and now() + interval '91 days', false) as ninety, expires_at is null as no_expiry
      from ingest_tokens order by hash`);
    expect(toks).toEqual([
      { id: ids.liveTok, source: 'manual', label: null, revoked: false, ninety: true, no_expiry: false },
      { id: ids.revokedTok, source: 'manual', label: null, revoked: true, ninety: false, no_expiry: true },
    ]);
    const [tok] = [...(await ingest.execute(sql`select * from lookup_ingest_token('h-live')`))];
    expect(tok).toMatchObject({ token_id: ids.liveTok, user_id: ids.member, user_email: 'member@m18.test', user_kind: 'person',
      primary_team_id: ids.mobile, project_salt: salt, deployment_name: 'SPECTADO', deployment_slug: 'spectado' });
    expect([...(await ingest.execute(sql`select * from lookup_ingest_token('h-company')`))]).toHaveLength(0);
    expect([...(await ingest.execute(sql`select * from lookup_ingest_token('h-revoked')`))]).toHaveLength(0);
  });

  it('keeps every telemetry row and the per-user rollups; the rewritten web policies apply (full mode kept)', async () => {
    const [n] = await definer(sql`select (select count(*)::int from turns) as turns, (select count(*)::int from runs) as runs,
      (select count(*)::int from usage) as usage, (select count(*)::int from daily_rollups) as rollups,
      (select count(*)::int from budgets) as budgets, (select count(*)::int from pending_turn_patches) as parked`);
    expect(n).toEqual({ turns: 3, runs: 1, usage: 2, rollups: 2, budgets: 2, parked: 1 });
    const as = <T>(userId: string, role: 'admin' | 'member', fn: Parameters<typeof withRlsContext<T>>[2]) =>
      withRlsContext(web, { userId, role }, fn);
    const turnIds = async (userId: string, role: 'admin' | 'member') =>
      as(userId, role, async (tx) => [...(await tx.execute(sql`select id from turns`))].map((r) => r.id).sort());
    expect(await turnIds(ids.member, 'member')).toEqual([ids.turnMember]);
    expect(await turnIds(ids.admin, 'admin')).toEqual([ids.turnAdmin, ids.turnMember, ids.turnUnverified].sort());
    expect(await turnIds(ids.lead, 'member')).toEqual([ids.turnAdmin, ids.turnUnverified].sort()); // leads core
    expect(await turnIds(ids.superAdmin, 'admin')).toEqual([]); // no membership, no access
    const sessions = [...(await web.execute(sql`select token_hash from auth_sessions where user_id = ${ids.member}::uuid`))];
    expect(sessions).toEqual([{ token_hash: 'sess-member' }]);
  });

  it('ingest writes through the new policies: only the token user’s rows, slugs resolve by membership', async () => {
    await withIngestContext(ingest, ids.member, async (tx) => {
      const ins = await tx.execute(sql`insert into turns (team_id, user_id, attribution, external_id, harness, started_at, ended_at)
        values (${ids.mobile}, ${ids.member}, 'verified', 'cc:t-new', 'codex', now(), now()) returning id`);
      expect([...ins]).toHaveLength(1);
      const upd = await tx.execute(sql`update turns set summary = 'x' where external_id = 'cc:t-admin'`);
      expect(upd.count).toBe(0);
    });
    expect(await pgErrorCode(withIngestContext(ingest, ids.member, (tx) => tx.execute(sql`insert into turns
      (team_id, user_id, attribution, external_id, harness, started_at, ended_at)
      values (${ids.core}, ${ids.admin}, 'verified', 'cc:t-forged', 'codex', now(), now())`)))).toBe('42501');
    const resolve = async (slug: string) =>
      ([...(await ingest.execute(sql`select ingest_resolve_team(${ids.member}::uuid, ${slug}) as t`))][0] as { t: string | null }).t;
    expect(await resolve('core')).toBe(ids.core);
    expect(await resolve('core-2')).toBeNull();
  });

  it('a former super admin listed in ADMIN_EMAILS is provisioned afresh as admin (not refused as a removed member)', async () => {
    // Login looks the e-mail up first: an identity without a membership would be refused as removed; it is gone.
    expect([...(await web.execute(sql`select * from auth_find_user_by_email('root@m18.test')`))]).toEqual([]);
    const [p] = [...(await web.execute(sql`select * from auth_provision_member('root@m18.test', 'Root', 'admin')`))];
    expect(p).toMatchObject({ created: true });
    expect([...(await web.execute(sql`select email, role from auth_find_user_by_email('root@m18.test')`))]).toEqual([
      { email: 'root@m18.test', role: 'admin' },
    ]);
  });

  it('every SECURITY DEFINER function is owned by app_definer', async () => {
    const owners = await definer(sql`select p.proowner::regrole::text as owner, count(*)::int as n from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef group by 1`);
    expect(owners).toEqual([{ owner: 'app_definer', n: expect.any(Number) }]);
  });

  it('app_platform keeps no privilege, policy or function in this database', async () => {
    const [p] = await definer(sql`select
      (select count(*)::int from information_schema.role_table_grants where grantee = 'app_platform') as tables,
      (select count(*)::int from information_schema.role_routine_grants where grantee = 'app_platform') as routines,
      (select count(*)::int from pg_policies where 'app_platform' = any (roles)) as policies,
      (select count(*)::int from pg_namespace n cross join lateral aclexplode(n.nspacl) a
        join pg_roles r on r.oid = a.grantee where n.nspname = 'public' and r.rolname = 'app_platform') as schema_usage`);
    expect(p).toEqual({ tables: 0, routines: 0, policies: 0, schema_usage: 0 });
  });

  it('leaves the cluster-wide app_platform role in place (only its privileges go)', async () => {
    // Roles are shared by every database of the cluster: dropping one here raced the other test databases
    // ("role ... was concurrently dropped"). The operator drops it by hand once no database uses it.
    const [r] = await definer(sql`select exists (select 1 from pg_roles where rolname = 'app_platform') as present`);
    expect(r).toEqual({ present: true });
  });

  it('a fresh database gets a default deployment row', async () => {
    const url = testDbUrl('m0018c');
    await quietly(() => runMigrations(url));
    const { db, close } = createDb({ url, max: 1 });
    closers.push(close);
    const d = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return [...(await tx.execute(sql`select name, slug, settings->>'retentionDays' as r from deployment`))];
    });
    expect(d).toEqual([{ name: 'ai-obs', slug: 'ai-obs', r: '395' }]);
  }, 60_000);

  it('refuses a database with two companies, naming the merge script, and applies nothing (one transaction)', async () => {
    const url = testDbUrl('m0018b');
    await quietly(() => migrateTo(url, '0017_live_session_status'));
    const { db, close } = createDb({ url, max: 1 });
    closers.push(close);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.execute(sql`insert into companies (name, slug) values ('Acme', 'acme'), ('Globex', 'globex')`);
    });
    const err = await quietly(() => runMigrations(url)).then(() => null, (e: unknown) => e as Error & { cause?: Error });
    expect(err).not.toBeNull();
    expect(`${err!.message} ${err!.cause?.message ?? ''}`).toMatch(
      /needs at most one company, found 2 \(acme, globex\).*pnpm --filter @ai-obs\/db db:merge-companies/,
    );
    const [state] = [...(await db.execute(sql`select
      (select count(*)::int from information_schema.tables where table_name = 'deployment') as deployment,
      (select count(*)::int from information_schema.columns where table_name = 'turns' and column_name = 'company_id') as company_col`))];
    expect(state).toEqual({ deployment: 0, company_col: 1 });
  }, 60_000);
});
