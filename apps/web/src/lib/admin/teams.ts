import { and, eq, sql } from 'drizzle-orm';
import { memberships, teamMemberships, teams, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { pgCode } from './errors';
import { id, name, optionalId, parse, teamRole, teamSlug } from './input';
import { isAdmin } from './permissions';
import { AdminError, ensure, type Actor, type TeamRole } from './types';

export interface TeamMember {
  userId: string;
  name: string;
  /** null for a service user. */
  email: string | null;
  kind: 'person' | 'service';
  role: TeamRole;
  isPrimary: boolean;
}
export interface TeamWithMembers {
  id: string;
  name: string;
  /** The team's identifier for collectors (ADR-0030 R4); fixed once a turn references the team. */
  slug: string;
  members: TeamMember[];
}

/** All teams with their members (the directory is member-readable). */
export async function listTeamsWithMembers(tx: Tx): Promise<TeamWithMembers[]> {
  const list = await rows<{ id: string; name: string; slug: string }>(tx, sql`select t.id, t.name, t.slug from teams t order by lower(t.name)`);
  const members = await rows<{ team_id: string; user_id: string; name: string | null; email: string | null; kind: 'person' | 'service'; role: TeamRole; primary_team_id: string | null }>(
    tx,
    sql`select m.team_id, m.user_id, u.name, u.email, u.kind, m.role, ms.primary_team_id
        from team_memberships m
        join memberships ms on ms.user_id = m.user_id
        join users u on u.id = m.user_id
        order by lower(coalesce(u.name, u.email))`,
  );
  return list.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    members: members
      .filter((m) => m.team_id === t.id)
      .map((m) => ({ userId: m.user_id, name: m.name || m.email || 'service user', email: m.email, kind: m.kind, role: m.role, isPrimary: m.primary_team_id === t.id })),
  }));
}

const requireAdmin = (a: Actor) => ensure(isAdmin(a), 'Only admins can manage teams.');

async function loadTeam(tx: Tx, teamId: string): Promise<{ name: string; slug: string }> {
  const [t] = await tx.select({ name: teams.name, slug: teams.slug }).from(teams).where(eq(teams.id, teamId));
  if (!t) throw new AdminError('Team not found.');
  return t;
}

/** Runs a team write in a savepoint so a constraint error becomes a readable message instead of aborting the transaction. */
async function guarded<T>(tx: Tx, fn: () => Promise<T>, messages: Record<string, string>): Promise<T> {
  await tx.execute(sql`savepoint team_write`);
  try {
    const out = await fn();
    await tx.execute(sql`release savepoint team_write`);
    return out;
  } catch (err) {
    await tx.execute(sql`rollback to savepoint team_write`);
    const msg = messages[pgCode(err) ?? ''];
    if (msg) throw new AdminError(msg);
    throw err;
  }
}

/** A new team. Without a slug the database derives one from the name ('-2' … on a clash). */
export async function createTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { name: teamNameIn, slug } = parse(
    z.object({ name: name(), slug: z.preprocess((v) => (v === '' ? undefined : v), teamSlug.optional()) }),
    input,
  );
  const [t] = await guarded(
    tx,
    () => tx.insert(teams).values({ name: teamNameIn, slug: slug ?? '' }).returning({ id: teams.id, slug: teams.slug }),
    { '23505': 'A team with that name or slug already exists.' },
  );
  await audit(tx, actor, 'team.create', `team:${t!.id}`, { name: teamNameIn, slug: t!.slug });
  return `Team "${teamNameIn}" created (slug ${t!.slug}).`;
}

/** Renames the display name; the slug stays (ADR-0030 R4). */
export async function renameTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, name: newName } = parse(z.object({ teamId: id, name: name() }), input);
  const before = await loadTeam(tx, teamId);
  if (before.name === newName) return 'No changes.';
  await guarded(tx, () => tx.update(teams).set({ name: newName }).where(eq(teams.id, teamId)), { '23505': 'A team with that name already exists.' });
  await audit(tx, actor, 'team.rename', `team:${teamId}`, { before: before.name, after: newName });
  return 'Team renamed. The slug is unchanged.';
}

/**
 * Changes the slug that `.ai-obs.json` names. Allowed only while no turn references the team: the database trigger
 * teams_slug_immutable refuses later changes (ADR-0030 R4), so committed dot files keep working.
 */
export async function setTeamSlug(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, slug } = parse(z.object({ teamId: id, slug: teamSlug }), input);
  const before = await loadTeam(tx, teamId);
  if (before.slug === slug) return 'No changes.';
  await guarded(tx, () => tx.update(teams).set({ slug }).where(eq(teams.id, teamId)), {
    '23505': 'Another team already uses that slug.',
    '23514': `The slug "${before.slug}" is fixed: turns already reference this team. Rename the team instead.`,
  });
  await audit(tx, actor, 'team.slug', `team:${teamId}`, { before: before.slug, after: slug });
  return `Slug changed to ${slug}. Update any .ai-obs.json that named ${before.slug}.`;
}

/**
 * Only an empty team: no members. Teams with telemetry are kept by the DB (FK). The team's budgets go with it (FK
 * cascade) and its project mappings are cleared (set null); each is audited as `budget.delete` / `project.unmap`
 * (reason `team_deleted`) next to `team.delete`, so the log says what went.
 */
