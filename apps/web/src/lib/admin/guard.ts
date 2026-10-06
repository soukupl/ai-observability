import { redirect } from 'next/navigation';
import { requireUser, type CompanyUser } from '../auth/session';
import { canEnterAdmin, isAdmin } from './permissions';

/** Admins and team leads (leads only reach /admin/tokens and /admin/budgets); others → /overview. */
export async function requireAdminOrLead(): Promise<CompanyUser> {
  const user = await requireUser();
  if (!canEnterAdmin(user)) redirect('/overview');
  return user;
}

/** Admin-only pages: leads are sent to the token page, everyone else to /overview. */
export async function requireAdminPage(): Promise<CompanyUser> {
  const user = await requireAdminOrLead();
  if (!isAdmin(user)) redirect('/admin/tokens');
  return user;
}

export const ADMIN_TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/teams', label: 'Teams' },
  { href: '/admin/members', label: 'Members' },
  { href: '/admin/tokens', label: 'Tokens' },
  { href: '/admin/projects', label: 'Projects' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/budgets', label: 'Budgets' },
  { href: '/admin/audit', label: 'Audit log' },
] as const;

const LEAD_TABS = new Set(['/admin/tokens', '/admin/budgets']);

export function adminTabsFor(user: CompanyUser): { href: string; label: string }[] {
  return ADMIN_TABS.filter((t) => isAdmin(user) || LEAD_TABS.has(t.href));
}
