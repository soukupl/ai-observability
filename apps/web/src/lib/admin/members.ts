import { eq, sql } from 'drizzle-orm';
import { memberships, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { id, memberRole, parse } from './input';
import { isAdmin } from './permissions';
import { AdminError, ensure, type Actor, type MemberRole, type TeamRole } from './types';

export interface MemberRow {
  id: string;
  name: string | null;
  email: string;
  role: MemberRole;
  primaryTeamId: string | null;
  joinedMs: number;
  teams: { id: string; name: string; role: TeamRole }[];
}

/** The people with a membership (service users are listed on their own page). The directory is member-readable. */
export async function listMembers(tx: Tx): Promise<MemberRow[]> {
  const list = await rows<{ id: string; name: string | null; email: string; role: MemberRole; primary_team_id: string | null; created_at: Date | string }>(
    tx,
    sql`select u.id, u.name, u.email, m.role, m.primary_team_id, m.created_at
        from memberships m join users u on u.id = m.user_id
        where u.kind = 'person' order by lower(coalesce(u.name, u.email))`,
  );
  const tms = await rows<{ user_id: string; team_id: string; team_name: string; role: TeamRole }>(
    tx,
    sql`select m.user_id, m.team_id, t.name as team_name, m.role from team_memberships m join teams t on t.id = m.team_id order by lower(t.name)`,
  );
  return list.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    primaryTeamId: u.primary_team_id,
    joinedMs: new Date(u.created_at).getTime(),
    teams: tms.filter((m) => m.user_id === u.id).map((m) => ({ id: m.team_id, name: m.team_name, role: m.role })),
  }));
}

async function loadMember(tx: Tx, userId: string) {
  const [u] = await rows<{ id: string; email: string | null; name: string | null; kind: 'person' | 'service'; role: MemberRole }>(
    tx,
    sql`select u.id, u.email, u.name, u.kind, m.role from memberships m join users u on u.id = m.user_id where m.user_id = ${userId}::uuid`,
  );
  if (!u) throw new AdminError('Member not found.');
  return u;
}

/** Locks the admins so two concurrent demotions cannot remove the last one. */
async function adminCount(tx: Tx): Promise<number> {
  const list = await rows<{ user_id: string }>(tx, sql`select user_id from memberships where role = 'admin' for update`);
  return list.length;
}

export async function changeRole(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only admins can change roles.');
  const { userId, role } = parse(z.object({ userId: id, role: memberRole }), input);
  const u = await loadMember(tx, userId);
  ensure(u.kind === 'person', 'Service users are always members.');
  if (u.role === role) return 'No changes.';
  if (u.role === 'admin') ensure((await adminCount(tx)) > 1, 'The deployment needs at least one admin.');
  await tx.update(memberships).set({ role }).where(eq(memberships.userId, userId));
  await audit(tx, actor, 'user.role', `user:${userId}`, { email: u.email, before: u.role, after: role });
  return `${u.email} is now ${role === 'admin' ? 'an admin' : 'a member'}.`;
}

/**
 * Removes a member (ADR-0022 D1/D2/D8, kept by ADR-0028 E2). The SECURITY DEFINER function `admin_remove_member`
 * revokes their tokens, ends their dashboard sessions and deletes the membership (their team memberships and
 * per-user budgets go with it). Their recorded activity stays and is shown as "former member". They can come back
 * only through a new invitation.
 */
export async function removeMember(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only admins can remove members.');
  const { userId } = parse(z.object({ userId: id }), input);
  ensure(userId !== actor.id, 'You cannot remove yourself. Ask another admin.');
  const u = await loadMember(tx, userId);
  ensure(u.kind === 'person', 'Disable service users on the Service users page.');
  if (u.role === 'admin') ensure((await adminCount(tx)) > 1, 'The deployment needs at least one admin.');
  const revoked = await rows<{ token_id: string; token_name: string; token_prefix: string }>(tx, sql`select * from admin_remove_member(${userId}::uuid)`);
  for (const t of revoked) {
    await audit(tx, actor, 'token.revoke', `token:${t.token_id}`, { name: t.token_name, prefix: t.token_prefix, userId, reason: 'member removed' });
  }
  await audit(tx, actor, 'user.remove', `user:${userId}`, { email: u.email, revokedTokens: revoked.length });
  return (
    `${u.email} removed. ${revoked.length} token(s) revoked. ` +
    "Their past activity stays in the dashboard as 'former member'. A new invitation lets them back in."
  );
}
