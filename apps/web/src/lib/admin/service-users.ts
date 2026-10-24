import { eq, sql } from 'drizzle-orm';
import { memberships, teamMemberships, users, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { id, name, optionalId, parse } from './input';
import { isAdmin } from './permissions';
import { AdminError, ensure, type Actor } from './types';

/**
 * Service users (brief Q9, ADR-0029 T7): CI, bots and shared machines. A name, no e-mail, no login, a membership
 * with role member and a primary team; admins create, rename, re-team and disable them and manage their tokens.
 */
export interface ServiceUserRow {
  id: string;
  name: string;
  primaryTeamId: string | null;
  teams: { id: string; name: string }[];
  liveTokens: number;
  createdMs: number;
  /** Disabled = no live token and no team (what disableServiceUser leaves). Setting a primary team re-enables it. */
  disabled: boolean;
}

export async function listServiceUsers(tx: Tx): Promise<ServiceUserRow[]> {
  const list = await rows<{ id: string; name: string | null; primary_team_id: string | null; created_at: Date | string; live_tokens: number }>(
    tx,
    sql`select u.id, u.name, m.primary_team_id, u.created_at,
          (select count(*)::int from ingest_tokens k where k.user_id = u.id and k.revoked_at is null
             and (k.expires_at is null or k.expires_at > now())) as live_tokens
        from users u join memberships m on m.user_id = u.id
        where u.kind = 'service' order by lower(u.name)`,
  );
  const tms = await rows<{ user_id: string; team_id: string; team_name: string }>(
    tx,
    sql`select tm.user_id, tm.team_id, t.name as team_name from team_memberships tm join teams t on t.id = tm.team_id
        join users u on u.id = tm.user_id where u.kind = 'service' order by lower(t.name)`,
  );
  return list.map((u) => {
    const teams = tms.filter((t) => t.user_id === u.id).map((t) => ({ id: t.team_id, name: t.team_name }));
    const liveTokens = Number(u.live_tokens);
    return {
      id: u.id,
      name: u.name ?? 'service user',
      primaryTeamId: u.primary_team_id,
      teams,
      liveTokens,
      createdMs: new Date(u.created_at).getTime(),
      disabled: liveTokens === 0 && teams.length === 0,
    };
  });
}

const requireAdmin = (a: Actor) => ensure(isAdmin(a), 'Only admins can manage service users.');

async function loadServiceUser(tx: Tx, userId: string): Promise<{ id: string; name: string | null; primaryTeamId: string | null }> {
  const [u] = await rows<{ id: string; name: string | null; kind: 'person' | 'service'; primary_team_id: string | null }>(
    tx,
    sql`select u.id, u.name, u.kind, m.primary_team_id from users u join memberships m on m.user_id = u.id where u.id = ${userId}::uuid`,
  );
  if (!u || u.kind !== 'service') throw new AdminError('Service user not found.');
  return { id: u.id, name: u.name, primaryTeamId: u.primary_team_id };
}

export const serviceUserInput = z.object({ name: name(80), primaryTeamId: optionalId });

/** admin_create_service_user: the user, its membership and (with a primary team) the team membership. */
export async function createServiceUser(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const s = parse(serviceUserInput, input);
  const [row] = await rows<{ id: string }>(tx, sql`select admin_create_service_user(${s.name}, ${s.primaryTeamId}::uuid) as id`);
  await audit(tx, actor, 'service_user.create', `user:${row!.id}`, { name: s.name, primaryTeamId: s.primaryTeamId });
  return `Service user "${s.name}" created. Create a token for it below.`;
}

export async function renameServiceUser(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { userId, name: newName } = parse(z.object({ userId: id, name: name(80) }), input);
  const u = await loadServiceUser(tx, userId);
  if (u.name === newName) return 'No changes.';
  const done = await tx.update(users).set({ name: newName }).where(eq(users.id, userId)).returning({ id: users.id });
  ensure(done.length === 1, 'You are not allowed to rename this user.');
  await audit(tx, actor, 'service_user.rename', `user:${userId}`, { before: u.name, after: newName });
  return 'Service user renamed.';
}

/** Sets (or clears) the primary team; the service user joins that team as a member if needed. */
export async function setServicePrimaryTeam(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { userId, teamId } = parse(z.object({ userId: id, teamId: optionalId }), input);
  const u = await loadServiceUser(tx, userId);
  if (u.primaryTeamId === teamId) return 'No changes.';
  if (teamId) await tx.insert(teamMemberships).values({ teamId, userId, role: 'member' }).onConflictDoNothing();
  await tx.update(memberships).set({ primaryTeamId: teamId }).where(eq(memberships.userId, userId));
  await audit(tx, actor, 'service_user.primary_team', `user:${userId}`, { before: u.primaryTeamId, after: teamId });
  return teamId ? 'Primary team set.' : 'Primary team cleared.';
}

/**
 * Disable (ADR-0029 T7): revoke every live token and remove the service user from all teams. The identity and its
 * membership stay, so its past turns keep their name; a new primary team and a new token bring it back.
 */
export async function disableServiceUser(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  requireAdmin(actor);
  const { userId } = parse(z.object({ userId: id }), input);
  const u = await loadServiceUser(tx, userId);
  const revoked = await rows<{ id: string; name: string; prefix: string }>(
    tx,
    sql`update ingest_tokens set revoked_at = now() where user_id = ${userId}::uuid and revoked_at is null returning id, name, prefix`,
  );
  for (const t of revoked) {
    await audit(tx, actor, 'token.revoke', `token:${t.id}`, { name: t.name, prefix: t.prefix, userId, reason: 'service user disabled' });
  }
  const left = await tx.delete(teamMemberships).where(eq(teamMemberships.userId, userId)).returning({ teamId: teamMemberships.teamId });
  await tx.update(memberships).set({ primaryTeamId: null }).where(eq(memberships.userId, userId));
  await audit(tx, actor, 'service_user.disable', `user:${userId}`, { name: u.name, revokedTokens: revoked.length, teamsLeft: left.length });
  return `Service user "${u.name ?? userId}" disabled: ${revoked.length} token(s) revoked, removed from ${left.length} team(s).`;
}
