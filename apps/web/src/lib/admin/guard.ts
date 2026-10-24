import { redirect } from 'next/navigation';
import { requireUser, type CurrentUser } from '../auth/session';
import { canEnterAdmin, isAdmin, isLead } from './permissions';

/** Admins and team leads (leads only reach /admin/budgets); others → /overview. */
export async function requireAdminOrLead(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!canEnterAdmin(user)) redirect('/overview');
  return user;
}

/** Admin-only pages: leads are sent to the budgets page, everyone else to /overview. */
export async function requireAdminPage(): Promise<CurrentUser> {
  const user = await requireAdminOrLead();
  if (!isAdmin(user)) redirect('/admin/budgets');
  return user;
}

export const ADMIN_TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/teams', label: 'Teams' },
  { href: '/admin/members', label: 'Members' },
  { href: '/admin/invitations', label: 'Invitations' },
  { href: '/admin/service-users', label: 'Service users' },
  { href: '/admin/tokens', label: 'Tokens' },
  { href: '/admin/projects', label: 'Projects' },
  { href: '/admin/budgets', label: 'Budgets' },
  { href: '/admin/model-prices', label: 'Model prices' },
  { href: '/admin/audit', label: 'Audit log' },
] as const;

const LEAD_TABS = new Set<string>(['/admin/budgets']);

export function adminTabsFor(user: Pick<CurrentUser, 'id' | 'role' | 'teams'>): { href: string; label: string }[] {
  return ADMIN_TABS.filter((t) => isAdmin(user) || (isLead(user) && LEAD_TABS.has(t.href)));
}
