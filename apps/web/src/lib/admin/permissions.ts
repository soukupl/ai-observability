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
 * User tokens: always for yourself, in a team you belong to (admins: any team).
 * Team tokens: admins for any team, leads for the teams they lead.
 */
export function canCreateToken(a: Actor, kind: 'user' | 'team', teamId: string): boolean {
  if (kind === 'user') return isAdmin(a) || memberOf(a, teamId);
  return isAdmin(a) || leadsTeam(a, teamId);
}

/** Teams in which `a` may create a token of `kind` (admins: all of `allTeamIds`). */
export function tokenTeams(a: Actor, kind: 'user' | 'team', allTeamIds: string[]): string[] {
  return allTeamIds.filter((id) => canCreateToken(a, kind, id));
}

export interface TokenOwner {
  kind: 'user' | 'team';
  teamId: string;
  userId: string | null;
}

/** Own user tokens; team tokens of led teams; admins everything. */
export function canRevokeToken(a: Actor, t: TokenOwner): boolean {
  if (isAdmin(a)) return true;
  if (t.kind === 'user') return t.userId === a.id;
  return leadsTeam(a, t.teamId);
}

export const canManageBudgets = isAdmin;
