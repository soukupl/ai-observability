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
  { href: '/flows', label: 'Agent flows', title: 'Multi-step sub-agent flows: steps, tokens, time, models, phases' },
  { href: '/skills-mcp', label: 'Skills & MCP', title: 'Which skills and MCP servers are used, and how often' },
  { href: '/sessions', label: 'Sessions', title: 'Harness sessions with their turns, workflows and flows' },
  { href: '/turns', label: 'Turns', title: 'Explore single turns with their run timeline' },
];
export const ADMIN_NAV: NavItem = { href: '/admin', label: 'Admin', title: 'Teams, members, tokens, settings, budgets' };
export const TOKENS_NAV: NavItem = { href: '/tokens', label: 'My tokens', title: 'Create and revoke your own ingest tokens' };
export const LEAD_NAV: NavItem = { href: '/admin/tokens', label: 'Company tokens', title: 'Company tokens and budgets' };
export const SUPER_NAV: NavItem = { href: '/super', label: 'Super admin', title: 'Companies and plans' };

/**
 * Links for a user: the dashboard views + "My tokens" for company users, + Admin for company admins (or
 * "Company tokens" for team leads, who reach only the token and budget pages), + Super for super admins.
 */
export function navFor(user: { companyRole: 'admin' | 'member'; isSuperAdmin: boolean; company: unknown | null; teams?: { role: string }[] }): NavItem[] {
  const items = user.company ? [...VIEW_NAV, TOKENS_NAV] : [];
  if (user.company && user.companyRole === 'admin') items.push(ADMIN_NAV);
  else if (user.company && user.teams?.some((t) => t.role === 'lead')) items.push(LEAD_NAV);
  if (user.isSuperAdmin) items.push(SUPER_NAV);
  return items;
}
