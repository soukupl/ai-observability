import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { SESSION_COOKIE } from './config';
import { defaultAuthDeps, loadSessionUser } from './login';

/**
 * Auth CONTRACT used by every page and route handler (ADR-0013): magic link + Google / GitHub
 * OAuth, sessions in auth_sessions (hashed id, 30-day sliding expiry, httpOnly cookie).
 */
export type CompanyRole = 'admin' | 'member';
export type TeamRole = 'member' | 'lead';
export type Plan = 'free' | 'team' | 'business';
export type IndividualVisibility = 'aggregates-only' | 'full';
export type ProjectNaming = 'plain' | 'hashed';

export interface CompanySettings {
  individualVisibility: IndividualVisibility;
  projectNaming: ProjectNaming;
  retentionDays: number;
}

/** One company the user belongs to, as the header switcher shows it. */
export interface MembershipSummary {
  companyId: string;
  name: string;
  slug: string;
  role: CompanyRole;
  plan: Plan;
}

/**
 * The signed-in user, working in the session's ACTIVE company (auth_sessions.active_company_id,
 * validated against the memberships on every request, ADR-0022). The flat company fields describe
 * that company.
 */
export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  /** The active company; null only for platform super admins, who belong to no company (BRIEF §4). */
  companyId: string | null;
  /** Role in the active company ('member' when there is none). */
  companyRole: CompanyRole;
  isSuperAdmin: boolean;
  /** Teams in the active company. */
  teams: { id: string; name: string; role: TeamRole }[];
  /** Primary team in the active company (from the membership). */
  primaryTeamId: string | null;
  /** The active company; null only for platform super admins. */
  company: { id: string; name: string; slug: string; plan: Plan; settings: CompanySettings } | null;
  /** Every membership in an active (not suspended) company, last used first. [] for super admins. */
  memberships: MembershipSummary[];
}

/** A user of a company — what requireUser() / requireAdmin() return (never a company-less super admin). */
export type CompanyUser = CurrentUser & { companyId: string; company: NonNullable<CurrentUser['company']> };

/** The signed-in user, or null when there is no valid session. Cached per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const loaded = await loadSessionUser(defaultAuthDeps(), token);
  if (!loaded) return null;
  const { user, context, memberships } = loaded;
  return {
    id: user.userId,
    email: user.email,
    name: user.name,
    companyId: user.companyId,
    companyRole: user.companyRole,
    isSuperAdmin: user.isSuperAdmin,
    teams: context?.teams ?? [],
    primaryTeamId: context?.primaryTeamId ?? null,
    company: context ? { ...context.company, settings: context.company.settings as unknown as CompanySettings } : null,
    memberships,
  };
});

export function isCompanyUser(user: CurrentUser | null): user is CompanyUser {
  return !!user && !!user.companyId && !!user.company;
}

/** The signed-in company user; redirects to /login when there is none (super admins go to /super). */
export async function requireUser(): Promise<CompanyUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!isCompanyUser(user)) redirect('/super');
  return user;
}

/** A company admin; other users are sent to /overview. */
export async function requireAdmin(): Promise<CompanyUser> {
  const user = await requireUser();
  if (user.companyRole !== 'admin') redirect('/overview');
  return user;
}

/** A platform super admin; other users are sent to /overview. */
export async function requireSuperAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!user.isSuperAdmin) redirect('/overview');
  return user;
}

/** Server actions: `<form action={logout}>`, the company switcher and accepting an invitation while signed in. */
export { acceptInvitationForCurrentUser, logout, switchCompany } from './actions';
