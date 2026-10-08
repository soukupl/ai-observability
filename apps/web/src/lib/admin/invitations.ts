import { and, eq, sql } from 'drizzle-orm';
import { invitations, teams, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import type { MailMessage } from '../mail';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { companyCounts, loadCompany } from './company';
import { companyRole, id, optionalId, parse, teamRole } from './input';
import { isAdmin } from './permissions';
import { capacityError } from './plans';
import { AdminError, ensure, type Actor, type CompanyRole, type TeamRole } from './types';

export const INVITATION_TTL_DAYS = 7;

export interface PendingInvitation {
  id: string;
  email: string;
  teamName: string | null;
  teamRole: TeamRole;
  companyRole: CompanyRole;
  expiresMs: number;
  invitedBy: string | null;
}

/** Not yet accepted and not expired (RLS: admins only). `invitedBy` is null when the inviter is no longer a member. */
export async function listPendingInvitations(tx: Tx, companyId: string): Promise<PendingInvitation[]> {
  const list = await rows<{ id: string; email: string; team_name: string | null; team_role: TeamRole; company_role: CompanyRole; expires_at: Date | string; invited_by: string | null }>(
    tx,
    sql`select i.id, i.email, t.name as team_name, i.team_role, i.company_role, i.expires_at, coalesce(u.name, u.email) as invited_by
        from invitations i left join teams t on t.id = i.team_id left join users u on u.id = i.invited_by_user_id
        where i.company_id = ${companyId}::uuid and i.accepted_at is null and i.expires_at > now()
        order by i.created_at desc`,
  );
  return list.map((i) => ({
    id: i.id,
    email: i.email,
    teamName: i.team_name,
    teamRole: i.team_role,
    companyRole: i.company_role,
    expiresMs: new Date(i.expires_at).getTime(),
    invitedBy: i.invited_by,
  }));
}

export const invitationInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email({ message: 'enter a valid e-mail address' })),
  teamId: optionalId,
  teamRole: teamRole.default('member'),
  companyRole: companyRole.default('member'),
});

export interface CreatedInvitation {
  id: string;
  email: string;
  teamName: string | null;
  companyName: string;
  expiresAt: Date;
}

/**
 * Invites an e-mail address (7-day expiry). A new address sees it on the /signup step; an existing
 * account (also one in another company) sees it at /invitations and joins explicitly
 * (auth_pending_invitations / auth_accept_invitation, SEC-1). A newer invitation replaces a pending
 * one for the same address. The member limit counts memberships of this company + pending invitations.
 */
export async function createInvitation(tx: Tx, actor: Actor, input: unknown, now = new Date()): Promise<CreatedInvitation> {
  ensure(isAdmin(actor), 'Only company admins can invite people.');
  const inv = parse(invitationInput, input);
  const company = await loadCompany(tx, actor.companyId, true);
  const [existing] = await rows<{ user_id: string }>(
    tx,
    sql`select m.user_id from company_memberships m join users u on u.id = m.user_id where m.company_id = ${actor.companyId}::uuid and u.email = ${inv.email}`,
  );
  ensure(!existing, `${inv.email} is already a member.`);
  await tx.delete(invitations).where(and(eq(invitations.companyId, actor.companyId), eq(invitations.email, inv.email), sql`${invitations.acceptedAt} is null`));
  const counts = await companyCounts(tx, actor.companyId);
  const limitErr = capacityError(company.plan, 'users', counts.users + counts.pendingInvitations);
  if (limitErr) throw new AdminError(limitErr);
  let teamName: string | null = null;
  if (inv.teamId) {
    const [t] = await tx.select({ name: teams.name }).from(teams).where(and(eq(teams.companyId, actor.companyId), eq(teams.id, inv.teamId)));
    ensure(t, 'Team not found.');
    teamName = t.name;
  }
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000);
  const [row] = await tx
    .insert(invitations)
    .values({ companyId: actor.companyId, email: inv.email, teamId: inv.teamId, teamRole: inv.teamRole, companyRole: inv.companyRole, invitedByUserId: actor.id, expiresAt })
    .returning({ id: invitations.id });
  await audit(tx, actor, 'invitation.create', `invitation:${row!.id}`, {
    email: inv.email,
    teamId: inv.teamId,
    teamRole: inv.teamRole,
    companyRole: inv.companyRole,
  });
  return { id: row!.id, email: inv.email, teamName, companyName: company.name, expiresAt };
}

export async function revokeInvitation(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only company admins can revoke invitations.');
  const { invitationId } = parse(z.object({ invitationId: id }), input);
  const gone = await tx
    .delete(invitations)
    .where(and(eq(invitations.companyId, actor.companyId), eq(invitations.id, invitationId), sql`${invitations.acceptedAt} is null`))
    .returning({ email: invitations.email });
  ensure(gone.length === 1, 'Invitation not found.');
  await audit(tx, actor, 'invitation.revoke', `invitation:${invitationId}`, { email: gone[0]!.email });
  return `Invitation for ${gone[0]!.email} revoked.`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The invitation e-mail: a link to the login page (then Invitations for an existing account); signing in with the invited address lets the person join. */
export function invitationEmail(inv: CreatedInvitation, opts: { appUrl: string; inviter: string }): MailMessage {
  const login = new URL('/login?next=/invitations', opts.appUrl).toString();
  const team = inv.teamName ? ` (team ${inv.teamName})` : '';
  const expires = inv.expiresAt.toISOString().slice(0, 10);
  return {
    to: inv.email,
    subject: `You are invited to ${inv.companyName} on ai-obs`,
    text:
      `${opts.inviter} invited you to ${inv.companyName}${team} on ai-obs.\n\n` +
      `Sign in with this e-mail address (${inv.email}) to accept:\n${login}\n\n` +
      `Already using ai-obs with this address? Sign in and open Invitations to join.\n\nThe invitation expires on ${expires} (UTC).\n`,
    html:
      `<p>${esc(opts.inviter)} invited you to <b>${esc(inv.companyName)}</b>${esc(team)} on ai-obs.</p>` +
      `<p>Sign in with this e-mail address (${esc(inv.email)}) to accept: <a href="${esc(login)}">${esc(login)}</a></p>` +
      `<p>Already using ai-obs with this address? Sign in and open Invitations to join.</p>` +
      `<p>The invitation expires on ${expires} (UTC).</p>`,
  };
}
