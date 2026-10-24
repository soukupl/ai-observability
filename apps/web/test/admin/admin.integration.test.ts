import { sql } from 'drizzle-orm';
import { createDb, withRlsContext, type Database, type Tx } from '@ai-obs/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listAuditLog } from '../../src/lib/admin/audit';
import { createBudget, deleteBudget, listBudgetConfigs, updateBudget } from '../../src/lib/admin/budgets';
import { deploymentCounts, loadDeployment, renameDeployment, updateSettings } from '../../src/lib/admin/deployment';
import { createInvitation, listPendingInvitations, revokeInvitation } from '../../src/lib/admin/invitations';
import { changeRole, listMembers, removeMember as removeDeploymentMember } from '../../src/lib/admin/members';
import { deleteModelPrice, listModelPrices, saveModelPrice } from '../../src/lib/admin/model-prices';
import { listAdminProjects, setProjectName, setProjectTeam } from '../../src/lib/admin/projects';
import { createServiceUser, disableServiceUser, listServiceUsers, renameServiceUser, setServicePrimaryTeam } from '../../src/lib/admin/service-users';
import { addMember, createTeam, deleteTeam, listTeamsWithMembers, removeMember, renameTeam, setMemberRole, setPrimaryTeam, setTeamSlug } from '../../src/lib/admin/teams';
import { createOwnToken, createServiceToken, listTokens, revokeToken } from '../../src/lib/admin/tokens';
import { AdminError, type Actor } from '../../src/lib/admin/types';
import { hashToken } from '../../src/lib/ingest/tokens';

/**
 * Admin console against real Postgres in its own database (ADMIN_TEST_DATABASE_URL, default ai_obs_admin_test,
 * dropped afterwards). Every operation runs as app_web inside the actor's RLS context, exactly like withUserDb().
 */
