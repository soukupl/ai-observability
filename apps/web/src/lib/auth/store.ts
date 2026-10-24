import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  auditLog,
  authAccounts,
  authSessions,
  deployment,
  magicLinks,
  teamMemberships,
  teams,
  withRlsContext,
  type Database,
  type DeploymentSettings,
  type MemberRole,
  type TeamRole,
  type UserKind,
} from '@ai-obs/db';
import type { DeploymentInfo, UserTeam } from './session';

/**
 * DB access for login. Identity tables (auth_*, magic_links) have no RLS and are only reachable by app_web; users
 * and memberships are read and created through the auth_* SECURITY DEFINER functions because no RLS context exists
 * before login (packages/db/README.md). The deployment row is readable by app_web without a context.
 */

/** A users row and its membership (auth_find_user_by_email / auth_get_user). `role` is null without a membership. */
export interface IdentityRow {
  userId: string;
  email: string | null;
  name: string | null;
  kind: UserKind;
  role: MemberRole | null;
  primaryTeamId: string | null;
}

type RawIdentity = {
  user_id: string;
  email: string | null;
  name: string | null;
  kind: UserKind;
  role: MemberRole | null;
  primary_team_id: string | null;
};

const toIdentity = (r: RawIdentity | undefined): IdentityRow | null =>
  r ? { userId: r.user_id, email: r.email, name: r.name, kind: r.kind, role: r.role, primaryTeamId: r.primary_team_id } : null;

export async function findUserByEmail(db: Database, email: string): Promise<IdentityRow | null> {
  const rows = (await db.execute(sql`select * from auth_find_user_by_email(${email})`)) as unknown as RawIdentity[];
  return toIdentity(rows[0]);
}

export async function getUser(db: Database, userId: string): Promise<IdentityRow | null> {
  const rows = (await db.execute(sql`select * from auth_get_user(${userId}::uuid)`)) as unknown as RawIdentity[];
  return toIdentity(rows[0]);
}

/** An open invitation for an e-mail (auth_pending_invitations), newest first. */
export interface PendingInvitation {
  invitationId: string;
  teamId: string | null;
  teamName: string | null;
  role: MemberRole;
  teamRole: TeamRole;
  invitedByName: string | null;
  invitedByEmail: string | null;
  createdAt: Date;
}

type RawInvitation = {
  invitation_id: string;
  team_id: string | null;
  team_name: string | null;
  role: MemberRole;
  team_role: TeamRole;
  invited_by_name: string | null;
  invited_by_email: string | null;
  created_at: Date | string;
};

export async function pendingInvitations(db: Database, email: string): Promise<PendingInvitation[]> {
  const rows = (await db.execute(sql`select * from auth_pending_invitations(${email})`)) as unknown as RawInvitation[];
  return rows.map((r) => ({
    invitationId: r.invitation_id,
    teamId: r.team_id,
    teamName: r.team_name,
    role: r.role,
    teamRole: r.team_role,
    invitedByName: r.invited_by_name,
    invitedByEmail: r.invited_by_email,
    createdAt: new Date(r.created_at),
  }));
}

/**
 * Accepts one invitation for the e-mail: creates the person and the membership when missing (role and primary team
 * from the invitation), adds the team membership. Null when the invitation is not open for that e-mail.
 */
export async function acceptInvitation(db: Database, email: string, name: string | null, invitationId: string): Promise<string | null> {
  const rows = (await db.execute(
    sql`select user_id from auth_accept_invitation(${email}, ${name}, ${invitationId}::uuid)`,
  )) as unknown as Array<{ user_id: string }>;
  return rows[0]?.user_id ?? null;
}

/** Creates the person and a membership with `role` (ADMIN_EMAILS / ALLOWED_EMAIL_DOMAINS). An existing membership is kept. */
export async function provisionMember(
  db: Database,
  email: string,
  name: string | null,
  role: MemberRole,
): Promise<{ userId: string; created: boolean } | null> {
  const rows = (await db.execute(
    sql`select user_id, created from auth_provision_member(${email}, ${name}, ${role}::member_role)`,
  )) as unknown as Array<{ user_id: string; created: boolean }>;
  return rows[0] ? { userId: rows[0].user_id, created: rows[0].created } : null;
}

export async function recordLogin(db: Database, userId: string): Promise<void> {
  await db.execute(sql`select auth_record_login(${userId}::uuid)`);
}

/** The deployment row (exactly one; app_web reads it without a context). */
export async function getDeployment(db: Database): Promise<DeploymentInfo | null> {
  const [row] = await db
    .select({ id: deployment.id, name: deployment.name, slug: deployment.slug, settings: deployment.settings })
    .from(deployment)
    .limit(1);
  return row ? { ...row, settings: row.settings as DeploymentSettings } : null;
}

