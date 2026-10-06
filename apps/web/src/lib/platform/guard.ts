import { notFound } from 'next/navigation';
import { getCurrentUser, type CurrentUser } from '../auth/session';

/**
 * Guard for every /super page, route and server action: only a platform super admin gets through.
 * Anyone else (signed out, company user) gets a 404, so the console's existence is not revealed.
 * Layouts do not re-run on every client navigation and server actions are public POST endpoints,
 * so pages and actions call this themselves.
 */
export async function requireSuperAdminOr404(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user || !user.isSuperAdmin) notFound();
  return user;
}
