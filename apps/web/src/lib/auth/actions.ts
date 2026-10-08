'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from './config';
import { expiredCookieOptions } from './cookies';
import { acceptInvitationForSession, defaultAuthDeps, endSession, switchActiveCompany } from './login';

/** Signs out: deletes the auth_sessions row, writes auth.logout, clears the cookie. Server actions are origin-checked by Next. */
export async function logout(): Promise<void> {
  const jar = await cookies();
  await endSession(defaultAuthDeps(), jar.get(SESSION_COOKIE)?.value);
  jar.set(SESSION_COOKIE, '', expiredCookieOptions());
  redirect('/login');
}

/**
 * The header switcher (form field `companyId`): makes that company the session's active company when the
 * user is a member of it and it is active (checked in SQL, never trusted from the form). Session-wide, so
 * every tab follows; forms rendered for the previous company are refused (D10). Lands on /overview,
 * which drops company-scoped filter and detail ids.
 */
export async function switchCompany(fd: FormData): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  await switchActiveCompany(defaultAuthDeps(), token, fd.get('companyId'));
  revalidatePath('/', 'layout');
  redirect('/overview');
}

/** /invitations "Join <company>" (form field `invitationId`): joins it and switches the session there. */
export async function acceptInvitationForCurrentUser(fd: FormData): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const joined = await acceptInvitationForSession(defaultAuthDeps(), token, fd.get('invitationId'));
  if (!joined) redirect('/invitations?error=gone');
  revalidatePath('/', 'layout');
  redirect('/overview');
}
