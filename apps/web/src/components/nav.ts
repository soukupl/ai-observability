/** Sidebar entries of the dashboard views (BRIEF §8). Admin and Super are added by AppShell by role. */
export interface NavItem {
  href: string;
  label: string;
  /** Short hint shown as tooltip. */
  title: string;
}

export const VIEW_NAV: readonly NavItem[] = [
  { href: '/overview', label: 'Overview', title: 'Turns, tokens, cost and success at a glance' },
  { href: '/projects', label: 'Projects', title: 'Usage per project' },
  { href: '/models', label: 'Models & effort', title: 'Cost, tokens and success per model and effort level' },
  { href: '/phases', label: 'Phases', title: 'Where the time goes: thinking, coding, testing, …' },
  { href: '/agents', label: 'Agents', title: 'Sub-agent usage' },
  { href: '/turns', label: 'Turns', title: 'Explore single turns with their run timeline' },
];
export const ADMIN_NAV: NavItem = { href: '/admin', label: 'Admin', title: 'Teams, members, tokens, settings, budgets' };
export const TOKENS_NAV: NavItem = { href: '/tokens', label: 'My tokens', title: 'Create and revoke your own ingest tokens' };
export const LEAD_NAV: NavItem = { href: '/admin/tokens', label: 'Team tokens', title: 'Tokens and budgets of the teams you lead' };
export const SUPER_NAV: NavItem = { href: '/super', label: 'Super admin', title: 'Companies and plans' };

/**
 * Links for a user: the dashboard views + "My tokens" for company users, + Admin for company admins (or
 * "Team tokens" for team leads, who reach only the token and budget pages), + Super for super admins.
 */
export function navFor(user: { companyRole: 'admin' | 'member'; isSuperAdmin: boolean; company: unknown | null; teams?: { role: string }[] }): NavItem[] {
  const items = user.company ? [...VIEW_NAV, TOKENS_NAV] : [];
  if (user.company && user.companyRole === 'admin') items.push(ADMIN_NAV);
  else if (user.company && user.teams?.some((t) => t.role === 'lead')) items.push(LEAD_NAV);
  if (user.isSuperAdmin) items.push(SUPER_NAV);
  return items;
}
