'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from './config';
import { expiredCookieOptions } from './cookies';
import { defaultAuthDeps, endSession } from './login';

/** Signs out: deletes the auth_sessions row, writes auth.logout, clears the cookie. Server actions are origin-checked by Next. */
export async function logout(): Promise<void> {
  const jar = await cookies();
  await endSession(defaultAuthDeps(), jar.get(SESSION_COOKIE)?.value);
  jar.set(SESSION_COOKIE, '', expiredCookieOptions());
  redirect('/login');
}
