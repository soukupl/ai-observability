import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDbUrl, testDbName, testDbUrl } from './test-db.js';
import { createDb, type Database } from '../src/client.js';
import { DB_ROLES } from '../src/connections.js';
import { LEGACY_PLATFORM_ROLE, legacyIngestContext } from './legacy-context.js';
import { migrateTo } from './migrate-to.js';

/**
 * Migration 0004 (review fixes SEC-1/3/4/6/7/10/11, dod:C2): invitation consent functions, plan capacity
 * at accept time, user tokens needing a live membership, git-e-mail attribution limited to the team a
 * token was bound to, parked-patch ownership, platform audit scope and e-mail check, per-company project salt.
 * Own database (ai_obs_m0004_test), migrated up to 0004 only (migrateTo): these are the 0004 semantics, which
 * migration 0014 (ADR-0022: memberships, company + user tokens) later replaced.
 */
const DB = testDbName('m0004');
const URL_ = testDbUrl('m0004');
const adminUrl = new URL(adminDbUrl());

async function prepare(): Promise<string | null> {
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    await admin.unsafe(`drop database if exists "${DB}" with (force)`);
    await admin.unsafe(`create database "${DB}"`);
    return null;
  } catch (err) {
    return `Postgres not reachable (${(err as { code?: string }).code || (err as Error).message})`;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

const skip = await prepare();
const rows = async <T>(db: Database, q: ReturnType<typeof sql>) => [...(await db.execute(q))] as unknown as T[];
/** Reads as app_definer (the schema owner is subject to FORCE RLS). */
const asDefiner = <T>(db: Database, q: ReturnType<typeof sql>) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_definer`);
    return [...(await tx.execute(q))] as unknown as T[];
  });

describe.skipIf(skip !== null)(skip ? `migration 0004 - SKIPPED: ${skip}` : 'migration 0004 (real Postgres)', () => {
  let owner: Database;
  let web: Database;
  let ingest: Database;
  let platform: Database;
  const closers: Array<() => Promise<void>> = [];
  const ids = {} as Record<'co' | 'free' | 'teamA' | 'teamB' | 'alice' | 'bob' | 'carl' | 'tok' | 'userTok', string>;

  beforeAll(async () => {
    const quiet = console.log;
    console.log = () => {};
    try {
      await migrateTo(URL_, '0004_auth_invites_salt_hardening');
    } finally {
      console.log = quiet;
    }
    let c;
    ({ db: owner, close: c } = createDb({ url: URL_, max: 1 }));
    closers.push(c);
    ({ db: web, close: c } = createDb({ url: URL_, role: DB_ROLES.web, max: 1 }));
    closers.push(c);
    ({ db: ingest, close: c } = createDb({ url: URL_, role: DB_ROLES.ingest, max: 1 }));
    closers.push(c);
    ({ db: platform, close: c } = createDb({ url: URL_, role: LEGACY_PLATFORM_ROLE, max: 1 }));
    closers.push(c);

    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      const one = async (q: ReturnType<typeof sql>) => ([...(await tx.execute(q))][0] as { id: string }).id;
      ids.co = await one(sql`insert into companies (name, slug, plan) values ('Big', 'big', 'team') returning id`);
      ids.free = await one(sql`insert into companies (name, slug, plan) values ('Tiny', 'tiny', 'free') returning id`);
      ids.teamA = await one(sql`insert into teams (company_id, name) values (${ids.co}, 'A') returning id`);
      ids.teamB = await one(sql`insert into teams (company_id, name) values (${ids.co}, 'B') returning id`);
      ids.alice = await one(sql`insert into users (company_id, email, name, company_role, primary_team_id)
        values (${ids.co}, 'alice@big.test', 'Alice', 'admin', ${ids.teamA}) returning id`);
      ids.bob = await one(sql`insert into users (company_id, email, name, company_role, primary_team_id)
        values (${ids.co}, 'bob@big.test', 'Bob', 'member', ${ids.teamB}) returning id`);
      ids.carl = await one(sql`insert into users (company_id, email, name, company_role)
        values (${ids.co}, 'carl@big.test', 'Carl', 'member') returning id`);
      await tx.execute(sql`insert into team_memberships (company_id, team_id, user_id, role) values
        (${ids.co}, ${ids.teamA}, ${ids.alice}, 'lead'), (${ids.co}, ${ids.teamB}, ${ids.bob}, 'member'),
        (${ids.co}, ${ids.teamA}, ${ids.carl}, 'member')`);
      ids.tok = await one(sql`insert into ingest_tokens (company_id, team_id, kind, hash, prefix, name)
        values (${ids.co}, ${ids.teamA}, 'team', 'h-team', 'p', 'team') returning id`);
      ids.userTok = await one(sql`insert into ingest_tokens (company_id, team_id, user_id, kind, hash, prefix, name)
        values (${ids.co}, ${ids.teamB}, ${ids.bob}, 'user', 'h-bob', 'p', 'bob') returning id`);
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop database if exists "${DB}" with (force)`).catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
  }, 30_000);

  async function invite(company: string, email: string, createdAt: string, role = 'member'): Promise<string> {
    return owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return ([...(await tx.execute(sql`insert into invitations (company_id, email, company_role, expires_at, created_at)
        values (${company}, ${email}, ${role}::company_role, now() + interval '7 days', ${createdAt}::timestamptz)
        returning id`))][0] as { id: string }).id;
    });
  }

  it('SEC-1: lists pending invitations and accepts exactly the picked one', async () => {
    const real = await invite(ids.co, 'new@x.test', '2026-10-01T10:00:00Z');
    const fake = await invite(ids.free, 'new@x.test', '2026-10-01T10:05:00Z');
    const list = await rows<{ invitation_id: string; company_name: string }>(web, sql`select * from auth_pending_invitations('NEW@x.test ')`);
    expect(list.map((r) => r.company_name)).toEqual(['Tiny', 'Big']);
    // A wrong e-mail or unknown id accepts nothing.
    const none = async (e: string, i: string) => ([...(await web.execute(sql`select auth_accept_invitation(${e}, 'N', ${i}::uuid) as id`))][0] as { id: string | null }).id;
    expect(await none('other@x.test', real)).toBeNull();
    expect(await none('new@x.test', '00000000-0000-0000-0000-000000000000')).toBeNull();
    const id = await none('new@x.test', real);
    expect(id).toBeTruthy();
    const [u] = await asDefiner<{ company_id: string }>(owner, sql`select company_id from users where id = ${id}::uuid`);
    expect(u?.company_id).toBe(ids.co);
    // The attacker's invitation is gone from the list once the user exists, and cannot be accepted.
    expect(await rows(web, sql`select * from auth_pending_invitations('new@x.test')`)).toHaveLength(0);
    expect(await none('new@x.test', fake)).toBeNull();
  });

  it('SEC-1: the two-argument auth_accept_invitation (newest wins) no longer exists', async () => {
    const [r] = await rows<{ n: number }>(owner, sql`select count(*)::int as n from pg_proc where proname = 'auth_accept_invitation'`);
    expect(r!.n).toBe(1);
  });

  it('dod:C2: acceptance and the list refuse a company that is at its plan user limit', async () => {
    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      for (const n of [1, 2, 3]) {
        await tx.execute(sql`insert into users (company_id, email, name, company_role) values (${ids.free}, ${`m${n}@tiny.test`}, 'M', 'member')`);
      }
    });
    const inv = await invite(ids.free, 'late@x.test', '2026-10-02T10:00:00Z');
    expect(await rows(web, sql`select * from auth_pending_invitations('late@x.test')`)).toHaveLength(0);
    const [r] = await rows<{ id: string | null }>(web, sql`select auth_accept_invitation('late@x.test', 'L', ${inv}::uuid) as id`);
    expect(r!.id).toBeNull();
  });

  it('company_has_user_capacity encodes the plan limits of that time (free 3, team 50; business unlimited)', async () => {
    // PLAN_LIMITS left the code with the plans (ADR-0028); the 0004 numbers are pinned here.
    const [r] = await rows<{ def: string }>(owner, sql`select pg_get_functiondef('company_has_user_capacity(uuid)'::regprocedure) as def`);
    expect(r!.def).toContain('< 3');
    expect(r!.def).toContain('< 50');
  });

  it('SEC-4: a user token stops resolving when its user leaves the team it is bound to; kind team is unaffected', async () => {
    const look = async (h: string) => legacyIngestContext(ingest, ids.co, async (tx) => [...(await tx.execute(sql`select * from lookup_ingest_token(${h})`))]);
    expect(await look('h-bob')).toHaveLength(1);
    expect(await look('h-team')).toHaveLength(1);
    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.execute(sql`delete from team_memberships where user_id = ${ids.bob} and team_id = ${ids.teamB}`);
    });
    expect(await look('h-bob')).toHaveLength(0);
    expect(await look('h-team')).toHaveLength(1);
  });

  it('SEC-10: a git e-mail matches only a member of the token team', async () => {
    const match = (email: string, team: string) =>
      legacyIngestContext(ingest, ids.co, async (tx) => [...(await tx.execute(sql`select * from ingest_match_user_by_email(${email}, ${team}::uuid)`))]);
    expect(await match('alice@big.test', ids.teamA)).toHaveLength(1); // primary team + membership
    expect(await match('carl@big.test', ids.teamA)).toHaveLength(1); // membership only
    expect(await match('alice@big.test', ids.teamB)).toHaveLength(0); // other team of the company
    expect(await match('bob@big.test', ids.teamB)).toHaveLength(1); // primary team (membership removed above)
  });

  it('SEC-3: a parked patch is applied only to an ownerless or same-owner turn, otherwise dropped', async () => {
    const turn = async (key: string, user: string | null) =>
      owner.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        const s = ([...(await tx.execute(sql`insert into agent_sessions (company_id, team_id, user_id, external_id, harness, started_at)
          values (${ids.co}, ${ids.teamA}, ${user}::uuid, ${`s-${key}`}, 'claude-code', now()) returning id`))][0] as { id: string }).id;
        return ([...(await tx.execute(sql`insert into turns (company_id, team_id, user_id, attribution, session_id, external_id, harness, started_at, ended_at, outcome)
          values (${ids.co}, ${ids.teamA}, ${user}::uuid, ${user ? 'verified' : 'unverified'}::attribution, ${s}, ${key}, 'claude-code', now(), now(), 'unknown') returning id`))][0] as { id: string }).id;
      });
    const owned = await turn('cc:owned', ids.alice);
    const free = await turn('cc:free', null);
    const park = (key: string, user: string | null) =>
      legacyIngestContext(ingest, ids.co, (tx) => tx.execute(sql`insert into pending_turn_patches (company_id, turn_external_id, summary, user_id)
        values (${ids.co}::uuid, ${key}, 'parked', ${user}::uuid)`));
    await park('cc:owned', ids.carl);
    await park('cc:free', ids.carl);
    const apply = (id: string) =>
      legacyIngestContext(ingest, ids.co, async (tx) => ([...(await tx.execute(sql`select ingest_apply_pending_patch(${id}::uuid) as ok`))][0] as { ok: boolean }).ok);
    expect(await apply(owned)).toBe(false);
    expect(await apply(free)).toBe(true);
    const sums = await asDefiner<{ external_id: string; summary: string | null }>(owner, sql`select external_id, summary from turns where external_id in ('cc:owned', 'cc:free') order by 1`);
    expect(sums.map((s) => s.summary)).toEqual(['parked', null]);
    // The refused patch is gone (dropped, not left parked); a same-owner patch applies.
    const left = await asDefiner<{ n: number }>(owner, sql`select count(*)::int as n from pending_turn_patches`);
    expect(left[0]!.n).toBe(0);
    await park('cc:owned', ids.alice);
    expect(await apply(owned)).toBe(true);
    const [after] = await asDefiner<{ summary: string | null }>(owner, sql`select summary from turns where id = ${owned}::uuid`);
    expect(after!.summary).toBe('parked');
  });

  it('SEC-7: platform_email_in_use sees every user, platform cannot read users directly', async () => {
    const inUse = async (e: string) => ([...(await platform.execute(sql`select platform_email_in_use(${e}) as b`))][0] as { b: boolean }).b;
    expect(await inUse('carl@big.test')).toBe(true);
    expect(await inUse(' CARL@big.test ')).toBe(true);
    expect(await inUse('nobody@big.test')).toBe(false);
    // The platform role cannot read the users of companies (RLS), which is why the function exists.
    const [seen] = await rows<{ n: number }>(platform, sql`select count(*)::int as n from users`);
    const [total] = await asDefiner<{ n: number }>(owner, sql`select count(*)::int as n from users`);
    expect(seen!.n).toBeLessThan(total!.n);
  });

  it('SEC-6: the platform role sees and writes only platform.* audit rows', async () => {
    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.execute(sql`insert into audit_log (company_id, action) values (${ids.co}, 'export'), (${ids.co}, 'platform.plan_change')`);
    });
    const seen = await rows<{ action: string }>(platform, sql`select action from audit_log order by action`);
    expect(seen.every((r) => r.action.startsWith('platform.'))).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    await expect(platform.execute(sql`insert into audit_log (company_id, action) values (${ids.co}, 'export')`)).rejects.toThrow();
    await platform.execute(sql`insert into audit_log (company_id, action) values (${ids.co}, 'platform.note')`);
  });

  it('SEC-11: every company has a distinct 64-char project salt, served only to its own ingest context', async () => {
    const all = await asDefiner<{ project_salt: string }>(owner, sql`select project_salt from companies`);
    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all.map((r) => r.project_salt)).size).toBe(all.length);
    expect(all.every((r) => /^[0-9a-f]{64}$/.test(r.project_salt))).toBe(true);
    const salt = (co: string) => legacyIngestContext(ingest, co, async (tx) => ([...(await tx.execute(sql`select ingest_project_salt() as s`))][0] as { s: string }).s);
    const a = await salt(ids.co);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await salt(ids.free)).not.toBe(a);
    await expect(web.execute(sql`select ingest_project_salt()`)).rejects.toThrow();
  });
});