// ---- magic links ------------------------------------------------------------------------------

export async function insertMagicLink(db: Database, email: string, tokenHash: string, ttlMs: number): Promise<void> {
  await db.insert(magicLinks).values({
    email,
    tokenHash,
    expiresAt: sql`now() + ${`${Math.floor(ttlMs / 1000)} seconds`}::interval`,
  });
}

/** Marks the link used (atomically: single use) and returns its e-mail; null if unknown, used or expired. */
export async function consumeMagicLink(db: Database, tokenHash: string): Promise<string | null> {
  const rows = await db
    .update(magicLinks)
    .set({ usedAt: sql`now()` })
    .where(and(eq(magicLinks.tokenHash, tokenHash), isNull(magicLinks.usedAt), gt(magicLinks.expiresAt, sql`now()`)))
    .returning({ email: magicLinks.email });
  return rows[0]?.email ?? null;
}

// ---- sessions ---------------------------------------------------------------------------------

export async function insertSession(db: Database, userId: string, tokenHash: string, ttlMs: number): Promise<void> {
  await db.insert(authSessions).values({
    userId,
    tokenHash,
    lastSeenAt: sql`now()`,
    expiresAt: sql`now() + ${`${Math.floor(ttlMs / 1000)} seconds`}::interval`,
  });
}

/**
 * The user of a live session. Slides the expiry to now + ttl at most once per `slideEveryMs` (30-day sliding expiry
 * without a write on every request).
 */
export async function touchSession(db: Database, tokenHash: string, ttlMs: number, slideEveryMs: number): Promise<string | null> {
  const ttl = `${Math.floor(ttlMs / 1000)} seconds`;
  const every = `${Math.floor(slideEveryMs / 1000)} seconds`;
  const rows = (await db.execute(sql`
    with s as (
      select id, user_id, last_seen_at from auth_sessions where token_hash = ${tokenHash} and expires_at > now()
    ), slid as (
      update auth_sessions a set last_seen_at = now(), expires_at = now() + ${ttl}::interval
      from s where a.id = s.id and (s.last_seen_at is null or s.last_seen_at < now() - ${every}::interval)
    )
    select user_id from s`)) as unknown as Array<{ user_id: string }>;
  return rows[0]?.user_id ?? null;
}

/** Deletes the session; returns its user (for the audit entry) or null. */
export async function deleteSession(db: Database, tokenHash: string): Promise<string | null> {
  const rows = await db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash)).returning({ userId: authSessions.userId });
  return rows[0]?.userId ?? null;
}

// ---- OAuth accounts ---------------------------------------------------------------------------

export async function findAccountUser(db: Database, provider: string, accountId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: authAccounts.userId })
    .from(authAccounts)
    .where(and(eq(authAccounts.provider, provider), eq(authAccounts.providerAccountId, accountId)));
  return rows[0]?.userId ?? null;
}

export async function linkAccount(db: Database, userId: string, provider: string, accountId: string): Promise<void> {
  await db.insert(authAccounts).values({ userId, provider, providerAccountId: accountId }).onConflictDoNothing();
}

// ---- request context + audit ------------------------------------------------------------------

export interface SessionContext {
  deployment: DeploymentInfo;
  teams: UserTeam[];
}

/** The deployment and the member's teams (name order), read under the member's own RLS context. */
export async function loadSessionContext(db: Database, m: { userId: string; role: MemberRole }): Promise<SessionContext | null> {
  return withRlsContext(db, { userId: m.userId, role: m.role }, async (tx) => {
    const [dep] = await tx
      .select({ id: deployment.id, name: deployment.name, slug: deployment.slug, settings: deployment.settings })
      .from(deployment)
      .limit(1);
    if (!dep) return null;
    const memberTeams = await tx
      .select({ id: teams.id, slug: teams.slug, name: teams.name, role: teamMemberships.role })
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(eq(teamMemberships.userId, m.userId))
      .orderBy(asc(teams.name));
    return { deployment: { ...dep, settings: dep.settings as DeploymentSettings }, teams: memberTeams };
  });
}

export type AuthAuditAction = 'auth.login' | 'auth.logout' | 'auth.provisioned' | 'auth.invitation_accepted';

/**
 * audit_log entry in the actor's own name, written through app_web under their RLS context (the policy needs a live
 * membership). Meta carries the login method and the provisioning rule only: no IPs, no e-mails.
 */
export async function writeAudit(
  db: Database,
  actor: { userId: string; role: MemberRole },
  action: AuthAuditAction,
  meta: Record<string, string> = {},
): Promise<void> {
  await withRlsContext(db, { userId: actor.userId, role: actor.role }, (tx) =>
    tx.insert(auditLog).values({ actorUserId: actor.userId, action, target: `user:${actor.userId}`, meta }),
  );
}
