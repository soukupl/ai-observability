import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { DB_ROLES } from '../src/connections.js';
import { runMigrations } from '../src/migrate.js';
import { withRlsContext } from '../src/rls.js';
import { pgErrorCode } from './db-harness.js';
import { asDefiner, createDeployment, type DeploymentFixture, type Person } from './fixtures.js';
import { adminDbUrl, testDbName, testDbUrl } from './test-db.js';

/**
 * Device login (ADR-0029, brief Appendix B) and login provisioning (brief Q8) at the database level: the SECURITY
 * DEFINER functions the public device routes, the /device page and the auth flow call. Own database.
 */
const DB = testDbName('device');
const URL_ = testDbUrl('device');
const adminUrl = adminDbUrl();

async function prepare(): Promise<string | null> {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 3, onnotice: () => {} });
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

describe.skipIf(skip !== null)(skip ? `device login - SKIPPED: ${skip}` : 'device login and provisioning (real Postgres)', () => {
  const closers: Array<() => Promise<void>> = [];
  let owner: Database, web: Database, ingest: Database, worker: Database;
  let D: DeploymentFixture;

  beforeAll(async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await runMigrations(URL_);
    } finally {
      console.log = log;
    }
    const conns = [createDb({ url: URL_, max: 1 }), createDb({ url: URL_, role: DB_ROLES.web, max: 2 }),
      createDb({ url: URL_, role: DB_ROLES.ingest, max: 1 }), createDb({ url: URL_, role: DB_ROLES.worker, max: 1 })];
    [owner, web, ingest, worker] = conns.map((c) => c.db) as [Database, Database, Database, Database];
    closers.push(...conns.map((c) => c.close));
    D = await createDeployment(owner, 'dev', 'aggregates-only', ['t1'], [
      { key: 'admin', role: 'admin', teams: [['t1', 'lead']] },
      { key: 'm1', teams: [['t1', 'member']] },
    ]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
    const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop database if exists "${DB}" with (force)`).catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
  });

  const q = async (db: Database, query: ReturnType<typeof sql>) => [...(await db.execute(query))] as Record<string, unknown>[];
  const as = (p: Person, query: ReturnType<typeof sql>) =>
    withRlsContext(web, { userId: p.id, role: p.role }, async (tx) => [...(await tx.execute(query))] as Record<string, unknown>[]);
  const create = (db: Database, hash: string, code: string, opts: { ttl?: number; max?: number } = {}) =>
    q(db, sql`select * from device_create_code(${hash}, ${code}, 'mac-dev', '0.5.0', '203.0.113.7', ${opts.ttl ?? 600}, ${opts.max ?? 100})`);
  const exchange = (db: Database, hash: string, tokenHash: string, interval = 5) =>
    q(db, sql`select * from device_exchange(${hash}, ${tokenHash}, 'aiobs_u_Dv1x', ${interval})`).then((r) => r[0]!);

  it('end to end: code → lookup → approve → pending / slow_down → token for the approver, exchanged once', async () => {
    const [c] = await create(web, 'dc-1', 'ABCD-EFGH');
    expect(c).toMatchObject({ user_code: 'ABCDEFGH' });
    expect(new Date(c!.expires_at as string).getTime() - Date.now()).toBeGreaterThan(590_000);
    expect(await exchange(web, 'dc-1', 'tok-1')).toMatchObject({ status: 'authorization_pending', token_id: null });
    expect(await exchange(web, 'dc-1', 'tok-1')).toMatchObject({ status: 'slow_down' });
    // The signed-in person types the code (dash optional) and sees client, IP and age.
    const seen = await as(D.people.m1!, sql`select client_name, client_version, requester_ip from device_lookup('abcdefgh')`);
    expect(seen).toEqual([{ client_name: 'mac-dev', client_version: '0.5.0', requester_ip: '203.0.113.7' }]);
    expect(await q(web, sql`select * from device_lookup('ABCD-EFGH')`)).toEqual([]); // no context, nothing
    const approved = await as(D.people.m1!, sql`select client_name from device_approve('ABCD-EFGH')`);
    expect(approved).toEqual([{ client_name: 'mac-dev' }]);
    expect(await as(D.people.m1!, sql`select * from device_lookup('ABCD-EFGH')`)).toEqual([]); // no longer open
    // Approved: the next poll mints the token, also right after a poll (no slow_down once approved).
    const ok = await exchange(ingest, 'dc-1', 'tok-1');
    expect(ok).toMatchObject({ status: 'ok', user_id: D.people.m1!.id, label: 'mac-dev' });
    const days = (new Date(ok.expires_at as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    const [tok] = await asDefiner(owner, async (tx) => [...(await tx.execute(sql`select user_id, name, source, label, prefix,
      created_by_user_id from ingest_tokens where id = ${ok.token_id as string}::uuid`))]);
    expect(tok).toEqual({ user_id: D.people.m1!.id, name: 'mac-dev', source: 'device', label: 'mac-dev', prefix: 'aiobs_u_Dv1x',
      created_by_user_id: D.people.m1!.id });
    const [lookup] = await q(ingest, sql`select user_id, token_source, token_label from lookup_ingest_token('tok-1')`);
    expect(lookup).toEqual({ user_id: D.people.m1!.id, token_source: 'device', token_label: 'mac-dev' });
    // Audited, and exchanged at most once.
    const audit = await asDefiner(owner, async (tx) => [...(await tx.execute(sql`select actor_user_id, action, target, meta->>'source' as source
      from audit_log where action = 'token.create'`))]);
    expect(audit).toEqual([{ actor_user_id: D.people.m1!.id, action: 'token.create', target: ok.token_id, source: 'device' }]);
    expect(await exchange(web, 'dc-1', 'tok-1b')).toMatchObject({ status: 'invalid_grant', token_id: null });
    expect(await exchange(web, 'dc-unknown', 'tok-x')).toMatchObject({ status: 'invalid_grant' });
  });

  it('deny, expiry and the user-code uniqueness among open codes', async () => {
    await create(web, 'dc-2', 'JKLMNPQR');
    expect(await as(D.people.admin!, sql`select device_deny('JKLM-NPQR') as ok`)).toEqual([{ ok: true }]);
    expect(await exchange(web, 'dc-2', 'tok-2')).toMatchObject({ status: 'access_denied' });
    // A denied code frees its user code; an open one does not (23505, the route draws another).
    await create(web, 'dc-3', 'JKLMNPQR');
    expect(await pgErrorCode(create(web, 'dc-4', 'JKLMNPQR'))).toBe('23505');
    // Expired codes answer expired_token and cannot be approved.
    await create(web, 'dc-5', 'STUVWXYZ', { ttl: 0 });
    expect(await as(D.people.m1!, sql`select * from device_approve('STUVWXYZ')`)).toEqual([]);
    expect(await exchange(web, 'dc-5', 'tok-5')).toMatchObject({ status: 'expired_token' });
    // A code with less than 30 s left is no longer shown or approvable: the CLI could not exchange it in time.
    await create(web, 'dc-5b', 'TUVWXYZA', { ttl: 20 });
    expect(await as(D.people.m1!, sql`select * from device_lookup('TUVWXYZA')`)).toEqual([]);
    expect(await as(D.people.m1!, sql`select * from device_approve('TUVWXYZA')`)).toEqual([]);
    expect(await exchange(web, 'dc-5b', 'tok-5b')).toMatchObject({ status: 'authorization_pending' });
    expect(await pgErrorCode(create(web, 'dc-6', 'abc'))).toBe('23514'); // not 8 letters of the alphabet
    expect(await pgErrorCode(create(web, 'dc-7', 'ABCDEFGI'))).toBe('23514'); // I is not in the alphabet
  });

  it('caps open codes server-wide (no row → 429); expired codes do not count', async () => {
    const open = Number((await asDefiner(owner, async (tx) => [...(await tx.execute(sql`select count(*)::int as n from device_codes
      where status in ('pending', 'approved') and expires_at > now()`))]))[0]!.n);
    expect(await create(web, 'dc-cap', 'CAPCAPCA', { max: open })).toEqual([]);
    expect(await create(web, 'dc-cap', 'CAPCAPCA', { max: open + 1 })).toHaveLength(1);
  });

  it('only a person with a membership approves; the approver losing the membership voids the code', async () => {
    const [svc] = await as(D.people.admin!, sql`select admin_create_service_user('bot') as id`);
    await create(web, 'dc-8', 'BBBBCCCC');
    const svcPerson = { id: svc!.id as string, role: 'member' as const };
    expect(await pgErrorCode(as(svcPerson, sql`select * from device_approve('BBBBCCCC')`))).toBe('42501');
    expect(await pgErrorCode(q(web, sql`select * from device_approve('BBBBCCCC')`))).toBe('42501');
    // m2 approves, then is removed before the CLI polls: no token.
    const [u] = await asDefiner(owner, async (tx) => [...(await tx.execute(sql`with u as (insert into users (email, name)
      values ('m2@dev.test', 'm2') returning id) insert into memberships (user_id) select id from u returning user_id as id`))]);
    const m2 = { id: u!.id as string, role: 'member' as const };
    expect(await as(m2, sql`select client_name from device_approve('BBBBCCCC')`)).toEqual([{ client_name: 'mac-dev' }]);
    await as(D.people.admin!, sql`select * from admin_remove_member(${m2.id}::uuid)`);
    expect(await exchange(web, 'dc-8', 'tok-8')).toMatchObject({ status: 'access_denied' });
  });

  it('device_codes is reachable only through the functions (web / ingest); the worker may prune it', async () => {
    expect(await pgErrorCode(q(web, sql`select * from device_codes`))).toBe('42501');
    expect(await pgErrorCode(q(ingest, sql`select * from device_codes`))).toBe('42501');
    expect(await pgErrorCode(q(ingest, sql`select * from device_approve('ABCDEFGH')`))).toBe('42501');
    const pruned = await worker.execute(sql`delete from device_codes where status in ('consumed', 'denied', 'expired')`);
    expect(pruned.count).toBeGreaterThan(0);
  });

  describe('login provisioning', () => {
    it('auth_provision_member: creates a person with the role once; an existing membership is never changed', async () => {
      const [a] = await q(web, sql`select * from auth_provision_member(' Boss@Example.COM ', 'Boss', 'admin')`);
      expect(a).toMatchObject({ created: true });
      const [again] = await q(web, sql`select * from auth_provision_member('boss@example.com', 'Boss', 'member')`);
      expect(again).toEqual({ user_id: a!.user_id, created: false });
      expect(await q(web, sql`select email, kind, role, primary_team_id from auth_find_user_by_email('BOSS@example.com')`)).toEqual([
        { email: 'boss@example.com', kind: 'person', role: 'admin', primary_team_id: null },
      ]);
      expect(await q(web, sql`select role from auth_get_user(${a!.user_id as string}::uuid)`)).toEqual([{ role: 'admin' }]);
    });

    it('invitations: pending list, accept creates the member with role and team; an existing member just joins the team', async () => {
      await asDefiner(owner, (tx) => tx.execute(sql`insert into invitations (email, team_id, team_role, role, invited_by_user_id, expires_at) values
        ('new@dev.test', ${D.teams.t1}, 'lead', 'member', ${D.people.admin!.id}, now() + interval '7 days'),
        ('m1@dev.test', ${D.teams.t1}, 'member', 'admin', ${D.people.admin!.id}, now() + interval '7 days'),
        ('late@dev.test', null, 'member', 'member', null, now() - interval '1 day')`));
      const pending = await q(web, sql`select invitation_id, team_name, role, team_role, invited_by_name from auth_pending_invitations('NEW@dev.test')`);
      expect(pending).toEqual([{ invitation_id: expect.any(String), team_name: 'dev-t1', role: 'member', team_role: 'lead', invited_by_name: 'admin' }]);
      expect(await q(web, sql`select * from auth_pending_invitations('late@dev.test')`)).toEqual([]);
      const [acc] = await q(web, sql`select * from auth_accept_invitation('new@dev.test', 'Newbie', ${pending[0]!.invitation_id as string}::uuid)`);
      const newUser = acc!.user_id as string;
      expect(await q(web, sql`select email, role, primary_team_id from auth_get_user(${newUser}::uuid)`)).toEqual([
        { email: 'new@dev.test', role: 'member', primary_team_id: D.teams.t1 },
      ]);
      expect(await q(ingest, sql`select slug, role from ingest_user_teams(${newUser}::uuid)`)).toEqual([{ slug: 'dev-t1', role: 'lead' }]);
      // Accepted once only.
      expect(await q(web, sql`select * from auth_accept_invitation('new@dev.test', 'Newbie', ${pending[0]!.invitation_id as string}::uuid)`)).toEqual([]);
      // m1 is already a member: the invitation does not promote them to admin.
      const [inv] = await q(web, sql`select invitation_id from auth_pending_invitations('m1@dev.test')`);
      expect(await q(web, sql`select * from auth_accept_invitation('m1@dev.test', null, ${inv!.invitation_id as string}::uuid)`)).toEqual([
        { user_id: D.people.m1!.id },
      ]);
      expect(await q(web, sql`select role from auth_get_user(${D.people.m1!.id}::uuid)`)).toEqual([{ role: 'member' }]);
    });

    it('an ADMIN_EMAILS admin who was also invited gets the invited team as primary team (provision, then accept)', async () => {
      await asDefiner(owner, (tx) => tx.execute(sql`insert into invitations (email, team_id, team_role, role, invited_by_user_id, expires_at)
        values ('founder@dev.test', ${D.teams.t1}, 'lead', 'member', ${D.people.admin!.id}, now() + interval '7 days')`));
      const [p] = await q(web, sql`select * from auth_provision_member('founder@dev.test', 'Founder', 'admin')`);
      expect(p).toMatchObject({ created: true });
      const [inv] = await q(web, sql`select invitation_id from auth_pending_invitations('founder@dev.test')`);
      await q(web, sql`select * from auth_accept_invitation('founder@dev.test', 'Founder', ${inv!.invitation_id as string}::uuid)`);
      expect(await q(web, sql`select role, primary_team_id from auth_get_user(${p!.user_id as string}::uuid)`)).toEqual([
        { role: 'admin', primary_team_id: D.teams.t1 },
      ]);
    });
  });
});
