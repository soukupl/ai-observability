import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '@ai-obs/db';
import { projectKeyKind, type BatchHeader, type ProjectNamingMode, type ProjectRef } from '@ai-obs/protocol';
import { rows, type Attribution, type BatchContext, type TokenContext } from './context';

/*
 * Identity resolution for one batch: user + attribution, machine, project, team. Collector ids are
 * namespaced by harness (`<harness>:<id>`) so two harnesses can never collide on a session or turn id.
 */

export const sessionKey = (harness: string, sessionId: string) => `${harness}:${sessionId}`;
export const turnKey = (harness: string, turnId: string) => `${harness}:${turnId}`;

/**
 * Team attribution of a turn, first match wins (BRIEF §4): the company's project → team mapping,
 * the token's team, the user's primary team.
 */
export function resolveTeam(input: {
  projectTeamId: string | null | undefined;
  tokenTeamId: string | null | undefined;
  primaryTeamId: string | null | undefined;
}): string | null {
  return input.projectTeamId || input.tokenTeamId || input.primaryTeamId || null;
}

/**
 * The project key and display name to store. Hashed keys never get a display name (the name would
 * undo the hashing). In hashed mode a plain key from a stale collector is hashed here and its name
 * dropped; collectors must hash the same way (`sha256:` + hex SHA-256 of the normalized key) so both
 * paths land on one project.
 */
export function effectiveProject(project: ProjectRef, naming: ProjectNamingMode): { key: string; name: string | null } {
  if (projectKeyKind(project.key) === 'hashed') return { key: project.key, name: null };
  if (naming === 'hashed') return { key: hashProjectKey(project.key), name: null };
  return { key: project.key, name: project.name ?? null };
}

export function hashProjectKey(key: string): string {
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/**
 * User token → the token's user (verified). Team token → the user whose e-mail equals the batch's
 * git e-mail AND who belongs to the token's team (matched; SEC-10), else no user (unverified).
 */
export async function resolveAttribution(
  tx: Tx,
  token: TokenContext,
  gitEmail: string | undefined,
): Promise<{ userId: string | null; attribution: Attribution; primaryTeamId: string | null }> {
  if (token.kind === 'user' && token.userId) {
    return { userId: token.userId, attribution: 'verified', primaryTeamId: token.userPrimaryTeamId };
  }
  if (gitEmail) {
    const [m] = await rows<{ user_id: string; primary_team_id: string | null }>(
      tx,
      sql`select * from ingest_match_user_by_email(${gitEmail}, ${token.teamId}::uuid)`,
    );
    if (m) return { userId: m.user_id, attribution: 'matched', primaryTeamId: m.primary_team_id };
  }
  return { userId: null, attribution: 'unverified', primaryTeamId: null };
}

/** Upserts the sending machine; never clears a known user. Returns machines.id. */
export async function upsertMachine(
  tx: Tx,
  companyId: string,
  machine: BatchHeader['machine'],
  userId: string | null,
): Promise<string> {
  const [row] = await rows<{ id: string }>(
    tx,
    sql`insert into machines (company_id, user_id, machine_id, os)
        values (${companyId}::uuid, ${userId}::uuid, ${machine.id}, ${machine.os})
        on conflict (company_id, machine_id) do update
          set os = ${machine.os}, last_seen_at = now(), user_id = coalesce(${userId}::uuid, machines.user_id)
        returning id`,
  );
  return row!.id;
}

/**
 * Upserts a project by key. The display name is only set on insert, so an admin's rename sticks.
 * Returns projects.id and its mapped team.
 */
export async function upsertProject(
  tx: Tx,
  ctx: BatchContext,
  project: ProjectRef,
): Promise<{ id: string; teamId: string | null }> {
  const { key, name } = effectiveProject(project, ctx.token.projectNaming);
  const [row] = await rows<{ id: string; team_id: string | null }>(
    tx,
    sql`insert into projects (company_id, key, display_name)
        values (${ctx.companyId}::uuid, ${key}, ${name})
        on conflict (company_id, key) do update set last_seen_at = now()
        returning id, team_id`,
  );
  ctx.projectTeams.set(row!.id, row!.team_id);
  return { id: row!.id, teamId: row!.team_id };
}

/** Mapped team of a project already known to the DB (cached per batch). */
export async function projectTeam(tx: Tx, ctx: BatchContext, projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  if (!ctx.projectTeams.has(projectId)) {
    const [row] = await rows<{ team_id: string | null }>(tx, sql`select team_id from projects where id = ${projectId}::uuid`);
    ctx.projectTeams.set(projectId, row?.team_id ?? null);
  }
  return ctx.projectTeams.get(projectId) ?? null;
}

/** Team for rows of this batch given an (optional) project. Falls back to the token's team. */
export async function teamFor(tx: Tx, ctx: BatchContext, projectId: string | null): Promise<string> {
  const team = resolveTeam({
    projectTeamId: await projectTeam(tx, ctx, projectId),
    tokenTeamId: ctx.token.teamId,
    primaryTeamId: ctx.primaryTeamId,
  });
  // ingest_tokens.team_id is NOT NULL, so this only fires on a corrupt token row.
  if (!team) throw new Error('no team to attribute to');
  return team;
}
