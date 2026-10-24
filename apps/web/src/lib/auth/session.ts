import type { DeploymentSettings, IndividualVisibility, MemberRole, ProjectNaming, TeamRole } from '@ai-obs/db';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { SESSION_COOKIE } from './config';
import { defaultAuthDeps, loadSessionUser } from './login';

/**
 * Auth CONTRACT used by every page and route handler (ADR-0013, ADR-0028): magic link + Google / GitHub
 * OAuth, sessions in auth_sessions (hashed id, 30-day sliding expiry, httpOnly cookie). One deployment = one
 * company, so the signed-in user carries the deployment and their role in it; there is no company switch.
 */
export type { DeploymentSettings, IndividualVisibility, MemberRole, ProjectNaming, TeamRole };

/** One team of the signed-in user (team_memberships), in name order. */
export interface UserTeam {
  id: string;
  slug: string;
  name: string;
  role: TeamRole;
}

/** The deployment row (one per database) as the dashboard sees it. */
export interface DeploymentInfo {
  id: string;
  name: string;
  slug: string;
  settings: DeploymentSettings;
}

/** The signed-in person (service users never log in). */
export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  /** memberships.role: 'admin' | 'member'. Lead is a per-team role (teams[].role). */
  role: MemberRole;
  teams: UserTeam[];
  /** memberships.primary_team_id. */
  primaryTeamId: string | null;
  deployment: DeploymentInfo;
}

/** The signed-in user, or null when there is no valid session (or the membership is gone). Cached per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return loadSessionUser(defaultAuthDeps(), token);
});

/** The signed-in user; redirects to /login when there is none. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/** An admin of the deployment; other users are sent to /overview. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== 'admin') redirect('/overview');
  return user;
}

/** Server action: `<form action={logout}>`. */
export { logout } from './actions';
