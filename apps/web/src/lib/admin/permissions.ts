import type { Actor } from './types';

/**
 * Pure permission rules of the admin console (BRIEF §4, ADR-0029 T8). They decide what the UI offers and guard
 * every server action; RLS enforces the same rules again in the database (ADR-0006, ADR-0028).
 */
export const isAdmin = (a: Actor): boolean => a.role === 'admin';
export const ledTeamIds = (a: Actor): string[] => a.teams.filter((t) => t.role === 'lead').map((t) => t.id);
export const isLead = (a: Actor): boolean => ledTeamIds(a).length > 0;
export const leadsTeam = (a: Actor, teamId: string): boolean => ledTeamIds(a).includes(teamId);
export const memberOf = (a: Actor, teamId: string): boolean => a.teams.some((t) => t.id === teamId);

/** /admin is for admins; leads reach only the budgets page (read-only, their teams). */
export const canEnterAdmin = (a: Actor): boolean => isAdmin(a) || isLead(a);

/** Users revoke their own tokens; admins revoke every token, person and service (ADR-0029 T8, ADR-0022 D6). */
export function canRevokeToken(a: Actor, t: { userId: string }): boolean {
  return isAdmin(a) || t.userId === a.id;
}

/** Admins create tokens only for service users; a person's token is created by that person (ADR-0029 T8). */
export function canCreateTokenFor(a: Actor, target: { id: string; kind: 'person' | 'service' }): boolean {
  if (target.id === a.id) return true;
  return isAdmin(a) && target.kind === 'service';
}

export const canManageBudgets = isAdmin;
