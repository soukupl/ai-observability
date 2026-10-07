import { sql } from 'drizzle-orm';
import { createDb, withRlsContext, type Database, type Tx } from '@ai-obs/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listAuditLog } from '../../src/lib/admin/audit';
import { createBudget, deleteBudget, updateBudget } from '../../src/lib/admin/budgets';
import { updateSettings } from '../../src/lib/admin/company';
import { createInvitation, invitationEmail, revokeInvitation } from '../../src/lib/admin/invitations';
import { changeCompanyRole, removeUser } from '../../src/lib/admin/members';
import { listAdminProjects, setProjectName, setProjectTeam } from '../../src/lib/admin/projects';
import { addMember, createTeam, deleteTeam, removeMember, renameTeam, setMemberRole } from '../../src/lib/admin/teams';
import { createToken, listTokens, revokeToken } from '../../src/lib/admin/tokens';
import { AdminError, type Actor } from '../../src/lib/admin/types';
import { hashToken } from '../../src/lib/ingest/tokens';
import type { MailMessage } from '../../src/lib/mail';

/**
 * Admin console against real Postgres in its own database (ai_obs_admin_test, dropped afterwards).
 * Every operation runs as app_web inside the actor's RLS context, exactly like withUserDb().
 */
const testUrl = new URL(process.env.ADMIN_TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_admin_test');
vi.stubEnv('TEST_DATABASE_URL', testUrl.toString());
const harness = await import('../../../../packages/db/test/db-harness');
const skipReason = await harness.prepareTestDatabase();
if (skipReason) console.warn(`[web/admin] integration tests skipped: ${skipReason}`);

const ENDPOINT = 'https://obs.example';

interface Co {
  id: string;
  teams: Record<string, string>;
  people: Record<string, Actor>;
  projectId: string;
}

describe.skipIf(skipReason !== null)(skipReason ? `admin console — SKIPPED: ${skipReason}` : 'admin console (real Postgres)', () => {
  let owner: Database;
  let web: Database;
  let acme: Co;
  let solo: Co;

  const asOwner = <T>(fn: (tx: Tx) => Promise<T>) =>
    owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return fn(tx);
    });
  const as = <T>(a: Actor, fn: (tx: Tx) => Promise<T>) => withRlsContext(web, { companyId: a.companyId, userId: a.id, role: a.companyRole }, fn);
  const q = async <T>(tx: Tx, s: ReturnType<typeof sql>) => Array.from((await tx.execute(s)) as unknown as T[]);
  const auditActions = (c: Co) => asOwner((tx) => q<{ action: string; target: string | null; meta: Record<string, unknown> }>(tx, sql`select action, target, meta from audit_log where company_id = ${c.id} order by at, id`));

  async function seed(name: string, plan: 'free' | 'team', people: [string, 'admin' | 'member', string, 'member' | 'lead'][], teamNames: string[]): Promise<Co> {
    return asOwner(async (tx) => {
      const [c] = await q<{ id: string }>(tx, sql`insert into companies (name, slug, plan) values (${name}, ${name.toLowerCase()}, ${plan}) returning id`);
      const co: Co = { id: c!.id, teams: {}, people: {}, projectId: '' };
      for (const t of teamNames) co.teams[t] = (await q<{ id: string }>(tx, sql`insert into teams (company_id, name) values (${co.id}, ${t}) returning id`))[0]!.id;
      for (const [key, role, team, teamRole] of people) {
        const [u] = await q<{ id: string }>(
          tx,
          sql`insert into users (company_id, email, name, company_role, primary_team_id) values (${co.id}, ${`${key}@${name.toLowerCase()}.test`}, ${key}, ${role}, ${co.teams[team]}) returning id`,
        );
        await tx.execute(sql`insert into team_memberships (company_id, team_id, user_id, role) values (${co.id}, ${co.teams[team]}, ${u!.id}, ${teamRole})`);
        co.people[key] = { id: u!.id, companyId: co.id, companyRole: role, teams: [{ id: co.teams[team]!, role: teamRole }] };
      }
      co.projectId = (await q<{ id: string }>(tx, sql`insert into projects (company_id, key) values (${co.id}, 'github.com/acme/billing') returning id`))[0]!.id;
      return co;
    });
  }

  beforeAll(async () => {
    owner = harness.connectOwner();
    web = harness.connectAs('web');
    acme = await seed('Acme', 'team', [
      ['admin', 'admin', 'Platform', 'member'],
      ['lead', 'member', 'Platform', 'lead'],
      ['m1', 'member', 'Platform', 'member'],
      ['m2', 'member', 'Mobile', 'member'],
    ], ['Platform', 'Mobile']);
    solo = await seed('Solo', 'free', [['owner', 'admin', 'Solo', 'lead']], ['Solo']);
    // m1 has one turn (with usage) on the project and a daily rollup row.
    await asOwner(async (tx) => {
      const m1 = acme.people.m1!.id;
      const startedMs = new Date(Date.now() - 2 * 86_400_000);
      const started = startedMs.toISOString();
      const [t] = await q<{ id: string }>(
        tx,
        sql`insert into turns (company_id, team_id, user_id, attribution, project_id, external_id, harness, model, started_at, ended_at, input_tokens, outcome)
            values (${acme.id}, ${acme.teams.Platform}, ${m1}, 'verified', ${acme.projectId}, 'turn-1', 'claude-code', 'claude-opus-5-5', ${started}, ${started}, 100, 'success') returning id`,
      );
      await tx.execute(sql`insert into usage (company_id, team_id, user_id, turn_id, started_at, model, input_tokens)
        values (${acme.id}, ${acme.teams.Platform}, ${m1}, ${t!.id}, ${started}, 'claude-opus-5-5', 100)`);
      await tx.execute(sql`insert into daily_rollups (company_id, day, team_id, user_id, project_id, harness, model, turns, input_tokens)
        values (${acme.id}, ${started.slice(0, 10)}, ${acme.teams.Platform}, ${m1}, ${acme.projectId}, 'claude-code', 'claude-opus-5-5', 1, 100)`);
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness.closeAll();
    const admin = new URL(testUrl);
    admin.pathname = '/postgres';
    const { db, close } = createDb({ url: admin.toString(), max: 1 });
    await db.execute(sql.raw(`drop database if exists "${testUrl.pathname.slice(1)}" with (force)`)).catch(() => {});
    await close();
  });

  const expectAdminError = async (p: Promise<unknown>, re: RegExp) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AdminError);
    expect((err as Error).message).toMatch(re);
  };

  describe('teams', () => {
    it('create, rename, membership, lead toggle, delete only when empty → audit rows', async () => {
      const a = acme.people.admin!;
      expect(await as(a, (tx) => createTeam(tx, a, { name: 'Data' }))).toMatch(/created/);
      const [data] = await asOwner((tx) => q<{ id: string }>(tx, sql`select id from teams where company_id = ${acme.id} and name = 'Data'`));
      await as(a, (tx) => renameTeam(tx, a, { teamId: data!.id, name: 'Data Eng' }));
      await as(a, (tx) => addMember(tx, a, { teamId: data!.id, userId: acme.people.m2!.id, role: 'member' }));
      await as(a, (tx) => setMemberRole(tx, a, { teamId: data!.id, userId: acme.people.m2!.id, role: 'lead' }));
      await expectAdminError(as(a, (tx) => deleteTeam(tx, a, { teamId: data!.id })), /empty team/);
      await as(a, (tx) => removeMember(tx, a, { teamId: data!.id, userId: acme.people.m2!.id }));
      expect(await as(a, (tx) => deleteTeam(tx, a, { teamId: data!.id }))).toMatch(/deleted/);
      const actions = (await auditActions(acme)).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['team.create', 'team.rename', 'team.member_add', 'team.member_role', 'team.member_remove', 'team.delete']));
    });

    it('removing a member revokes their user tokens for that team only (SEC-4), audited', async () => {
      const a = acme.people.admin!;
      const m2 = acme.people.m2!;
      await as(a, (tx) => addMember(tx, a, { teamId: acme.teams.Platform, userId: m2.id, role: 'member' }));
      const mk = (team: string) =>
        asOwner(async (tx) => {
          const [r] = await q<{ id: string }>(
            tx,
            sql`insert into ingest_tokens (company_id, team_id, user_id, kind, name, prefix, hash, created_by_user_id)
                values (${acme.id}, ${team}, ${m2.id}, 'user', 'laptop', 'aiobs_u_x', ${`h-${team}-${Math.random()}`}, ${m2.id}) returning id`,
          );
          return r!.id;
        });
      const onPlatform = await mk(acme.teams.Platform);
      const onMobile = await mk(acme.teams.Mobile);
      const teamTok = await asOwner(async (tx) => {
        const [r] = await q<{ id: string }>(
          tx,
          sql`insert into ingest_tokens (company_id, team_id, kind, name, prefix, hash, created_by_user_id)
              values (${acme.id}, ${acme.teams.Platform}, 'team', 'fleet', 'aiobs_t_x', ${`h-team-${Math.random()}`}, ${a.id}) returning id`,
        );
        return r!.id;
      });
      const msg = await as(a, (tx) => removeMember(tx, a, { teamId: acme.teams.Platform, userId: m2.id }));
      expect(msg).toMatch(/user token for this team was revoked/);
      const state = await asOwner((tx) =>
        q<{ id: string; revoked_at: Date | null }>(tx, sql`select id, revoked_at from ingest_tokens where id in (${onPlatform}, ${onMobile}, ${teamTok})`),
      );
      const revoked = (id: string) => state.find((r) => r.id === id)!.revoked_at !== null;
      expect(revoked(onPlatform)).toBe(true);
      expect(revoked(onMobile)).toBe(false);
      expect(revoked(teamTok)).toBe(false);
      const log = (await auditActions(acme)).filter((r) => r.action === 'token.revoke' && r.target === `token:${onPlatform}`);
      expect(log).toHaveLength(1);
      expect(log[0]!.meta).toMatchObject({ reason: 'member removed from team', userId: m2.id });
    });

    it('a team with recorded turns cannot be deleted even when empty', async () => {
      const a = acme.people.admin!;
      // Move m1's turn's team to a fresh, member-less team.
      const t = await asOwner(async (tx) => {
        const [x] = await q<{ id: string }>(tx, sql`insert into teams (company_id, name) values (${acme.id}, 'Legacy') returning id`);
        await tx.execute(sql`update turns set team_id = ${x!.id} where company_id = ${acme.id}`);
        return x!.id;
      });
      await expectAdminError(as(a, (tx) => deleteTeam(tx, a, { teamId: t })), /recorded turns/);
      await asOwner((tx) => tx.execute(sql`update turns set team_id = ${acme.teams.Platform} where company_id = ${acme.id}`));
    });

    it('the plan team limit is enforced (Free: 1 team)', async () => {
      const o = solo.people.owner!;
      await expectAdminError(as(o, (tx) => createTeam(tx, o, { name: 'Second' })), /free plan allows 1 teams/);
    });
  });

  describe('invitations', () => {
    it('create (7-day expiry) → e-mail → replace → revoke, all audited', async () => {
      const a = acme.people.admin!;
      const now = new Date();
      const inv = await as(a, (tx) => createInvitation(tx, a, { email: 'New@Acme.test', teamId: acme.teams.Mobile, teamRole: 'lead', companyRole: 'member' }, now));
      expect(inv.email).toBe('new@acme.test');
      expect(inv.expiresAt.getTime() - now.getTime()).toBe(7 * 86_400_000);
      const outbox: MailMessage[] = [];
      await { send: async (m: MailMessage) => void outbox.push(m) }.send(invitationEmail(inv, { appUrl: ENDPOINT, inviter: 'admin' }));
      expect(outbox[0]!.to).toBe('new@acme.test');
      expect(outbox[0]!.text).toContain(`${ENDPOINT}/login`);
      // A second invitation for the same address replaces the first.
      const again = await as(a, (tx) => createInvitation(tx, a, { email: 'new@acme.test', teamId: '' }));
      const pending = await asOwner((tx) => q<{ id: string }>(tx, sql`select id from invitations where company_id = ${acme.id} and accepted_at is null`));
      expect(pending.map((p) => p.id)).toEqual([again.id]);
      await expectAdminError(as(a, (tx) => createInvitation(tx, a, { email: 'm1@acme.test' })), /already a member/);
      expect(await as(a, (tx) => revokeInvitation(tx, a, { invitationId: again.id }))).toMatch(/revoked/);
      const rows = (await auditActions(acme)).filter((r) => r.action.startsWith('invitation.'));
      expect(rows.map((r) => r.action)).toEqual(['invitation.create', 'invitation.create', 'invitation.revoke']);
    });

    it('the plan user limit counts members + pending invitations (Free: 3)', async () => {
      const o = solo.people.owner!;
      await as(o, (tx) => createInvitation(tx, o, { email: 'a@solo.test' }));
      await as(o, (tx) => createInvitation(tx, o, { email: 'b@solo.test' }));
      await expectAdminError(as(o, (tx) => createInvitation(tx, o, { email: 'c@solo.test' })), /free plan allows 3 users/);
    });
  });

  describe('tokens', () => {
    it('create + revoke: hash stored, plaintext shown once, audited without the secret', async () => {
      const a = acme.people.admin!;
      const tok = await as(a, (tx) => createToken(tx, a, { kind: 'team', teamId: acme.teams.Mobile, name: 'Fleet' }, ENDPOINT));
      expect(tok.plaintext).toMatch(/^aiobs_t_/);
      expect(tok.command).toBe(`npx ai-obs init --token ${tok.plaintext} --endpoint ${ENDPOINT}`);
      expect(JSON.parse(tok.mdmJson!)).toMatchObject({ endpoint: ENDPOINT, token: tok.plaintext, team: 'Mobile' });
      const [stored] = await asOwner((tx) => q<{ hash: string; prefix: string; user_id: string | null }>(tx, sql`select hash, prefix, user_id from ingest_tokens where id = ${tok.id}`));
      expect(stored).toEqual({ hash: hashToken(tok.plaintext), prefix: tok.prefix, user_id: null });
      expect(await as(a, (tx) => revokeToken(tx, a, { tokenId: tok.id }))).toMatch(/revoked/);
      const [after] = await asOwner((tx) => q<{ revoked_at: Date | null }>(tx, sql`select revoked_at from ingest_tokens where id = ${tok.id}`));
      expect(after!.revoked_at).not.toBeNull();
      const rows = (await auditActions(acme)).filter((r) => r.action.startsWith('token.') && r.target === `token:${tok.id}`);
      expect(rows.map((r) => r.action)).toEqual(['token.create', 'token.revoke']);
      expect(JSON.stringify(rows)).not.toContain(tok.plaintext);
    });

    it('leads create team tokens only for led teams; members only user tokens for themselves', async () => {
      const lead = acme.people.lead!;
      const m1 = acme.people.m1!;
      const lt = await as(lead, (tx) => createToken(tx, lead, { kind: 'team', teamId: acme.teams.Platform, name: 'Platform fleet' }, ENDPOINT));
      expect(lt.kind).toBe('team');
      await expectAdminError(as(lead, (tx) => createToken(tx, lead, { kind: 'team', teamId: acme.teams.Mobile, name: 'x' }, ENDPOINT)), /leads of this team/);
      await expectAdminError(as(m1, (tx) => createToken(tx, m1, { kind: 'team', teamId: acme.teams.Platform, name: 'x' }, ENDPOINT)), /leads of this team/);
      const ut = await as(m1, (tx) => createToken(tx, m1, { kind: 'user', teamId: acme.teams.Platform, name: 'Laptop' }, ENDPOINT));
      expect(ut.mdmJson).toBeUndefined();
      // The lead sees the team token and their own, not m1's user token (RLS); m1 sees only their own.
      const leadSees = await as(lead, (tx) => listTokens(tx, acme.id));
      expect(leadSees.map((t) => t.id)).toContain(lt.id);
      expect(leadSees.map((t) => t.id)).not.toContain(ut.id);
      expect((await as(m1, (tx) => listTokens(tx, acme.id))).map((t) => t.id)).toEqual([ut.id]);
      // The lead may not revoke m1's user token; m1 may.
      await expectAdminError(as(lead, (tx) => revokeToken(tx, lead, { tokenId: ut.id })), /not found|not allowed/);
      expect(await as(m1, (tx) => revokeToken(tx, m1, { tokenId: ut.id }))).toMatch(/revoked/);
    });

    it('RLS backstop: a member cannot insert a team token even without the app guard', async () => {
      const m1 = acme.people.m1!;
      const code = await harness.pgErrorCode(
        as(m1, (tx) =>
          tx.execute(sql`insert into ingest_tokens (company_id, team_id, kind, name, prefix, hash, created_by_user_id)
            values (${acme.id}, ${acme.teams.Platform}, 'team', 'x', 'aiobs_t_x', 'deadbeef', ${m1.id})`),
        ),
      );
      expect(code).toBe('42501');
    });
  });

  describe('settings', () => {
    it('changes are saved and audited with before/after; retention is bounded by the plan', async () => {
      const a = acme.people.admin!;
      expect(await as(a, (tx) => updateSettings(tx, a, { individualVisibility: 'full', projectNaming: 'hashed', retentionDays: '200' }))).toMatch(/Saved/);
      const [c] = await asOwner((tx) => q<{ settings: Record<string, unknown> }>(tx, sql`select settings from companies where id = ${acme.id}`));
      expect(c!.settings).toEqual({ individualVisibility: 'full', projectNaming: 'hashed', retentionDays: 200 });
      await expectAdminError(as(a, (tx) => updateSettings(tx, a, { individualVisibility: 'full', projectNaming: 'hashed', retentionDays: 500 })), /between 30 and 395/);
      const row = (await auditActions(acme)).find((r) => r.action === 'settings.update')!;
      expect(row.meta).toMatchObject({ changed: ['individualVisibility', 'projectNaming', 'retentionDays'], before: { individualVisibility: 'aggregates-only' }, after: { retentionDays: 200 } });
      await as(a, (tx) => updateSettings(tx, a, { individualVisibility: 'aggregates-only', projectNaming: 'plain', retentionDays: 395 }));
    });

    it('runaway thresholds: saved within bounds, empty keeps the value, out of range refused (CHECK too)', async () => {
      const a = acme.people.admin!;
      const base = { individualVisibility: 'aggregates-only', projectNaming: 'plain', retentionDays: 395 };
      expect(await as(a, (tx) => updateSettings(tx, a, { ...base, runawayCostUsd: '50', runawayHours: '3.5' }))).toMatch(/Saved: runawayCostUsd, runawayHours/);
      expect(await as(a, (tx) => updateSettings(tx, a, { ...base, runawayCostUsd: '', runawayHours: '' }))).toBe('No changes.');
      const [c] = await asOwner((tx) => q<{ settings: Record<string, unknown> }>(tx, sql`select settings from companies where id = ${acme.id}`));
      expect(c!.settings).toMatchObject({ runawayCostUsd: 50, runawayHours: 3.5 });
      await expectAdminError(as(a, (tx) => updateSettings(tx, a, { ...base, runawayCostUsd: 0.5 })), /at least \$1/);
      await expectAdminError(as(a, (tx) => updateSettings(tx, a, { ...base, runawayHours: 100 })), /at most 72 hours/);
      await expect(
        asOwner((tx) => tx.execute(sql`update companies set settings = settings || '{"runawayHours": 0.1}'::jsonb where id = ${acme.id}`)),
      ).rejects.toThrow();
    });
  });

  describe('projects and budgets', () => {
    it('name + map a project; turn count over 30 days', async () => {
      const a = acme.people.admin!;
      await as(a, (tx) => setProjectName(tx, a, { projectId: acme.projectId, displayName: 'Billing' }));
      await as(a, (tx) => setProjectTeam(tx, a, { projectId: acme.projectId, teamId: acme.teams.Platform }));
      const [p] = await as(a, (tx) => listAdminProjects(tx, acme.id));
      expect(p).toMatchObject({ displayName: 'Billing', teamName: 'Platform', turns30d: 1, hashed: false });
      expect((await auditActions(acme)).map((r) => r.action)).toEqual(expect.arrayContaining(['project.rename', 'project.map']));
    });

    it('create / edit / delete budgets; Free has none', async () => {
      const a = acme.people.admin!;
      await as(a, (tx) => createBudget(tx, a, { scope: 'team', teamId: acme.teams.Platform, userId: '', kind: 'cost', limit: '100' }));
      const [b] = await asOwner((tx) => q<{ id: string; limit_value: string }>(tx, sql`select id, limit_value from budgets where company_id = ${acme.id}`));
      expect(Number(b!.limit_value)).toBe(100);
      await as(a, (tx) => updateBudget(tx, a, { budgetId: b!.id, kind: 'tokens', limit: '5000000' }));
      await as(a, (tx) => deleteBudget(tx, a, { budgetId: b!.id }));
      expect((await auditActions(acme)).map((r) => r.action)).toEqual(expect.arrayContaining(['budget.create', 'budget.update', 'budget.delete']));
      const o = solo.people.owner!;
      await expectAdminError(as(o, (tx) => createBudget(tx, o, { scope: 'team', teamId: solo.teams.Solo, kind: 'cost', limit: 5 })), /not part of the free plan/);
      const lead = acme.people.lead!;
      await expectAdminError(as(lead, (tx) => createBudget(tx, lead, { scope: 'team', teamId: acme.teams.Platform, kind: 'cost', limit: 5 })), /Only company admins/);
    });
  });

  describe('members cannot use admin operations', () => {
    it('the guard refuses before touching the database', async () => {
      const m1 = acme.people.m1!;
      await expectAdminError(as(m1, (tx) => createTeam(tx, m1, { name: 'Hack' })), /Only company admins/);
      await expectAdminError(as(m1, (tx) => updateSettings(tx, m1, { individualVisibility: 'full', projectNaming: 'plain', retentionDays: 395 })), /Only company admins/);
      await expectAdminError(as(m1, (tx) => createInvitation(tx, m1, { email: 'x@y.test' })), /Only company admins/);
      await expectAdminError(as(m1, (tx) => removeUser(tx, m1, { userId: acme.people.m2!.id })), /Only company admins/);
      await expectAdminError(as(m1, (tx) => changeCompanyRole(tx, m1, { userId: m1.id, role: 'admin' })), /Only company admins/);
    });

    it('a forged admin claim gets nothing from RLS either', async () => {
      const m1 = acme.people.m1!;
      const forged: Actor = { ...m1, companyRole: 'admin' }; // passes the app guard; the DB checks users.company_role
      // The company row is invisible for update (FOR UPDATE needs the admin policy), so nothing is created.
      await expect(as(forged, (tx) => createTeam(tx, forged, { name: 'Hack' }))).rejects.toThrow(/Company not found/);
      expect(await harness.pgErrorCode(as(forged, (tx) => tx.execute(sql`insert into teams (company_id, name) values (${acme.id}, 'Hack')`)))).toBe('42501');
      expect(await asOwner((tx) => q(tx, sql`select id from teams where name = 'Hack'`))).toEqual([]);
      expect(await as(forged, (tx) => updateSettings(tx, forged, { individualVisibility: 'full', projectNaming: 'plain', retentionDays: 395 })).catch((e: Error) => e.message)).toMatch(/Company not found|not allowed/);
      expect((await as(forged, (tx) => listAuditLog(tx, acme.id, { page: 1, pageSize: 10 }))).total).toBe(0);
      const invites = await as(forged, (tx) => q<{ id: string }>(tx, sql`select id from invitations`));
      expect(invites).toEqual([]);
      const [c] = await asOwner((tx) => q<{ settings: { individualVisibility: string } }>(tx, sql`select settings from companies where id = ${acme.id}`));
      expect(c!.settings.individualVisibility).toBe('aggregates-only');
    });
  });

  describe('removing a user (ADR-0012)', () => {
    it('refuses self-removal and demoting the last admin', async () => {
      const a = acme.people.admin!;
      await expectAdminError(as(a, (tx) => removeUser(tx, a, { userId: a.id })), /yourself/);
      await expectAdminError(as(a, (tx) => changeCompanyRole(tx, a, { userId: a.id, role: 'member' })), /at least one admin/);
    });

    it('deletes raw telemetry, nulls user_id in rollups, keeps the rollup, audits', async () => {
      const a = acme.people.admin!;
      const m1 = acme.people.m1!.id;
      expect(await as(a, (tx) => removeUser(tx, a, { userId: m1 }))).toMatch(/removed/);
      const left = await asOwner((tx) =>
        q<{ users: number; turns: number; usage: number; tokens: number; rollups: number; anon: number }>(
          tx,
          sql`select (select count(*)::int from users where id = ${m1}) as users,
                     (select count(*)::int from turns where company_id = ${acme.id}) as turns,
                     (select count(*)::int from usage where company_id = ${acme.id}) as usage,
                     (select count(*)::int from ingest_tokens where user_id = ${m1}) as tokens,
                     (select count(*)::int from daily_rollups where company_id = ${acme.id}) as rollups,
                     (select count(*)::int from daily_rollups where company_id = ${acme.id} and user_id is null) as anon`,
        ),
      );
      expect(left[0]).toEqual({ users: 0, turns: 0, usage: 0, tokens: 0, rollups: 1, anon: 1 });
      const row = (await auditActions(acme)).find((r) => r.action === 'user.remove')!;
      expect(row).toMatchObject({ target: `user:${m1}`, meta: { email: 'm1@acme.test' } });
    });

    it('the admin reads the audit log, newest first', async () => {
      const a = acme.people.admin!;
      const log = await as(a, (tx) => listAuditLog(tx, acme.id, { page: 1, pageSize: 5 }));
      expect(log.total).toBeGreaterThan(10);
      expect(log.rows).toHaveLength(5);
      expect(log.rows[0]!.action).toBe('user.remove');
      expect(log.rows[0]!.actor).toBe('admin');
    });
  });
});
