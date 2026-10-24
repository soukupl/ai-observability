/** Sidebar entries of the dashboard views (BRIEF §8). Admin (or Budgets for leads) is added by role. */
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
export const ADMIN_NAV: NavItem = { href: '/admin', label: 'Admin', title: 'Settings, teams, members, tokens, service users, budgets' };
export const TOKENS_NAV: NavItem = { href: '/tokens', label: 'My tokens', title: 'Your collector logins and tokens: create, see expiry, revoke' };
/** Team leads reach only the budgets of their teams under /admin (ADR-0029 T8: no tokens page for leads). */
export const LEAD_NAV: NavItem = { href: '/admin/budgets', label: 'Budgets', title: 'Monthly budgets of the teams you lead' };

/** Links for a user: the dashboard views + "My tokens", + Admin for admins, or Budgets for team leads. */
export function navFor(user: { role: 'admin' | 'member'; teams?: { role: string }[] }): NavItem[] {
  const items = [...VIEW_NAV, TOKENS_NAV];
  if (user.role === 'admin') items.push(ADMIN_NAV);
  else if (user.teams?.some((t) => t.role === 'lead')) items.push(LEAD_NAV);
  return items;
}
