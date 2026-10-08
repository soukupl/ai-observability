import { and, eq, sql } from 'drizzle-orm';
import { companyMemberships, teamMemberships, teams, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { pgCode } from './errors';
import { companyCounts, loadCompany } from './company';
import { id, name, optionalId, parse, teamRole } from './input';
import { isAdmin } from './permissions';
import { capacityError } from './plans';
import { revokeStrandedCompanyTokens, strandedMessage } from './tokens';
import { AdminError, ensure, type Actor, type TeamRole } from './types';

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: TeamRole;
  isPrimary: boolean;
}
export interface TeamWithMembers {
  id: string;
  name: string;
  members: TeamMember[];
}

/** All teams of the active company with their members (the directory is company-readable). */
export async function listTeamsWithMembers(tx: Tx, companyId: string): Promise<TeamWithMembers[]> {
  const list = await rows<{ id: string; name: string }>(
    tx,
    sql`select t.id, t.name from teams t where t.company_id = ${companyId}::uuid order by lower(t.name)`,
  );
  const members = await rows<{ team_id: string; user_id: string; name: string | null; email: string; role: TeamRole; primary_team_id: string | null }>(
    tx,
    sql`select m.team_id, m.user_id, u.name, u.email, m.role, cm.primary_team_id
        from team_memberships m
        join company_memberships cm on cm.company_id = m.company_id and cm.user_id = m.user_id
        join users u on u.id = m.user_id
        where m.company_id = ${companyId}::uuid order by lower(coalesce(u.name, u.email))`,
  );
  return list.map((t) => ({
    id: t.id,
    name: t.name,
    members: members
      .filter((m) => m.team_id === t.id)
      .map((m) => ({ userId: m.user_id, name: m.name || m.email, email: m.email, role: m.role, isPrimary: m.primary_team_id === t.id })),
  }));
}

const requireAdmin = (a: Actor) => ensure(isAdmin(a), 'Only company admins can manage teams.');

async function teamName(tx: Tx, companyId: string, teamId: string): Promise<string> {
  const [t] = await tx.select({ name: teams.name }).from(teams).where(and(eq(teams.companyId, companyId), eq(teams.id, teamId)));
  if (!t) throw new AdminError('Team not found.');
  return t.name;
}

export async function createTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { name: teamNameIn } = parse(z.object({ name: name() }), input);
  const company = await loadCompany(tx, actor.companyId, true);
  const limitErr = capacityError(company.plan, 'teams', (await companyCounts(tx, actor.companyId)).teams);
  if (limitErr) throw new AdminError(limitErr);
  const [t] = await tx.insert(teams).values({ companyId: actor.companyId, name: teamNameIn }).returning({ id: teams.id });
  await audit(tx, actor, 'team.create', `team:${t!.id}`, { name: teamNameIn });
  return `Team "${teamNameIn}" created.`;
}

export async function renameTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, name: newName } = parse(z.object({ teamId: id, name: name() }), input);
  const before = await teamName(tx, actor.companyId, teamId);
  if (before === newName) return 'No changes.';
  await tx.update(teams).set({ name: newName }).where(and(eq(teams.companyId, actor.companyId), eq(teams.id, teamId)));
  await audit(tx, actor, 'team.rename', `team:${teamId}`, { before, after: newName });
  return 'Team renamed.';
}

/** Only an empty team: no members. Teams with telemetry are kept by the DB (FK). */
export async function deleteTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId } = parse(z.object({ teamId: id }), input);
  const nameBefore = await teamName(tx, actor.companyId, teamId);
  const [use] = await rows<{ members: number }>(tx, sql`select count(*)::int as members from team_memberships where team_id = ${teamId}::uuid`);
  ensure(Number(use?.members) === 0, 'Remove all members first: only an empty team can be deleted.');
  try {
    await tx.execute(sql`savepoint del_team`);
    await tx.delete(teams).where(and(eq(teams.companyId, actor.companyId), eq(teams.id, teamId)));
    await tx.execute(sql`release savepoint del_team`);
  } catch (err) {
    await tx.execute(sql`rollback to savepoint del_team`);
    if (pgCode(err) === '23503') {
      throw new AdminError('This team still has recorded turns, so it cannot be deleted. Rename it instead.');
    }
    throw err;
  }
  await audit(tx, actor, 'team.delete', `team:${teamId}`, { name: nameBefore });
  return `Team "${nameBefore}" deleted.`;
}