export async function deleteTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId } = parse(z.object({ teamId: id }), input);
  const before = await loadTeam(tx, teamId);
  const [use] = await rows<{ members: number }>(tx, sql`select count(*)::int as members from team_memberships where team_id = ${teamId}::uuid`);
  ensure(Number(use?.members) === 0, 'Remove all members first: only an empty team can be deleted.');
  const budgetRows = await rows<{ id: string; kind: string; limit: string; user_id: string | null }>(
    tx,
    sql`select id, kind::text as kind, limit_value::text as limit, user_id from budgets where team_id = ${teamId}::uuid order by created_at`,
  );
  const mapped = await rows<{ id: string; key: string }>(tx, sql`select id, key from projects where team_id = ${teamId}::uuid order by key`);
  await guarded(tx, () => tx.delete(teams).where(eq(teams.id, teamId)), {
    '23503': 'This team still has recorded turns, so it cannot be deleted. Rename it instead.',
  });
  for (const b of budgetRows) {
    await audit(tx, actor, 'budget.delete', `budget:${b.id}`, { kind: b.kind, limit: Number(b.limit), teamId, userId: b.user_id, reason: 'team_deleted' });
  }
  for (const p of mapped) {
    await audit(tx, actor, 'project.unmap', `project:${p.id}`, { before: teamId, after: null, reason: 'team_deleted' });
  }
  await audit(tx, actor, 'team.delete', `team:${teamId}`, {
    name: before.name,
    slug: before.slug,
    budgets: budgetRows.map((b) => b.id),
    projects: mapped.map((p) => p.key),
  });
  const extra = [
    budgetRows.length ? `${budgetRows.length} budget${budgetRows.length === 1 ? '' : 's'} removed` : '',
    mapped.length ? `${mapped.length} project mapping${mapped.length === 1 ? '' : 's'} cleared` : '',
  ].filter(Boolean);
  return `Team "${before.name}" deleted.${extra.length ? ` ${extra.join(', ')}.` : ''}`;
}

/** The user must hold a membership (a team member must be a member of the deployment, FK-enforced too). */
async function assertMember(tx: Tx, userId: string) {
  const [m] = await tx
    .select({ userId: memberships.userId, primaryTeamId: memberships.primaryTeamId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  if (!m) throw new AdminError('Member not found.');
  return m;
}

export async function addMember(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, userId, role } = parse(z.object({ teamId: id, userId: id, role: teamRole.default('member') }), input);
  const t = await loadTeam(tx, teamId);
  const u = await assertMember(tx, userId);
  const added = await tx.insert(teamMemberships).values({ teamId, userId, role }).onConflictDoNothing().returning({ id: teamMemberships.id });
  if (added.length === 0) return 'Already a member.';
  if (!u.primaryTeamId) await tx.update(memberships).set({ primaryTeamId: teamId }).where(eq(memberships.userId, userId));
  await audit(tx, actor, 'team.member_add', `team:${teamId}`, { userId, team: t.name, role });
  return 'Member added.';
}

/** Removing a person from a team moves their primary team to another of their teams (or none). Tokens have no team. */
export async function removeMember(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, userId } = parse(z.object({ teamId: id, userId: id }), input);
  const t = await loadTeam(tx, teamId);
  const u = await assertMember(tx, userId);
  const gone = await tx
    .delete(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)))
    .returning({ id: teamMemberships.id });
  ensure(gone.length === 1, 'Not a member of this team.');
  if (u.primaryTeamId === teamId) {
    const [other] = await tx.select({ teamId: teamMemberships.teamId }).from(teamMemberships).where(eq(teamMemberships.userId, userId)).limit(1);
    await tx.update(memberships).set({ primaryTeamId: other?.teamId ?? null }).where(eq(memberships.userId, userId));
  }
  await audit(tx, actor, 'team.member_remove', `team:${teamId}`, { userId, team: t.name });
  return 'Member removed.';
}

export async function setMemberRole(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { teamId, userId, role } = parse(z.object({ teamId: id, userId: id, role: teamRole }), input);
  const t = await loadTeam(tx, teamId);
  const done = await tx
    .update(teamMemberships)
    .set({ role })
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)))
    .returning({ id: teamMemberships.id });
  ensure(done.length === 1, 'Not a member of this team.');
  await audit(tx, actor, 'team.member_role', `team:${teamId}`, { userId, team: t.name, role });
  return role === 'lead' ? 'Now a team lead.' : 'Now a team member.';
}

/** The primary team is the fallback of team resolution (ADR-0030 R1); it must be one of the user's teams. */
export async function setPrimaryTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { userId, teamId } = parse(z.object({ userId: id, teamId: optionalId }), input);
  await assertMember(tx, userId);
  if (teamId) {
    const [m] = await tx
      .select({ id: teamMemberships.id })
      .from(teamMemberships)
      .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)));
    ensure(m, "The primary team must be one of the user's teams.");
  }
  await tx.update(memberships).set({ primaryTeamId: teamId }).where(eq(memberships.userId, userId));
  await audit(tx, actor, 'user.primary_team', `user:${userId}`, { teamId });
  return 'Primary team set.';
}