const testUrl = new URL(process.env.ADMIN_TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_admin_test');
vi.stubEnv('TEST_DATABASE_URL', testUrl.toString());
const harness = await import('../../../../packages/db/test/db-harness');
const skipReason = await harness.prepareTestDatabase();
if (skipReason) console.warn(`[web/admin] integration tests skipped: ${skipReason}`);

const ENDPOINT = 'https://obs.example';
const DAY = 86_400_000;

describe.skipIf(skipReason !== null)(skipReason ? `admin console — SKIPPED: ${skipReason}` : 'admin console (real Postgres)', () => {
  let owner: Database;
  let web: Database;
  const teams: Record<string, string> = {};
  const people: Record<string, Actor> = {};
  let projectId: string;

  const asOwner = <T>(fn: (tx: Tx) => Promise<T>) =>
    owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return fn(tx);
    });
  const as = <T>(a: Actor, fn: (tx: Tx) => Promise<T>) => withRlsContext(web, { userId: a.id, role: a.role }, fn);
  const q = async <T>(tx: Tx, s: ReturnType<typeof sql>) => Array.from((await tx.execute(s)) as unknown as T[]);
  const auditRows = (action: string) =>
    asOwner((tx) => q<{ actor_user_id: string; target: string | null; meta: Record<string, unknown> }>(tx, sql`select actor_user_id, target, meta from audit_log where action = ${action} order by at, id`));
  const rejects = async (p: Promise<unknown>, msg: RegExp) => {
    await expect(p).rejects.toBeInstanceOf(AdminError);
    await expect(p).rejects.toThrow(msg);
  };

  async function addPerson(key: string, role: 'admin' | 'member', team: string, teamRole: 'member' | 'lead'): Promise<Actor> {
    return asOwner(async (tx) => {
      const [u] = await q<{ id: string }>(tx, sql`insert into users (email, name) values (${`${key}@spectado.test`}, ${key}) returning id`);
      await tx.execute(sql`insert into memberships (user_id, role, primary_team_id) values (${u!.id}, ${role}, ${teams[team]})`);
      await tx.execute(sql`insert into team_memberships (team_id, user_id, role) values (${teams[team]}, ${u!.id}, ${teamRole})`);
      const a: Actor = { id: u!.id, role, teams: [{ id: teams[team]!, role: teamRole }] };
      people[key] = a;
      return a;
    });
  }

  beforeAll(async () => {
    owner = harness.connectOwner();
    web = harness.connectAs('web');
    await asOwner(async (tx) => {
      await tx.execute(sql`update deployment set name = 'SPECTADO', slug = 'spectado'`);
      for (const t of ['Platform', 'Mobile']) teams[t] = (await q<{ id: string }>(tx, sql`insert into teams (name) values (${t}) returning id`))[0]!.id;
      projectId = (await q<{ id: string }>(tx, sql`insert into projects (key) values ('github.com/spectado/billing') returning id`))[0]!.id;
    });
    await addPerson('admin', 'admin', 'Platform', 'member');
    await addPerson('lead', 'member', 'Platform', 'lead');
    await addPerson('m1', 'member', 'Platform', 'member');
    await addPerson('m2', 'member', 'Mobile', 'member');
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

  it('settings: admins change visibility, retention (30–730) and runaway thresholds, audited; members cannot', async () => {
    const a = people.admin!;
    expect(await as(a, (tx) => updateSettings(tx, a, { individualVisibility: 'full', projectNaming: 'plain', retentionDays: '730', runawayHours: '4' }))).toMatch(/Saved: /);
    const dep = await as(a, (tx) => loadDeployment(tx));
    expect(dep.settings).toMatchObject({ individualVisibility: 'full', retentionDays: 730, runawayHours: 4 });
    const [row] = await auditRows('settings.update');
    expect(row).toMatchObject({ actor_user_id: a.id, target: 'deployment:spectado' });
    expect(row!.meta).toMatchObject({ before: { individualVisibility: 'aggregates-only', retentionDays: 395 }, after: { individualVisibility: 'full', retentionDays: 730 } });
    expect(await as(a, (tx) => updateSettings(tx, a, { individualVisibility: 'full', projectNaming: 'plain', retentionDays: '730' }))).toBe('No changes.');
    await rejects(as(a, (tx) => updateSettings(tx, a, { individualVisibility: 'full', projectNaming: 'plain', retentionDays: '731' })), /at most 730/);
    const m = people.m1!;
    await rejects(as(m, (tx) => updateSettings(tx, m, { individualVisibility: 'aggregates-only', projectNaming: 'plain', retentionDays: '30' })), /Only admins/);
    // RLS too: a member claiming admin in the context cannot write the row.
    const forged = await withRlsContext(web, { userId: m.id, role: 'admin' }, (tx) => q<{ id: string }>(tx, sql`update deployment set name = 'pwned' returning id`));
    expect(forged).toEqual([]);
  });

  it('deployment name: admins rename it (header, e-mails), the slug stays', async () => {
    const a = people.admin!;
    expect(await as(a, (tx) => renameDeployment(tx, a, { name: 'SPECTADO s.r.o.' }))).toBe('Deployment renamed.');
    expect(await as(a, (tx) => loadDeployment(tx))).toMatchObject({ name: 'SPECTADO s.r.o.', slug: 'spectado' });
    expect((await auditRows('deployment.rename'))[0]!.meta).toEqual({ before: 'SPECTADO', after: 'SPECTADO s.r.o.' });
    await as(a, (tx) => renameDeployment(tx, a, { name: 'SPECTADO' }));
  });

  it('teams: slugs derived or chosen, unique, editable only until a turn references the team', async () => {
    const a = people.admin!;
    expect(await as(a, (tx) => createTeam(tx, a, { name: 'Data Science', slug: '' }))).toBe('Team "Data Science" created (slug data-science).');
    expect(await as(a, (tx) => createTeam(tx, a, { name: 'Ops', slug: 'sre' }))).toMatch(/slug sre/);
    await rejects(as(a, (tx) => createTeam(tx, a, { name: 'Ops 2', slug: 'sre' })), /already exists/);
    const list = await as(a, (tx) => listTeamsWithMembers(tx));
    const ops = list.find((t) => t.name === 'Ops')!;
    expect(list.find((t) => t.name === 'Platform')).toMatchObject({ slug: 'platform' });
    expect(await as(a, (tx) => setTeamSlug(tx, a, { teamId: ops.id, slug: 'Ops-Team' }))).toMatch(/Slug changed to ops-team/);
    await rejects(as(a, (tx) => setTeamSlug(tx, a, { teamId: ops.id, slug: 'platform' })), /Another team already uses/);
    await asOwner((tx) => tx.execute(sql`insert into turns (team_id, user_id, attribution, external_id, harness, started_at, ended_at) values (${ops.id}, ${a.id}, 'verified', 'turn-ops-1', 'claude-code', now(), now())`));
    await rejects(as(a, (tx) => setTeamSlug(tx, a, { teamId: ops.id, slug: 'ops' })), /is fixed: turns already reference/);
    expect(await as(a, (tx) => renameTeam(tx, a, { teamId: ops.id, name: 'Operations' }))).toMatch(/slug is unchanged/);
    expect((await as(a, (tx) => listTeamsWithMembers(tx))).find((t) => t.id === ops.id)).toMatchObject({ name: 'Operations', slug: 'ops-team' });
    // An empty team with recorded turns cannot be deleted; an unused one can.
    await rejects(as(a, (tx) => deleteTeam(tx, a, { teamId: ops.id })), /recorded turns/);
    const ds = list.find((t) => t.name === 'Data Science')!;
    // Its budget (FK cascade) and project mapping (set null) go with it, each audited.
    const dsBudget = (await asOwner((tx) => q<{ id: string }>(tx, sql`insert into budgets (team_id, kind, limit_value) values (${ds.id}, 'cost', 100) returning id`)))[0]!.id;
    const dsProject = (await asOwner((tx) => q<{ id: string }>(tx, sql`insert into projects (key, team_id) values ('github.com/spectado/ds-notebooks', ${ds.id}) returning id`)))[0]!.id;
    expect(await as(a, (tx) => deleteTeam(tx, a, { teamId: ds.id }))).toBe('Team "Data Science" deleted. 1 budget removed, 1 project mapping cleared.');
    expect((await auditRows('budget.delete')).find((r) => r.target === `budget:${dsBudget}`)?.meta).toMatchObject({ kind: 'cost', limit: 100, teamId: ds.id, reason: 'team_deleted' });
    expect((await auditRows('project.unmap')).find((r) => r.target === `project:${dsProject}`)?.meta).toMatchObject({ before: ds.id, after: null, reason: 'team_deleted' });
    expect((await auditRows('team.delete')).at(-1)!.meta).toMatchObject({ name: 'Data Science', budgets: [dsBudget], projects: ['github.com/spectado/ds-notebooks'] });
    expect(await asOwner((tx) => q(tx, sql`select 1 from projects where id = ${dsProject} and team_id is null`))).toHaveLength(1);
    await asOwner((tx) => tx.execute(sql`delete from projects where id = ${dsProject}`));
    const m = people.m1!;
    await rejects(as(m, (tx) => createTeam(tx, m, { name: 'Shadow' })), /Only admins/);
  });

  it('team memberships: add, lead, primary team, remove (primary moves to another team)', async () => {
    const a = people.admin!;
    const m2 = people.m2!;
    expect(await as(a, (tx) => addMember(tx, a, { teamId: teams.Platform, userId: m2.id, role: 'member' }))).toBe('Member added.');
    expect(await as(a, (tx) => setMemberRole(tx, a, { teamId: teams.Platform, userId: m2.id, role: 'lead' }))).toBe('Now a team lead.');
    expect(await as(a, (tx) => setPrimaryTeam(tx, a, { userId: m2.id, teamId: teams.Platform }))).toBe('Primary team set.');
    expect(await as(a, (tx) => removeMember(tx, a, { teamId: teams.Platform, userId: m2.id }))).toBe('Member removed.');
    const me = (await as(a, (tx) => listMembers(tx))).find((x) => x.id === m2.id)!;
    expect(me.primaryTeamId).toBe(teams.Mobile);
    expect(me.teams.map((t) => t.name)).toEqual(['Mobile']);
  });

  it('roles: the last admin cannot be demoted; changes are audited', async () => {
    const a = people.admin!;
    await rejects(as(a, (tx) => changeRole(tx, a, { userId: a.id, role: 'member' })), /at least one admin/);
    expect(await as(a, (tx) => changeRole(tx, a, { userId: people.lead!.id, role: 'admin' }))).toMatch(/is now an admin/);
    expect(await as(a, (tx) => changeRole(tx, a, { userId: people.lead!.id, role: 'member' }))).toMatch(/is now a member/);
    expect((await auditRows('user.role')).map((r) => r.meta.after)).toEqual(['admin', 'member']);
  });

  it('invitations: team + team role + role; existing members refused; a newer one replaces the pending one; revoke', async () => {
    const a = people.admin!;
    const inv = await as(a, (tx) => createInvitation(tx, a, { email: 'New@Spectado.test', teamId: teams.Mobile, teamRole: 'lead', role: 'admin' }));
    expect(inv).toMatchObject({ email: 'new@spectado.test', teamName: 'Mobile', deploymentName: 'SPECTADO' });
    expect(inv.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * DAY);
    await as(a, (tx) => createInvitation(tx, a, { email: 'new@spectado.test', teamId: teams.Platform, teamRole: 'member', role: 'member' }));
    const pending = await as(a, (tx) => listPendingInvitations(tx));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ email: 'new@spectado.test', teamName: 'Platform', teamRole: 'member', role: 'member', invitedBy: 'admin' });
    // The replaced invitation leaves a trace: invitation.revoke with reason "replaced".
    const replaced = await auditRows('invitation.revoke');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ target: `invitation:${inv.id}`, meta: { email: 'new@spectado.test', teamId: teams.Mobile, teamRole: 'lead', role: 'admin', reason: 'replaced' } });
    await rejects(as(a, (tx) => createInvitation(tx, a, { email: 'm1@spectado.test', teamId: teams.Mobile })), /already a member/);
    const m = people.m1!;
    await rejects(as(m, (tx) => createInvitation(tx, m, { email: 'x@spectado.test' })), /Only admins/);
    expect(await as(m, (tx) => listPendingInvitations(tx))).toEqual([]); // RLS: admins only
    expect(await as(a, (tx) => revokeInvitation(tx, a, { invitationId: pending[0]!.id }))).toMatch(/revoked/);
    expect(await as(a, (tx) => listPendingInvitations(tx))).toEqual([]);
  });

  it('my tokens: manual tokens with a lifetime, only the hash stored; members see and revoke only their own', async () => {
    const m1 = people.m1!;
    const t30 = await as(m1, (tx) => createOwnToken(tx, m1, { name: 'Laptop', lifetime: '30' }, ENDPOINT));
    expect(t30.plaintext).toMatch(/^aiobs_u_/);
    expect(t30.command).toBe(`npx ai-obs-cli login --server ${ENDPOINT} --token ${t30.plaintext}`);
    expect(new Date(t30.expiresAt!).getTime() - Date.now()).toBeGreaterThan(29.9 * DAY);
    const forever = await as(m1, (tx) => createOwnToken(tx, m1, { name: 'Build box', lifetime: 'none' }, ENDPOINT));
    expect(forever.expiresAt).toBeNull();
    const [row] = await asOwner((tx) => q<{ hash: string; source: string; user_id: string; created_by_user_id: string }>(tx, sql`select hash, source, user_id, created_by_user_id from ingest_tokens where id = ${t30.id}`));
    expect(row).toEqual({ hash: hashToken(t30.plaintext), source: 'manual', user_id: m1.id, created_by_user_id: m1.id });
    expect((await auditRows('token.create')).at(-1)!.meta).toMatchObject({ source: 'manual', name: 'Build box', lifetime: 'none', userId: m1.id });

    const m2 = people.m2!;
    const other = await as(m2, (tx) => createOwnToken(tx, m2, { name: 'Phone' }, ENDPOINT));
    expect(new Date(other.expiresAt!).getTime() - Date.now()).toBeGreaterThan(89.9 * DAY); // default 90 days
    expect((await as(m1, (tx) => listTokens(tx))).map((t) => t.name).sort()).toEqual(['Build box', 'Laptop']);
    await rejects(as(m1, (tx) => revokeToken(tx, m1, { tokenId: other.id })), /not found/); // invisible under RLS
    expect(await as(m1, (tx) => revokeToken(tx, m1, { tokenId: t30.id }))).toMatch(/revoked/);
    expect(await as(m1, (tx) => revokeToken(tx, m1, { tokenId: t30.id }))).toBe('Already revoked.');
    // Admins see every token and revoke anyone's (D6).
    const a = people.admin!;
    const all = await as(a, (tx) => listTokens(tx));
    expect(all.find((t) => t.id === other.id)).toMatchObject({ userName: 'm2', userKind: 'person', source: 'manual', label: null });
    expect(await as(a, (tx) => revokeToken(tx, a, { tokenId: other.id }))).toMatch(/revoked/);
  });

  it('service users: create with a primary team, rename, re-team, tokens by admins only, disable revokes and leaves teams', async () => {
    const a = people.admin!;
    expect(await as(a, (tx) => createServiceUser(tx, a, { name: 'GitHub Actions', primaryTeamId: teams.Platform }))).toMatch(/created/);
    let [svc] = await as(a, (tx) => listServiceUsers(tx));
    expect(svc).toMatchObject({ name: 'GitHub Actions', primaryTeamId: teams.Platform, teams: [{ id: teams.Platform, name: 'Platform' }], liveTokens: 0, disabled: false });
    expect((await as(a, (tx) => listMembers(tx))).some((m) => m.id === svc!.id)).toBe(false); // not a person
    expect(await as(a, (tx) => renameServiceUser(tx, a, { userId: svc!.id, name: 'CI' }))).toBe('Service user renamed.');
    expect(await as(a, (tx) => setServicePrimaryTeam(tx, a, { userId: svc!.id, teamId: teams.Mobile }))).toBe('Primary team set.');

    const tok = await as(a, (tx) => createServiceToken(tx, a, { userId: svc!.id, name: 'runners', lifetime: '365' }, ENDPOINT));
    const [row] = await asOwner((tx) => q<{ user_id: string; created_by_user_id: string; source: string }>(tx, sql`select user_id, created_by_user_id, source from ingest_tokens where id = ${tok.id}`));
    expect(row).toEqual({ user_id: svc!.id, created_by_user_id: a.id, source: 'manual' });
    // Admins cannot mint a person's token; members cannot mint a service user's.
    await rejects(as(a, (tx) => createServiceToken(tx, a, { userId: people.m1!.id, name: 'x' }, ENDPOINT)), /only for service users/);
    const m = people.m1!;
    await rejects(as(m, (tx) => createServiceToken(tx, m, { userId: svc!.id, name: 'x' }, ENDPOINT)), /only for service users|not found/);
    await rejects(as(m, (tx) => createServiceUser(tx, m, { name: 'Shadow' })), /Only admins/);

    [svc] = await as(a, (tx) => listServiceUsers(tx));
    expect(svc).toMatchObject({ name: 'CI', primaryTeamId: teams.Mobile, liveTokens: 1 });
    expect(svc!.teams.map((t) => t.name)).toEqual(['Mobile', 'Platform']);
    expect(await as(a, (tx) => disableServiceUser(tx, a, { userId: svc!.id }))).toMatch(/1 token\(s\) revoked, removed from 2 team\(s\)/);
    [svc] = await as(a, (tx) => listServiceUsers(tx));
    expect(svc).toMatchObject({ primaryTeamId: null, teams: [], liveTokens: 0, disabled: true });
    expect((await auditRows('token.revoke')).at(-1)!.meta).toMatchObject({ reason: 'service user disabled', userId: svc!.id });
    expect(await auditRows('service_user.disable')).toHaveLength(1);
  });

  it('removing a member revokes their tokens, ends access, keeps the identity; only admins; never yourself', async () => {
    const a = people.admin!;
    const victim = await addPerson('leaver', 'member', 'Mobile', 'member');
    await as(victim, (tx) => createOwnToken(tx, victim, { name: 'Old laptop' }, ENDPOINT));
    await rejects(as(a, (tx) => removeDeploymentMember(tx, a, { userId: a.id })), /cannot remove yourself/);
    await rejects(as(people.m1!, (tx) => removeDeploymentMember(tx, people.m1!, { userId: victim.id })), /Only admins/);
    expect(await as(a, (tx) => removeDeploymentMember(tx, a, { userId: victim.id }))).toMatch(/leaver@spectado.test removed. 1 token\(s\) revoked/);
    expect((await as(a, (tx) => listMembers(tx))).some((m) => m.id === victim.id)).toBe(false);
    expect((await as(a, (tx) => listTokens(tx))).find((t) => t.userId === victim.id)).toMatchObject({ userName: null, revokedMs: expect.any(Number) });
    expect(await asOwner((tx) => q(tx, sql`select 1 from users where id = ${victim.id}`))).toHaveLength(1);
    expect((await auditRows('user.remove')).at(-1)!.meta).toMatchObject({ email: 'leaver@spectado.test', revokedTokens: 1 });
  });

  it('projects: display name and the mapping that overrides the dot file, audited', async () => {
    const a = people.admin!;
    expect(await as(a, (tx) => setProjectName(tx, a, { projectId, displayName: 'Billing' }))).toBe('Display name saved.');
    expect(await as(a, (tx) => setProjectTeam(tx, a, { projectId, teamId: teams.Mobile }))).toMatch(/whatever the repository's dot file says/);
    const [p] = await as(a, (tx) => listAdminProjects(tx));
    expect(p).toMatchObject({ displayName: 'Billing', teamId: teams.Mobile, teamName: 'Mobile', hashed: false });
    expect((await auditRows('project.map'))[0]!.meta).toEqual({ before: null, after: teams.Mobile });
    await rejects(as(people.m1!, (tx) => setProjectTeam(tx, people.m1!, { projectId, teamId: null })), /Only admins/);
  });

  it('budgets: always allowed (no plans); admins write, leads read their teams only', async () => {
    const a = people.admin!;
    expect(await as(a, (tx) => createBudget(tx, a, { scope: 'team', teamId: teams.Platform, kind: 'cost', limit: '500' }))).toBe('Budget created.');
    expect(await as(a, (tx) => createBudget(tx, a, { scope: 'team', teamId: teams.Mobile, kind: 'tokens', limit: '1000000' }))).toBe('Budget created.');
    const lead = people.lead!;
    await rejects(as(lead, (tx) => createBudget(tx, lead, { scope: 'team', teamId: teams.Platform, kind: 'cost', limit: '1' })), /Only admins/);
    expect((await as(lead, (tx) => listBudgetConfigs(tx))).map((b) => b.teamName)).toEqual(['Platform']);
    const [b] = await as(a, (tx) => listBudgetConfigs(tx));
    expect(await as(a, (tx) => updateBudget(tx, a, { budgetId: b!.id, kind: 'cost', limit: '750' }))).toBe('Budget saved.');
    expect(await as(a, (tx) => deleteBudget(tx, a, { budgetId: b!.id }))).toBe('Budget deleted.');
  });

  it('model prices: admins add, replace and delete prices, audited; members cannot (RLS too)', async () => {
    const a = people.admin!;
    const p = { model: 'test-model', effectiveFrom: '2026-10-01', input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' };
    expect(await as(a, (tx) => saveModelPrice(tx, a, p))).toBe('Price of test-model from 2026-10-01 added.');
    expect(await as(a, (tx) => saveModelPrice(tx, a, { ...p, output: '12' }))).toBe('Price of test-model from 2026-10-01 updated.');
    const row = (await as(a, (tx) => listModelPrices(tx))).find((x) => x.model === 'test-model')!;
    expect(row).toMatchObject({ effectiveFrom: '2026-10-01', input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3.75 });
    expect((await auditRows('model_price.update'))[0]!.meta).toMatchObject({ before: { output: 15 }, after: { output: 12 } });
    const m = people.m1!;
    await rejects(as(m, (tx) => saveModelPrice(tx, m, p)), /Only admins/);
    expect(await harness.pgErrorCode(as(m, (tx) => tx.execute(sql`insert into model_prices (model, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) values ('x', '2026-01-01', 1, 1, 1, 1)`)))).toBe('42501');
    expect(row.isDefault).toBe(false);
    expect(await as(a, (tx) => deleteModelPrice(tx, a, { priceId: row.id }))).toMatch(/deleted\. Turns of that model now use the previous price/);
    expect(await auditRows('model_price.delete')).toHaveLength(1);
    // A built-in default comes back at the next migration: the row says so and so does the delete message.
    await asOwner((tx) => tx.execute(sql`insert into model_prices (model, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) values ('claude-haiku-4-5', '2026-01-01', 1, 5, 0.1, 1.25) on conflict do nothing`));
    const def = (await as(a, (tx) => listModelPrices(tx))).find((x) => x.model === 'claude-haiku-4-5' && x.effectiveFrom === '2026-01-01')!;
    expect(def.isDefault).toBe(true);
    expect(await as(a, (tx) => deleteModelPrice(tx, a, { priceId: def.id }))).toMatch(/built-in default, so the next migration \(deploy\) adds it back/);
    expect((await auditRows('model_price.delete')).at(-1)!.meta).toMatchObject({ model: 'claude-haiku-4-5', default: true });
  });

  it('audit log and counts: admins read everything; members read nothing', async () => {
    const a = people.admin!;
    const { rows, total } = await as(a, (tx) => listAuditLog(tx, { page: 1, pageSize: 5 }));
    expect(rows).toHaveLength(5);
    expect(total).toBeGreaterThan(20);
    expect(rows[0]!.actor).toBe('admin');
    const m = people.m1!;
    expect(await as(m, (tx) => listAuditLog(tx, { page: 1, pageSize: 5 }))).toEqual({ rows: [], total: 0 });
    const counts = await as(a, (tx) => deploymentCounts(tx));
    expect(counts).toMatchObject({ members: 4, serviceUsers: 1, teams: 3, projects: 1, pendingInvitations: 0 });
    expect(counts.activeTokens).toBe(1); // m1's no-expiry "Build box"
  });
});
