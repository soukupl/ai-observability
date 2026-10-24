import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Tx } from '@ai-obs/db';
import { projectKeyKind, type BatchHeader, type ProjectNamingMode, type ProjectRef } from '@ai-obs/protocol';
import { rows, type BatchContext } from './context';

/*
 * Identity resolution for one batch: machine, project, team. The user is always the token's user (ADR-0029).
 * Collector ids are namespaced by harness (`<harness>:<id>`) so two harnesses can never collide on a session or turn id.
 */

export const sessionKey = (harness: string, sessionId: string) => `${harness}:${sessionId}`;
export const turnKey = (harness: string, turnId: string) => `${harness}:${turnId}`;

/**
 * Team of a session, first match wins (ADR-0030 R1, brief Appendix D): the admin's project → team mapping, then the
 * repository's dot-file team when the user is a member of it, then the user's primary team, else no team. Pure.
 */
export function resolveTeam(input: {
  mappedTeamId: string | null | undefined;
  dotFileTeamId: string | null | undefined;
  primaryTeamId: string | null | undefined;
}): string | null {
  return input.mappedTeamId || input.dotFileTeamId || input.primaryTeamId || null;
}

/**
 * Resolves the team a session reports to at its session_start (Appendix D); later events of the session reuse the team
 * stored on the session row. A dot-file team the user is not a member of, or that does not exist, falls through with
 * one warning for the session (ADR-0030 R2): ingest_team_status() is SECURITY DEFINER and membership-checked, so no
 * token holder can feed a team they do not belong to.
 */
export async function resolveSessionTeam(
  tx: Tx,
  ctx: BatchContext,
  session: { key: string; sessionId: string },
  project: { teamId: string | null } | null,
  dotFileTeam: string | undefined,
): Promise<string | null> {
  if (project?.teamId) return project.teamId;
  let dotFileTeamId: string | null = null;
  if (dotFileTeam) {
    const [status] = await rows<{ team_id: string | null; status: 'member' | 'not_member' | 'unknown' }>(
      tx,
      sql`select team_id, status from ingest_team_status(${ctx.userId}::uuid, ${dotFileTeam})`,
    );
    if (status?.status === 'member') dotFileTeamId = status.team_id;
    else {
      ctx.warnings.set(session.key, {
        code: status?.status === 'not_member' ? 'team_not_member' : 'team_unknown',
        team: dotFileTeam,
        session_id: session.sessionId,
      });
    }
  }
  return resolveTeam({ mappedTeamId: null, dotFileTeamId, primaryTeamId: ctx.primaryTeamId });
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

/** Upserts the sending machine for the token's user. Returns machines.id. */
export async function upsertMachine(tx: Tx, machine: BatchHeader['machine'], userId: string): Promise<string> {
  const [row] = await rows<{ id: string }>(
    tx,
    sql`insert into machines (user_id, machine_id, os)
        values (${userId}::uuid, ${machine.id}, ${machine.os})
        on conflict (machine_id) do update
          set os = ${machine.os}, last_seen_at = now(), user_id = ${userId}::uuid
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
    sql`insert into projects (key, display_name)
        values (${key}, ${name})
        on conflict (key) do update set last_seen_at = now()
        returning id, team_id`,
  );
  return { id: row!.id, teamId: row!.team_id };
}
