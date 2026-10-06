import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  auditLog,
  authAccounts,
  authSessions,
  companies,
  magicLinks,
  teamMemberships,
  teams,
  withRlsContext,
  type Database,
} from '@ai-obs/db';
import type { ExistingUser } from './provisioning';

/**
 * DB access for login. Identity tables (auth_*, magic_links) have no RLS and are only reachable by
 * app_web; users/companies are read and created through the auth_* SECURITY DEFINER functions
 * because no RLS context exists before login (packages/db/README.md).
 */

export interface UserRow extends ExistingUser {
  email: string;
  name: string | null;
  companyRole: 'admin' | 'member';
}

type RawUser = {
  user_id: string;
  company_id: string | null;
  email: string;
  name: string | null;
  company_role: 'admin' | 'member';
  is_super_admin: boolean;
  company_status: 'active' | 'suspended' | null;
};

const toUser = (r: RawUser | undefined): UserRow | null =>
  r
    ? {
        userId: r.user_id,
        companyId: r.company_id,
        email: r.email,
        name: r.name,
        companyRole: r.company_role,
        isSuperAdmin: r.is_super_admin,
        companyStatus: r.company_status,
      }
    : null;

async function scalarUuid(db: Database, query: ReturnType<typeof sql>): Promise<string | null> {
  const rows = (await db.execute(query)) as unknown as Array<{ id: string | null }>;
  return rows[0]?.id ?? null;
}

export async function findUserByEmail(db: Database, email: string): Promise<UserRow | null> {
  const rows = (await db.execute(sql`select * from auth_find_user_by_email(${email})`)) as unknown as RawUser[];
  return toUser(rows[0]);
}

export async function getUser(db: Database, userId: string): Promise<UserRow | null> {
  const rows = (await db.execute(sql`select * from auth_get_user(${userId}::uuid)`)) as unknown as RawUser[];
  return toUser(rows[0]);
}

/** A pending invitation shown on the sign-up step ("Join <company>, invited by <inviter>?"). */
export interface PendingInvitation {
  invitationId: string;
  companyName: string;
  teamName: string | null;
  companyRole: 'admin' | 'member';
  teamRole: 'member' | 'lead';
  invitedByName: string | null;
  invitedByEmail: string | null;
  createdAt: Date;
}

type RawInvitation = {
  invitation_id: string;
  company_name: string;
  team_name: string | null;
  company_role: 'admin' | 'member';
  team_role: 'member' | 'lead';
  invited_by_name: string | null;
  invited_by_email: string | null;
  created_at: Date | string;
};

/** Pending, unexpired invitations of active companies for an e-mail that has no user yet, newest first. */
export async function pendingInvitations(db: Database, email: string): Promise<PendingInvitation[]> {
  const rows = (await db.execute(sql`select * from auth_pending_invitations(${email})`)) as unknown as RawInvitation[];
  return rows.map((r) => ({
    invitationId: r.invitation_id,
    companyName: r.company_name,
    teamName: r.team_name,
    companyRole: r.company_role,
    teamRole: r.team_role,
    invitedByName: r.invited_by_name,
    invitedByEmail: r.invited_by_email,
    createdAt: new Date(r.created_at),
  }));
}

/**
 * Accepts exactly the invitation the user picked (it must be pending, unexpired and for this e-mail).
 * Null when it is not, or when the user already exists. Never picks an invitation by itself (SEC-1).
 */
export const acceptInvitation = (db: Database, email: string, name: string | null, invitationId: string) =>
  scalarUuid(db, sql`select auth_accept_invitation(${email}, ${name}, ${invitationId}::uuid) as id`);

export const createSoloCompany = (db: Database, email: string, name: string, company: string) =>
  scalarUuid(db, sql`select auth_create_solo_company(${email}, ${name}, ${company}) as id`);

export const ensureSuperAdmin = (db: Database, email: string, name: string | null) =>
  scalarUuid(db, sql`select auth_ensure_super_admin(${email}, ${name}) as id`);

export async function recordLogin(db: Database, userId: string): Promise<void> {
  await db.execute(sql`select auth_record_login(${userId}::uuid)`);
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
 * The user id of a live session. Slides the expiry to now + ttl at most once per `slideEveryMs`
 * (30-day sliding expiry without a write on every request).
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

/** Deletes the session; returns its user id (for the audit entry) or null. */
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

// ---- company context + audit ------------------------------------------------------------------

export interface CompanyContext {
  company: { id: string; name: string; slug: string; plan: 'free' | 'team' | 'business'; settings: Record<string, unknown> };
  teams: { id: string; name: string; role: 'member' | 'lead' }[];
  primaryTeamId: string | null;
}

/** Company + the user's teams, read under the user's own RLS context. */
export async function loadCompanyContext(db: Database, user: UserRow): Promise<CompanyContext | null> {
  if (!user.companyId) return null;
  return withRlsContext(db, { companyId: user.companyId, userId: user.userId, role: user.companyRole }, async (tx) => {
    const [company] = await tx
      .select({ id: companies.id, name: companies.name, slug: companies.slug, plan: companies.plan, settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, user.companyId!));
    if (!company) return null;
    const memberTeams = await tx
      .select({ id: teams.id, name: teams.name, role: teamMemberships.role })
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(eq(teamMemberships.userId, user.userId))
      .orderBy(asc(teams.name));
    const [row] = (await tx.execute(sql`select primary_team_id from users where id = ${user.userId}`)) as unknown as Array<{
      primary_team_id: string | null;
    }>;
    return {
      company: { ...company, settings: company.settings as unknown as Record<string, unknown> },
      teams: memberTeams,
      primaryTeamId: row?.primary_team_id ?? null,
    };
  });
}

export type AuthAuditAction = 'auth.login' | 'auth.logout' | 'auth.signup' | 'auth.invitation_accepted';

/**
 * audit_log entry in the actor's own name. Company users write through app_web under their RLS
 * context; super admins (no company) write a platform-level row through app_platform.
 * Meta carries the login method only — no IPs, no e-mails.
 */
export async function writeAudit(
  dbs: { web: Database; platform: Database },
  user: Pick<UserRow, 'userId' | 'companyId' | 'companyRole'>,
  action: AuthAuditAction,
  meta: Record<string, string> = {},
): Promise<void> {
  const values = { companyId: user.companyId, actorUserId: user.userId, action, target: `user:${user.userId}`, meta };
  if (!user.companyId) {
    await dbs.platform.insert(auditLog).values(values);
    return;
  }
  await withRlsContext(dbs.web, { companyId: user.companyId, userId: user.userId, role: user.companyRole }, (tx) =>
    tx.insert(auditLog).values(values),
  );
}
