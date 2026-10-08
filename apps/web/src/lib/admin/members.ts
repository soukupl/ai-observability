import { and, eq, sql } from 'drizzle-orm';
import { companyMemberships, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { companyRole, id, parse } from './input';
import { isAdmin } from './permissions';
import { revokeStrandedCompanyTokens, strandedMessage } from './tokens';
import { AdminError, ensure, type Actor, type CompanyRole, type TeamRole } from './types';

export interface MemberRow {
  id: string;
  name: string | null;
  email: string;
  companyRole: CompanyRole;
  primaryTeamId: string | null;
  /** Last time the person worked in THIS company (membership.last_active_at; users.last_login_at is not readable). */
  lastActiveMs: number | null;
  teams: { id: string; name: string; role: TeamRole }[];
}

/** The members of the active company (readable by everyone in it; this page is admin-only). */
export async function listMembers(tx: Tx, companyId: string): Promise<MemberRow[]> {
  const list = await rows<{ id: string; name: string | null; email: string; company_role: CompanyRole; primary_team_id: string | null; last_active_at: Date | string | null }>(
    tx,
    sql`select u.id, u.name, u.email, m.company_role, m.primary_team_id, m.last_active_at
        from company_memberships m join users u on u.id = m.user_id
        where m.company_id = ${companyId}::uuid order by lower(coalesce(u.name, u.email))`,
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
    lastActiveMs: u.last_active_at ? new Date(u.last_active_at).getTime() : null,
    teams: memberships.filter((m) => m.user_id === u.id).map((m) => ({ id: m.team_id, name: m.team_name, role: m.role })),
  }));
}

async function loadMember(tx: Tx, companyId: string, userId: string) {
  const [u] = await rows<{ id: string; email: string; company_role: CompanyRole }>(
    tx,
    sql`select u.id, u.email, m.company_role from company_memberships m join users u on u.id = m.user_id
        where m.company_id = ${companyId}::uuid and m.user_id = ${userId}::uuid`,
  );
  if (!u) throw new AdminError('Member not found.');
  return { id: u.id, email: u.email, companyRole: u.company_role };
}

/** Locks the admins so two concurrent demotions cannot remove the last one. */
async function adminCount(tx: Tx, companyId: string): Promise<number> {
  const list = await rows<{ user_id: string }>(tx, sql`select user_id from company_memberships where company_id = ${companyId}::uuid and company_role = 'admin' for update`);
  return list.length;
}

export async function changeCompanyRole(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only company admins can change roles.');
  const { userId, role } = parse(z.object({ userId: id, role: companyRole }), input);
  const u = await loadMember(tx, actor.companyId, userId);
  if (u.companyRole === role) return 'No changes.';
  if (u.companyRole === 'admin') ensure((await adminCount(tx, actor.companyId)) > 1, 'The company needs at least one admin.');
  await tx
    .update(companyMemberships)
    .set({ companyRole: role })
    .where(and(eq(companyMemberships.companyId, actor.companyId), eq(companyMemberships.userId, userId)));
  await audit(tx, actor, 'user.role', `user:${userId}`, { email: u.email, before: u.companyRole, after: role });
  const base = `${u.email} is now ${role === 'admin' ? 'an admin' : 'a member'}.`;
  if (role === 'admin') return base;
  // D2/Q9: the person may no longer be allowed to mint company tokens (admin -> member, unless they still lead a team).
  const revoked = await revokeStrandedCompanyTokens(tx, actor, userId, 'creator no longer admin or lead');
  return base + strandedMessage(revoked);
}

/**
 * Removes a member from the active company (ADR-0022, D1/D2/D8). One SECURITY DEFINER function
 * (`admin_remove_member`) revokes their user tokens and the company tokens they created here, clears
 * their sessions' active company and deletes the membership (their team memberships and per-user
 * budgets here go with it). Nothing else is deleted: their recorded activity in this company stays and
 * is shown as "former member". Their account and their other companies are unaffected.
 */
export async function removeMember(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only company admins can remove members.');
  const { userId } = parse(z.object({ userId: id }), input);
  ensure(userId !== actor.id, 'You cannot remove yourself. Ask another admin.');
  const u = await loadMember(tx, actor.companyId, userId);
  if (u.companyRole === 'admin') ensure((await adminCount(tx, actor.companyId)) > 1, 'The company needs at least one admin.');
  const [company] = await rows<{ name: string }>(tx, sql`select name from companies where id = ${actor.companyId}::uuid`);
  const revoked = await rows<{ token_id: string; token_kind: 'user' | 'company'; token_name: string; token_prefix: string }>(
    tx,
    sql`select * from admin_remove_member(${userId}::uuid)`,
  );
  for (const t of revoked) {
    await audit(tx, actor, 'token.revoke', `token:${t.token_id}`, { kind: t.token_kind, name: t.token_name, prefix: t.token_prefix, userId, reason: 'member removed from company' });
  }
  await audit(tx, actor, 'user.remove', `user:${userId}`, { email: u.email, scope: 'company', revokedTokens: revoked.length });
  return (
    `${u.email} removed from ${company?.name ?? 'the company'}. ${revoked.length} token(s) revoked (their user tokens and the company tokens they created here). ` +
    "Their past activity in this company stays in the dashboard as 'former member'. Their account and other companies are unaffected."
  );
}
