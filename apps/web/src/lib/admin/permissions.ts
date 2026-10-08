import type { Actor } from './types';

/**
 * Pure permission rules of the admin console (BRIEF §4). They decide what the UI offers and guard
 * every server action; RLS enforces the same rules again in the database (ADR-0006).
 */
export const isAdmin = (a: Actor): boolean => a.companyRole === 'admin';
export const ledTeamIds = (a: Actor): string[] => a.teams.filter((t) => t.role === 'lead').map((t) => t.id);
export const isLead = (a: Actor): boolean => ledTeamIds(a).length > 0;
export const leadsTeam = (a: Actor, teamId: string): boolean => ledTeamIds(a).includes(teamId);
export const memberOf = (a: Actor, teamId: string): boolean => a.teams.some((t) => t.id === teamId);

/** /admin is for admins; leads reach the token and budget pages only. */
export const canEnterAdmin = (a: Actor): boolean => isAdmin(a) || isLead(a);

/**
 * Token kinds (ADR-0022, brief Q2/Q9). User tokens: anyone, for themselves, in the active company.
 * Company tokens (CI, bots, MDM rollout): company admins and leads of any team.
 */
export function canCreateToken(a: Actor, kind: 'user' | 'company'): boolean {
  return kind === 'user' || isAdmin(a) || isLead(a);
}

export interface TokenOwner {
  kind: 'user' | 'company';
  userId: string | null;
}

/** Admins: every token of the company (D6). Own user tokens. Company tokens: leads. */
export function canRevokeToken(a: Actor, t: TokenOwner): boolean {
  if (isAdmin(a)) return true;
  if (t.kind === 'user') return t.userId === a.id;
  return isLead(a);
}

export const canManageBudgets = isAdmin;