/** The person must be a member of the active company (a team member must be a company member, FK-enforced too). */
async function assertMember(tx: Tx, companyId: string, userId: string) {
  const [m] = await tx
    .select({ userId: companyMemberships.userId, primaryTeamId: companyMemberships.primaryTeamId })
    .from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.userId, userId)));
  if (!m) throw new AdminError('Member not found.');
  return m;
}

export async function addMember(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, userId, role } = parse(z.object({ teamId: id, userId: id, role: teamRole.default('member') }), input);
  const tName = await teamName(tx, actor.companyId, teamId);
  const u = await assertMember(tx, actor.companyId, userId);
  const added = await tx
    .insert(teamMemberships)
    .values({ companyId: actor.companyId, teamId, userId, role })
    .onConflictDoNothing()
    .returning({ id: teamMemberships.id });
  if (added.length === 0) return 'Already a member.';
  if (!u.primaryTeamId) {
    await tx.update(companyMemberships).set({ primaryTeamId: teamId }).where(and(eq(companyMemberships.companyId, actor.companyId), eq(companyMemberships.userId, userId)));
  }
  await audit(tx, actor, 'team.member_add', `team:${teamId}`, { userId, team: tName, role });
  return 'Member added.';
}

/**
 * Removing a person from a team moves their "primary" to another of their teams in this company (or none).
 * Their user tokens stay: tokens have no team any more (ADR-0022). Company tokens they created are revoked
 * when they are no longer an admin or a lead of any team (D2, 4.2a).
 */
export async function removeMember(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, userId } = parse(z.object({ teamId: id, userId: id }), input);
  const tName = await teamName(tx, actor.companyId, teamId);
  const u = await assertMember(tx, actor.companyId, userId);
  const gone = await tx
    .delete(teamMemberships)
    .where(and(eq(teamMemberships.companyId, actor.companyId), eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)))
    .returning({ id: teamMemberships.id });
  ensure(gone.length === 1, 'Not a member of this team.');
  if (u.primaryTeamId === teamId) {
    const [other] = await tx
      .select({ teamId: teamMemberships.teamId })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.companyId, actor.companyId), eq(teamMemberships.userId, userId)))
      .limit(1);
    await tx
      .update(companyMemberships)
      .set({ primaryTeamId: other?.teamId ?? null })
      .where(and(eq(companyMemberships.companyId, actor.companyId), eq(companyMemberships.userId, userId)));
  }
  await audit(tx, actor, 'team.member_remove', `team:${teamId}`, { userId, team: tName });
  const revoked = await revokeStrandedCompanyTokens(tx, actor, userId, 'creator no longer admin or lead');
  return `Member removed.${strandedMessage(revoked)}`;
}

export async function setMemberRole(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, userId, role } = parse(z.object({ teamId: id, userId: id, role: teamRole }), input);
  const tName = await teamName(tx, actor.companyId, teamId);
  const done = await tx
    .update(teamMemberships)
    .set({ role })
    .where(and(eq(teamMemberships.companyId, actor.companyId), eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)))
    .returning({ id: teamMemberships.id });
  ensure(done.length === 1, 'Not a member of this team.');
  await audit(tx, actor, 'team.member_role', `team:${teamId}`, { userId, team: tName, role });
  if (role === 'lead') return 'Now a team lead.';
  const revoked = await revokeStrandedCompanyTokens(tx, actor, userId, 'creator no longer admin or lead');
  return `Now a team member.${strandedMessage(revoked)}`;
}

/** The primary team (in this company) is the last fallback of turn attribution (BRIEF §4); it must be one of the user's teams. */
export async function setPrimaryTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { userId, teamId } = parse(z.object({ userId: id, teamId: optionalId }), input);
  await assertMember(tx, actor.companyId, userId);
  if (teamId) {
    const [m] = await tx
      .select({ id: teamMemberships.id })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.companyId, actor.companyId), eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)));
    ensure(m, 'The primary team must be one of the user\'s teams.');
  }
  await tx.update(companyMemberships).set({ primaryTeamId: teamId }).where(and(eq(companyMemberships.companyId, actor.companyId), eq(companyMemberships.userId, userId)));
  await audit(tx, actor, 'user.primary_team', `user:${userId}`, { teamId });
  return 'Primary team set.';
}
