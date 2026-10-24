import { and, eq, sql } from 'drizzle-orm';
import { invitations, teams, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { invitationEmail as invitationMail, type MailMessage } from '../mail';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { loadDeployment } from './deployment';
import { id, memberRole, optionalId, parse, teamRole } from './input';
import { isAdmin } from './permissions';
import { ensure, type Actor, type MemberRole, type TeamRole } from './types';

export const INVITATION_TTL_DAYS = 7;

export interface PendingInvitation {
  id: string;
  email: string;
  teamName: string | null;
  teamRole: TeamRole;
  role: MemberRole;
  expiresMs: number;
  invitedBy: string | null;
}

/** Not yet accepted and not expired (RLS: admins only). `invitedBy` is null when the inviter is no longer a member. */
export async function listPendingInvitations(tx: Tx): Promise<PendingInvitation[]> {
  const list = await rows<{ id: string; email: string; team_name: string | null; team_role: TeamRole; role: MemberRole; expires_at: Date | string; invited_by: string | null }>(
    tx,
    sql`select i.id, i.email, t.name as team_name, i.team_role, i.role, i.expires_at, coalesce(u.name, u.email) as invited_by
        from invitations i left join teams t on t.id = i.team_id left join users u on u.id = i.invited_by_user_id
        where i.accepted_at is null and i.expires_at > now()
        order by i.created_at desc`,
  );
  return list.map((i) => ({
    id: i.id,
    email: i.email,
    teamName: i.team_name,
    teamRole: i.team_role,
    role: i.role,
    expiresMs: new Date(i.expires_at).getTime(),
    invitedBy: i.invited_by,
  }));
}

export const invitationInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email({ message: 'enter a valid e-mail address' })),
  teamId: optionalId,
  teamRole: teamRole.default('member'),
  role: memberRole.default('member'),
});

export interface CreatedInvitation {
  id: string;
  email: string;
  teamName: string | null;
  deploymentName: string;
  expiresAt: Date;
}

/**
 * Invites an e-mail address to the deployment, optionally into a team with a team role, with a membership role
 * (7-day expiry). The invitation is auto-accepted when that address signs in (ADR-0028 E7). Existing members are
 * added to teams on the Teams page instead. A newer invitation replaces a pending one for the same address.
 */
export async function createInvitation(tx: Tx, actor: Actor, input: unknown, now = new Date()): Promise<CreatedInvitation> {
  ensure(isAdmin(actor), 'Only admins can invite people.');
  const inv = parse(invitationInput, input);
  const dep = await loadDeployment(tx);
  const [existing] = await rows<{ user_id: string }>(
    tx,
    sql`select m.user_id from memberships m join users u on u.id = m.user_id where u.email = ${inv.email}`,
  );
  ensure(!existing, `${inv.email} is already a member. Add them to the team on the Teams page.`);
  const replaced = await tx
    .delete(invitations)
    .where(and(eq(invitations.email, inv.email), sql`${invitations.acceptedAt} is null`))
    .returning({ id: invitations.id, teamId: invitations.teamId, teamRole: invitations.teamRole, role: invitations.role });
  for (const r of replaced) {
    await audit(tx, actor, 'invitation.revoke', `invitation:${r.id}`, { email: inv.email, teamId: r.teamId, teamRole: r.teamRole, role: r.role, reason: 'replaced' });
  }
  let teamName: string | null = null;
  if (inv.teamId) {
    const [t] = await tx.select({ name: teams.name }).from(teams).where(eq(teams.id, inv.teamId));
    ensure(t, 'Team not found.');
    teamName = t.name;
  }
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000);
  const [row] = await tx
    .insert(invitations)
    .values({ email: inv.email, teamId: inv.teamId, teamRole: inv.teamRole, role: inv.role, invitedByUserId: actor.id, expiresAt })
    .returning({ id: invitations.id });
  await audit(tx, actor, 'invitation.create', `invitation:${row!.id}`, { email: inv.email, teamId: inv.teamId, teamRole: inv.teamRole, role: inv.role });
  return { id: row!.id, email: inv.email, teamName, deploymentName: dep.name, expiresAt };
}

export async function revokeInvitation(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only admins can revoke invitations.');
  const { invitationId } = parse(z.object({ invitationId: id }), input);
  const gone = await tx
    .delete(invitations)
    .where(and(eq(invitations.id, invitationId), sql`${invitations.acceptedAt} is null`))
    .returning({ email: invitations.email });
  ensure(gone.length === 1, 'Invitation not found.');
  await audit(tx, actor, 'invitation.revoke', `invitation:${invitationId}`, { email: gone[0]!.email });
  return `Invitation for ${gone[0]!.email} revoked.`;
}

/** The invitation e-mail: a link to the login page; signing in with the invited address joins the deployment. */
export function invitationEmail(inv: CreatedInvitation, opts: { appUrl: string; inviter: string }): MailMessage {
  return invitationMail(inv.email, {
    deploymentName: inv.deploymentName,
    inviter: opts.inviter,
    teamName: inv.teamName,
    loginUrl: new URL('/login', opts.appUrl).toString(),
    expiresInDays: INVITATION_TTL_DAYS,
  });
}
