import { and, eq, isNull, sql } from 'drizzle-orm';
import { ingestTokens, teamMemberships, teams, users, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { pgCode } from './errors';
import { companyCounts, loadCompany } from './company';
import { id, name, optionalId, parse, teamRole } from './input';
import { isAdmin } from './permissions';
import { capacityError } from './plans';
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
  activeTokens: number;
}

/** All teams of the company with their members (the directory is company-readable; tokens: RLS). */
export async function listTeamsWithMembers(tx: Tx, companyId: string): Promise<TeamWithMembers[]> {
  const list = await rows<{ id: string; name: string; active_tokens: number }>(
    tx,
    sql`select t.id, t.name, (select count(*)::int from ingest_tokens k where k.team_id = t.id and k.revoked_at is null) as active_tokens
        from teams t where t.company_id = ${companyId}::uuid order by lower(t.name)`,
  );
  const members = await rows<{ team_id: string; user_id: string; name: string | null; email: string; role: TeamRole; primary_team_id: string | null }>(
    tx,
    sql`select m.team_id, m.user_id, u.name, u.email, m.role, u.primary_team_id
        from team_memberships m join users u on u.id = m.user_id
        where m.company_id = ${companyId}::uuid order by lower(coalesce(u.name, u.email))`,
  );
  return list.map((t) => ({
    id: t.id,
    name: t.name,
    activeTokens: Number(t.active_tokens),
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

/** Only an empty team: no members and no active tokens. Teams with telemetry are kept by the DB (FK). */
export async function deleteTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId } = parse(z.object({ teamId: id }), input);
  const nameBefore = await teamName(tx, actor.companyId, teamId);
  const [use] = await rows<{ members: number; tokens: number }>(
    tx,
    sql`select (select count(*)::int from team_memberships where team_id = ${teamId}::uuid) as members,
               (select count(*)::int from ingest_tokens where team_id = ${teamId}::uuid and revoked_at is null) as tokens`,
  );
  ensure(Number(use?.members) === 0, 'Remove all members first: only an empty team can be deleted.');
  ensure(Number(use?.tokens) === 0, 'Revoke the team\'s active tokens first.');
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

async function assertUser(tx: Tx, companyId: string, userId: string) {
  const [u] = await tx
    .select({ id: users.id, email: users.email, primaryTeamId: users.primaryTeamId })
    .from(users)
    .where(and(eq(users.companyId, companyId), eq(users.id, userId)));
  if (!u) throw new AdminError('User not found.');
  return u;
}

export async function addMember(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, userId, role } = parse(z.object({ teamId: id, userId: id, role: teamRole.default('member') }), input);
  const tName = await teamName(tx, actor.companyId, teamId);
  const u = await assertUser(tx, actor.companyId, userId);
  const added = await tx
    .insert(teamMemberships)
    .values({ companyId: actor.companyId, teamId, userId, role })
    .onConflictDoNothing()
    .returning({ id: teamMemberships.id });
  if (added.length === 0) return 'Already a member.';
  if (!u.primaryTeamId) await tx.update(users).set({ primaryTeamId: teamId }).where(eq(users.id, userId));
  await audit(tx, actor, 'team.member_add', `team:${teamId}`, { userId, team: tName, role });
  return 'Member added.';
}

/**
 * Removing the user's primary team moves "primary" to another of their teams (or none).
 * The user's own `aiobs_u_` tokens created for this team are revoked in the same transaction: ingest
 * attributes by the token's team, so a live token would keep filing the person's turns under a team
 * they have left (ADR-0007). Team tokens are the team's, not the member's, and stay.
 */
export async function removeMember(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, userId } = parse(z.object({ teamId: id, userId: id }), input);
  const tName = await teamName(tx, actor.companyId, teamId);
  const u = await assertUser(tx, actor.companyId, userId);
  const gone = await tx
    .delete(teamMemberships)
    .where(and(eq(teamMemberships.companyId, actor.companyId), eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)))
    .returning({ id: teamMemberships.id });
  ensure(gone.length === 1, 'Not a member of this team.');
  if (u.primaryTeamId === teamId) {
    const [other] = await tx.select({ teamId: teamMemberships.teamId }).from(teamMemberships).where(eq(teamMemberships.userId, userId)).limit(1);
    await tx.update(users).set({ primaryTeamId: other?.teamId ?? null }).where(eq(users.id, userId));
  }
  const revoked = await tx
    .update(ingestTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(ingestTokens.companyId, actor.companyId),
        eq(ingestTokens.teamId, teamId),
        eq(ingestTokens.userId, userId),
        eq(ingestTokens.kind, 'user'),
        isNull(ingestTokens.revokedAt),
      ),
    )
    .returning({ id: ingestTokens.id, prefix: ingestTokens.prefix });
  await audit(tx, actor, 'team.member_remove', `team:${teamId}`, { userId, team: tName });
  for (const t of revoked) {
    await audit(tx, actor, 'token.revoke', `token:${t.id}`, { kind: 'user', prefix: t.prefix, teamId, userId, reason: 'member removed from team' });
  }
  return revoked.length
    ? `Member removed. ${revoked.length === 1 ? 'Their user token for this team was' : `Their ${revoked.length} user tokens for this team were`} revoked; they can create a new one in their current team.`
    : 'Member removed.';
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
  return role === 'lead' ? 'Now a team lead.' : 'Now a team member.';
}

/** The primary team is the last fallback of turn attribution (BRIEF §4); it must be one of the user's teams. */
export async function setPrimaryTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { userId, teamId } = parse(z.object({ userId: id, teamId: optionalId }), input);
  await assertUser(tx, actor.companyId, userId);
  if (teamId) {
    const [m] = await tx
      .select({ id: teamMemberships.id })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)));
    ensure(m, 'The primary team must be one of the user\'s teams.');
  }
  await tx.update(users).set({ primaryTeamId: teamId }).where(and(eq(users.companyId, actor.companyId), eq(users.id, userId)));
  await audit(tx, actor, 'user.primary_team', `user:${userId}`, { teamId });
  return 'Primary team set.';
}
