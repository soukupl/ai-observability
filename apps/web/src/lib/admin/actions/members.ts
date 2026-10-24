'use server';

import { appUrl } from '../../auth/config';
import { getMailer } from '../../mail';
import { formObject } from '../input';
import { createInvitation, invitationEmail, INVITATION_TTL_DAYS, revokeInvitation } from '../invitations';
import { changeRole, removeMember } from '../members';
import { messageAction, runAdmin } from '../run';
import type { ActionState } from '../types';

export async function changeRoleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => changeRole(tx, u, formObject(fd)));
}
export async function removeMemberAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => removeMember(tx, u, formObject(fd)));
}
export async function revokeInvitationAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => revokeInvitation(tx, u, formObject(fd)));
}

/** Creates the invitation (committed first), then e-mails it; a mail failure keeps the invitation. */
export async function inviteAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await runAdmin('admin', (tx, u) => createInvitation(tx, u, formObject(fd)));
  if (!r.ok) return r.state;
  const login = new URL('/login', appUrl()).toString();
  try {
    await getMailer().send(invitationEmail(r.value, { appUrl: appUrl().toString(), inviter: r.user.name || r.user.email }));
  } catch (err) {
    console.error('[admin] invitation e-mail failed', err);
    return { status: 'ok', message: `Invitation created, but the e-mail could not be sent. Ask ${r.value.email} to sign in at ${login}.` };
  }
  return { status: 'ok', message: `Invitation sent to ${r.value.email}. It expires in ${INVITATION_TTL_DAYS} days.` };
}
