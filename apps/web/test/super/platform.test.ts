import { sql } from 'drizzle-orm';
import { createDb, type Database } from '@ai-obs/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  changePlan,
  createCompany,
  getCompanyDetail,
  inviteAdmin,
  listCompanies,
  listPlatformAudit,
  setStatus,
  type PlatformDeps,
} from '../../src/lib/platform/companies';
import type { MailMessage } from '../../src/lib/mail';

/**
 * Super-admin console against real Postgres in its own database (ai_obs_super_test, dropped
 * afterwards): platform actions work through app_platform, are audited, and app_platform cannot
 * read telemetry (ADR-0006).
 */
const testUrl = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test');
testUrl.pathname = '/ai_obs_super_test';
vi.stubEnv('TEST_DATABASE_URL', testUrl.toString());
const harness = await import('../../../../packages/db/test/db-harness');
const skipReason = await harness.prepareTestDatabase();
if (skipReason) console.warn(`[web] super console tests skipped: ${skipReason}`);

type Row = Record<string, unknown>;

describe.skipIf(skipReason !== null)(skipReason ? `super console — SKIPPED: ${skipReason}` : 'super console (real Postgres)', () => {
  let owner: Database;
  let platform: Database;
  let web: Database;
  let deps: PlatformDeps;
  let actor: { id: string };
  let existing: { companyId: string };
  const outbox: MailMessage[] = [];
  let failMail = false;

  const asOwner = async (q: ReturnType<typeof sql>) =>
    owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return (await tx.execute(q)) as unknown as Row[];
    });

  beforeAll(async () => {
    owner = harness.connectOwner();
    platform = harness.connectAs('platform');
    web = harness.connectAs('web');
    deps = {
      db: platform,
      mailer: {
        send: async (m) => {
          if (failMail) throw new Error('smtp down');
          outbox.push(m);
        },
      },
      env: { APP_URL: 'https://obs.example', SUPER_ADMIN_EMAILS: 'root@platform.example' },
    };
    const [su] = await asOwner(sql`insert into users (email, name, is_super_admin) values ('root@platform.example', 'Root', true) returning id`);
    actor = { id: su!.id as string };
    const [c] = await asOwner(sql`insert into companies (name, slug) values ('Existing', 'existing') returning id`);
    const cid = c!.id as string;
    existing = { companyId: cid };
    const [t] = await asOwner(sql`insert into teams (company_id, name) values (${cid}, 'Core') returning id`);
    await asOwner(sql`insert into users (company_id, email, company_role) values (${cid}, 'boss@existing.example', 'admin')`);
    await asOwner(sql`insert into users (company_id, email, company_role, primary_team_id) values (${cid}, 'dev@existing.example', 'member', ${t!.id})`);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness.closeAll();
    const admin = new URL(testUrl);
    admin.pathname = '/postgres';
    const { db, close } = createDb({ url: admin.toString(), max: 1 });
    await db.execute(sql.raw('drop database if exists "ai_obs_super_test" with (force)')).catch(() => {});
    await close();
  });

  it('lists companies with counts and admin contacts only', async () => {
    const rows = await listCompanies(platform);
    const row = rows.find((r) => r.slug === 'existing')!;
    expect(row).toMatchObject({ users: 2, teams: 1, plan: 'free', status: 'active', adminEmails: ['boss@existing.example'] });
    // the platform sees admin contacts, not ordinary members
    expect(await platform.execute(sql`select email from users where email = 'dev@existing.example'`)).toHaveLength(0);
  });

  it('creates a company: row, admin invitation, audit row with the target company, and an e-mail', async () => {
    const r = await createCompany(deps, actor, { name: 'Globex', slug: 'globex', plan: 'team', adminEmail: ' Hank@Globex.Example ' });
    expect(r).toMatchObject({ ok: true });
    const id = (r as { companyId: string }).companyId;

    const detail = await getCompanyDetail(platform, id);
    expect(detail).toMatchObject({ name: 'Globex', slug: 'globex', plan: 'team', status: 'active', users: 0, teams: 0 });
    expect(detail!.invitations).toHaveLength(1);
    expect(detail!.invitations[0]).toMatchObject({ email: 'hank@globex.example', acceptedAt: null });
    expect(detail!.invitations[0]!.expiresAt).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    const audit = await listPlatformAudit(platform, { companyId: id });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'platform.company_created', companyId: id, actorEmail: 'root@platform.example', target: 'globex' });

    const mail = outbox.at(-1)!;
    expect(mail.to).toBe('hank@globex.example');
    expect(mail.text).toContain('https://obs.example/login');

    // the user picks the invitation on /signup (explicit consent, SEC-1): they become the company admin
    const [pending] = (await web.execute(sql`select invitation_id from auth_pending_invitations('hank@globex.example')`)) as unknown as Array<{ invitation_id: string }>;
    const [accepted] = (await web.execute(
      sql`select auth_accept_invitation('hank@globex.example', 'Hank', ${pending!.invitation_id}::uuid) as id`,
    )) as unknown as Row[];
    expect(accepted!.id).toBeTruthy();
    const after = await getCompanyDetail(platform, id);
    expect(after!.adminEmails).toEqual(['hank@globex.example']);
    expect(after!.users).toBe(1);
  });

  it('rejects bad input, duplicate slugs, taken and super-admin e-mails (nothing is written)', async () => {
    const before = (await listCompanies(platform)).length;
    const base = { name: 'Initech', slug: 'initech', plan: 'free', adminEmail: 'milton@initech.example' };
    expect(await createCompany(deps, actor, { ...base, name: '' })).toMatchObject({ ok: false });
    expect(await createCompany(deps, actor, { ...base, plan: 'enterprise' })).toMatchObject({ ok: false });
    expect(await createCompany(deps, actor, { ...base, adminEmail: 'nope' })).toMatchObject({ ok: false });
    expect(await createCompany(deps, actor, { ...base, slug: 'existing' })).toMatchObject({ ok: false, error: expect.stringContaining('already taken') });
    expect(await createCompany(deps, actor, { ...base, adminEmail: 'boss@existing.example' })).toMatchObject({ ok: false, error: expect.stringContaining('already belongs') });
    expect(await createCompany(deps, actor, { ...base, adminEmail: 'root@platform.example' })).toMatchObject({ ok: false, error: expect.stringContaining('SUPER_ADMIN_EMAILS') });
    expect((await listCompanies(platform)).length).toBe(before);
  });

  it('derives the slug from the name when empty, and keeps the company when the e-mail fails', async () => {
    failMail = true;
    const r = await createCompany(deps, actor, { name: 'Hooli Inc', slug: '', plan: 'free', adminEmail: 'gavin@hooli.example' });
    failMail = false;
    expect(r).toMatchObject({ ok: true, warning: expect.stringContaining('could not be sent') });
    const row = (await listCompanies(platform)).find((c) => c.slug === 'hooli-inc');
    expect(row).toBeTruthy();
    // re-sending creates a new invitation and a second audit row
    const again = await inviteAdmin(deps, actor, row!.id, 'gavin@hooli.example');
    expect(again).toMatchObject({ ok: true });
    expect((await getCompanyDetail(platform, row!.id))!.invitations).toHaveLength(2);
    expect((await listPlatformAudit(platform, { companyId: row!.id })).map((a) => a.action)).toContain('platform.admin_invited');
  });

  it('changes the plan and audits from/to', async () => {
    expect(await changePlan(deps, actor, existing.companyId, 'business')).toMatchObject({ ok: true });
    expect((await getCompanyDetail(platform, existing.companyId))!.plan).toBe('business');
    expect(await changePlan(deps, actor, existing.companyId, 'business')).toMatchObject({ ok: false });
    expect(await changePlan(deps, actor, existing.companyId, 'gold')).toMatchObject({ ok: false });
    const [a] = await listPlatformAudit(platform, { companyId: existing.companyId });
    expect(a).toMatchObject({ action: 'platform.plan_changed', meta: { from: 'free', to: 'business' } });
  });

  it('warns (but still downgrades) when the new plan is below current usage (dod:C2)', async () => {
    await asOwner(sql`insert into users (company_id, email, name, company_role) values
      (${existing.companyId}, 'o1@existing.example', 'O1', 'member'), (${existing.companyId}, 'o2@existing.example', 'O2', 'member'),
      (${existing.companyId}, 'o3@existing.example', 'O3', 'member'), (${existing.companyId}, 'o4@existing.example', 'O4', 'member')`);
    const res = await changePlan(deps, actor, existing.companyId, 'free');
    expect(res).toMatchObject({ ok: true, warning: expect.stringMatching(/users .*exceed the free limit of 3.*kept/) });
    expect((await getCompanyDetail(platform, existing.companyId))!.plan).toBe('free');
    // No overage, no warning.
    const up = await changePlan(deps, actor, existing.companyId, 'business');
    expect(up).toMatchObject({ ok: true });
    expect((up as { warning?: string }).warning).toBeUndefined();
  });

  it('suspends and reactivates with an audit trail (and the DB shows the new status)', async () => {
    expect(await setStatus(deps, actor, existing.companyId, 'suspended', 'unpaid invoice')).toMatchObject({ ok: true });
    const [c] = await asOwner(sql`select status from companies where id = ${existing.companyId}`);
    expect(c!.status).toBe('suspended');
    expect(await setStatus(deps, actor, existing.companyId, 'suspended')).toMatchObject({ ok: false });
    expect(await setStatus(deps, actor, existing.companyId, 'active')).toMatchObject({ ok: true });
    const actions = (await listPlatformAudit(platform, { companyId: existing.companyId })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.company_suspended', 'platform.company_unsuspended', 'platform.plan_changed']));
    const susp = (await listPlatformAudit(platform, { companyId: existing.companyId })).find((a) => a.action === 'platform.company_suspended')!;
    expect(susp.meta).toMatchObject({ reason: 'unpaid invoice', from: 'active', to: 'suspended' });
  });

  it('unknown companies are reported, not created', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect(await changePlan(deps, actor, ghost, 'team')).toMatchObject({ ok: false });
    expect(await setStatus(deps, actor, ghost, 'suspended')).toMatchObject({ ok: false });
    expect(await inviteAdmin(deps, actor, ghost, 'x@y.example')).toMatchObject({ ok: false });
    expect(await getCompanyDetail(platform, ghost)).toBeNull();
  });

  it('the platform connection cannot read telemetry or tokens (permission denied)', async () => {
    for (const table of ['turns', 'runs', 'usage', 'agent_sessions', 'daily_rollups', 'projects', 'machines', 'ingest_tokens', 'teams', 'team_memberships', 'budgets']) {
      const code = await harness.pgErrorCode(platform.execute(sql.raw(`select * from ${table} limit 1`)));
      expect(code, table).toBe('42501');
    }
    expect(await harness.pgErrorCode(platform.execute(sql`select count(*) from turns`))).toBe('42501');
    // and it cannot write telemetry either
    expect(await harness.pgErrorCode(platform.execute(sql`delete from turns`))).toBe('42501');
  });

  // SEC-7 platform_email_in_use() and the SEC-6 narrowed audit_log policy come from migration 0004.
  it('refuses to invite an existing non-admin member (invisible to app_platform) as an admin', async () => {
    // the RLS-filtered view really does hide the member
    const visible = (await platform.execute(sql`select email from users where lower(email) = 'dev@existing.example'`)) as unknown as Row[];
    expect(visible).toHaveLength(0);
    const before = (await listCompanies(platform)).length;
    const r = await createCompany(deps, actor, { name: 'Umbrella', slug: 'umbrella', plan: 'free', adminEmail: 'Dev@Existing.example' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('already belongs') });
    expect((await listCompanies(platform)).length).toBe(before);

    const sent = outbox.length;
    expect(await inviteAdmin(deps, actor, existing.companyId, 'dev@existing.example')).toMatchObject({ ok: false, error: expect.stringContaining('already belongs') });
    const [other] = await listCompanies(platform).then((l) => l.filter((c) => c.id !== existing.companyId));
    expect(await inviteAdmin(deps, actor, other!.id, 'dev@existing.example')).toMatchObject({ ok: false });
    expect(outbox.length).toBe(sent);
    // an admin of the same company still gets the precise message
    expect(await inviteAdmin(deps, actor, existing.companyId, 'boss@existing.example')).toMatchObject({ ok: false, error: expect.stringContaining('already an admin') });
  });

  it('platform_email_in_use answers only a boolean, for members, admins and unknown addresses', async () => {
    const one = async (e: string) => ((await platform.execute(sql`select platform_email_in_use(${e}::text) as v`)) as unknown as Row[])[0]!.v;
    expect(await one('dev@existing.example')).toBe(true);
    expect(await one(' BOSS@existing.example ')).toBe(true);
    expect(await one('nobody@nowhere.example')).toBe(false);
  });

  it('app_platform sees only platform.% and company-less audit rows (not a company\'s own audit trail)', async () => {
    await asOwner(sql`insert into audit_log (company_id, action, target, meta) values (${existing.companyId}, 'export', 'turns', '{"email":"x@existing.example"}')`);
    await asOwner(sql`insert into audit_log (company_id, action, target) values (${existing.companyId}, 'auth.login', 'dev@existing.example')`);
    const rows = (await platform.execute(sql`select action from audit_log`)) as unknown as Row[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => String(r.action).startsWith('platform.'))).toBe(true);
    // and it cannot write a non-platform audit row either
    expect(
      await harness.pgErrorCode(platform.execute(sql`insert into audit_log (company_id, action, target) values (${existing.companyId}, 'export', 'x')`)),
    ).toBe('42501');
  });
});
