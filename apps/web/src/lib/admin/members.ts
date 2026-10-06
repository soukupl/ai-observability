import { and, eq, sql } from 'drizzle-orm';
import { users, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { companyRole, id, parse } from './input';
import { isAdmin } from './permissions';
import { AdminError, ensure, type Actor, type CompanyRole, type TeamRole } from './types';

export interface MemberRow {
  id: string;
  name: string | null;
  email: string;
  companyRole: CompanyRole;
  primaryTeamId: string | null;
  lastLoginMs: number | null;
  teams: { id: string; name: string; role: TeamRole }[];
}

/** The company directory (readable by everyone in the company; this page is admin-only). */
export async function listMembers(tx: Tx, companyId: string): Promise<MemberRow[]> {
  const list = await rows<{ id: string; name: string | null; email: string; company_role: CompanyRole; primary_team_id: string | null; last_login_at: Date | string | null }>(
    tx,
    sql`select id, name, email, company_role, primary_team_id, last_login_at from users
        where company_id = ${companyId}::uuid order by lower(coalesce(name, email))`,
  );
  const memberships = await rows<{ user_id: string; team_id: string; team_name: string; role: TeamRole }>(
    tx,
    sql`select m.user_id, m.team_id, t.name as team_name, m.role from team_memberships m join teams t on t.id = m.team_id
        where m.company_id = ${companyId}::uuid order by lower(t.name)`,
  );
  return list.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    companyRole: u.company_role,
    primaryTeamId: u.primary_team_id,
    lastLoginMs: u.last_login_at ? new Date(u.last_login_at).getTime() : null,
    teams: memberships.filter((m) => m.user_id === u.id).map((m) => ({ id: m.team_id, name: m.team_name, role: m.role })),
  }));
}

async function loadUser(tx: Tx, companyId: string, userId: string) {
  const [u] = await tx
    .select({ id: users.id, email: users.email, companyRole: users.companyRole })
    .from(users)
    .where(and(eq(users.companyId, companyId), eq(users.id, userId)));
  if (!u) throw new AdminError('User not found.');
  return u;
}

/** Locks the admins so two concurrent demotions cannot remove the last one. */
async function adminCount(tx: Tx, companyId: string): Promise<number> {
  const list = await rows<{ id: string }>(tx, sql`select id from users where company_id = ${companyId}::uuid and company_role = 'admin' for update`);
  return list.length;
}

export async function changeCompanyRole(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only company admins can change roles.');
  const { userId, role } = parse(z.object({ userId: id, role: companyRole }), input);
  const u = await loadUser(tx, actor.companyId, userId);
  if (u.companyRole === role) return 'No changes.';
  if (u.companyRole === 'admin') ensure((await adminCount(tx, actor.companyId)) > 1, 'The company needs at least one admin.');
  await tx.update(users).set({ companyRole: role }).where(and(eq(users.companyId, actor.companyId), eq(users.id, userId)));
  await audit(tx, actor, 'user.role', `user:${userId}`, { email: u.email, before: u.companyRole, after: role });
  return `${u.email} is now ${role === 'admin' ? 'an admin' : 'a member'}.`;
}

/**
 * Removes a user (ADR-0012). The schema's foreign keys do the clean-up in the same statement:
 * agent_sessions, turns, runs, usage, machines, ingest tokens, memberships, budgets and login
 * sessions of the user are deleted (ON DELETE CASCADE), and daily_rollups.user_id is set to null
 * (ON DELETE SET NULL), so long-term aggregates survive anonymised. packages/db has no SQL function
 * for this; referential actions are not subject to RLS, so app_web needs no DELETE grant on telemetry.
 */
export async function removeUser(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only company admins can remove users.');
  const { userId } = parse(z.object({ userId: id }), input);
  ensure(userId !== actor.id, 'You cannot remove yourself. Ask another admin.');
  const u = await loadUser(tx, actor.companyId, userId);
  if (u.companyRole === 'admin') ensure((await adminCount(tx, actor.companyId)) > 1, 'The company needs at least one admin.');
  const gone = await tx.delete(users).where(and(eq(users.companyId, actor.companyId), eq(users.id, userId))).returning({ id: users.id });
  ensure(gone.length === 1, 'You are not allowed to remove this user.');
  await audit(tx, actor, 'user.remove', `user:${userId}`, { email: u.email });
  return `${u.email} removed. Their raw telemetry was deleted; daily rollups were kept without their name.`;
}
