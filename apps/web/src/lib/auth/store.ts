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
import type { CompanyRole, Plan } from './session';

/**
 * DB access for login. Identity tables (auth_*, magic_links) have no RLS and are only reachable by
 * app_web; users, memberships and companies are read and created through the auth_* SECURITY DEFINER
 * functions because no RLS context exists before login (packages/db/README.md).
 */

/** An identity (users row) plus how many companies it belongs to (ADR-0022). */
export interface IdentityRow extends ExistingUser {
  email: string;
  name: string | null;
}

type RawIdentity = {
  user_id: string;
  email: string;
  name: string | null;
  is_super_admin: boolean;
  memberships: string | number;
  active_memberships: string | number;
};

const toIdentity = (r: RawIdentity | undefined): IdentityRow | null =>
  r
    ? {
        userId: r.user_id,
        email: r.email,
        name: r.name,
        isSuperAdmin: r.is_super_admin,
        memberships: Number(r.memberships),
        activeMemberships: Number(r.active_memberships),
      }
    : null;

async function scalarUuid(db: Database, query: ReturnType<typeof sql>): Promise<string | null> {
  const rows = (await db.execute(query)) as unknown as Array<{ id: string | null }>;
  return rows[0]?.id ?? null;
}

export async function findUserByEmail(db: Database, email: string): Promise<IdentityRow | null> {
  const rows = (await db.execute(sql`select * from auth_find_user_by_email(${email})`)) as unknown as RawIdentity[];
  return toIdentity(rows[0]);
}

export async function getUser(db: Database, userId: string): Promise<IdentityRow | null> {
  const rows = (await db.execute(sql`select * from auth_get_user(${userId}::uuid)`)) as unknown as RawIdentity[];
  return toIdentity(rows[0]);
}

/** One company the user belongs to (auth_user_memberships). */
export interface MembershipRow {
  companyId: string;
  companyName: string;
  companySlug: string;
  companyStatus: 'active' | 'suspended';
  plan: Plan;
  companyRole: CompanyRole;
  primaryTeamId: string | null;
  /** Last time a session started in, or switched to, this company (D4). */
  lastActiveAt: Date | null;
  joinedAt: Date;
}

type RawMembership = {
  company_id: string;
  company_name: string;
  company_slug: string;
  company_status: 'active' | 'suspended';
  plan: Plan;
  company_role: CompanyRole;
  primary_team_id: string | null;
  last_active_at: Date | string | null;
  joined_at: Date | string;
};

/** Every membership of the user, suspended companies included: last active first, then the oldest. */
export async function listMemberships(db: Database, userId: string): Promise<MembershipRow[]> {
  const rows = (await db.execute(sql`select * from auth_user_memberships(${userId}::uuid)`)) as unknown as RawMembership[];
  return rows.map((r) => ({
    companyId: r.company_id,
    companyName: r.company_name,
    companySlug: r.company_slug,
    companyStatus: r.company_status,
    plan: r.plan,
    companyRole: r.company_role,
    primaryTeamId: r.primary_team_id,
    lastActiveAt: r.last_active_at === null ? null : new Date(r.last_active_at),
    joinedAt: new Date(r.joined_at),
  }));
}

/**
 * Points a live session at a company (null clears it). The SQL only allows an active company the
 * session's user is a member of, so a forged form value cannot switch into a foreign tenant. true = updated.
 */
export async function setSessionCompany(db: Database, tokenHash: string, companyId: string | null): Promise<boolean> {
  const rows = (await db.execute(
    sql`select auth_set_session_company(${tokenHash}, ${companyId}::uuid) as ok`,
  )) as unknown as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
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

/**
 * Pending, unexpired invitations of active companies for an e-mail, newest first. Companies the e-mail
 * already belongs to, and super admins, get none.
 */
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
 * Accepts exactly the invitation the user picked (it must be pending, unexpired and for this e-mail):
 * finds or creates the identity and adds the membership (and team membership). Null when the invitation
 * is not acceptable, the e-mail is already a member of that company or a super admin, or the company is
 * full. Never picks an invitation by itself (SEC-1).
 */
export async function acceptInvitation(
  db: Database,
  email: string,
  name: string | null,
  invitationId: string,
): Promise<{ userId: string; companyId: string } | null> {
  const rows = (await db.execute(
    sql`select user_id, company_id from auth_accept_invitation(${email}, ${name}, ${invitationId}::uuid)`,
  )) as unknown as Array<{ user_id: string; company_id: string }>;
  return rows[0] ? { userId: rows[0].user_id, companyId: rows[0].company_id } : null;
}

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

/** A new session working in `activeCompanyId` (null for super admins); a trigger stamps the membership's last_active_at. */
export async function insertSession(
  db: Database,
  userId: string,
  tokenHash: string,
  ttlMs: number,
  activeCompanyId: string | null,
): Promise<void> {
  await db.insert(authSessions).values({
    userId,
    tokenHash,
    activeCompanyId,
    lastSeenAt: sql`now()`,
    expiresAt: sql`now() + ${`${Math.floor(ttlMs / 1000)} seconds`}::interval`,
  });
}

/** The user and the stored active company of a session. */
export interface SessionRef {
  userId: string;
  activeCompanyId: string | null;
}

/**
 * The user and active company of a live session. Slides the expiry to now + ttl at most once per
 * `slideEveryMs` (30-day sliding expiry without a write on every request).
 */
export async function touchSession(db: Database, tokenHash: string, ttlMs: number, slideEveryMs: number): Promise<SessionRef | null> {
  const ttl = `${Math.floor(ttlMs / 1000)} seconds`;
  const every = `${Math.floor(slideEveryMs / 1000)} seconds`;
  const rows = (await db.execute(sql`
    with s as (
      select id, user_id, active_company_id, last_seen_at from auth_sessions where token_hash = ${tokenHash} and expires_at > now()
    ), slid as (
      update auth_sessions a set last_seen_at = now(), expires_at = now() + ${ttl}::interval
      from s where a.id = s.id and (s.last_seen_at is null or s.last_seen_at < now() - ${every}::interval)
    )
    select user_id, active_company_id from s`)) as unknown as Array<{ user_id: string; active_company_id: string | null }>;
  return rows[0] ? { userId: rows[0].user_id, activeCompanyId: rows[0].active_company_id } : null;
}

/** Deletes the session; returns its user and active company (for the audit entry) or null. */
export async function deleteSession(db: Database, tokenHash: string): Promise<SessionRef | null> {
  const rows = await db
    .delete(authSessions)
    .where(eq(authSessions.tokenHash, tokenHash))
    .returning({ userId: authSessions.userId, activeCompanyId: authSessions.activeCompanyId });
  return rows[0] ?? null;
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
  company: { id: string; name: string; slug: string; plan: Plan; settings: Record<string, unknown> };
  teams: { id: string; name: string; role: 'member' | 'lead' }[];
  primaryTeamId: string | null;
}

/** The membership a request works in: which company, which role there, which primary team. */
export interface ActiveMembership {
  userId: string;
  companyId: string;
  companyRole: CompanyRole;
  primaryTeamId: string | null;
}

/** Company + the user's teams in it, read under the user's own RLS context. The primary team comes from the membership. */
export async function loadCompanyContext(db: Database, m: ActiveMembership): Promise<CompanyContext | null> {
  return withRlsContext(db, { companyId: m.companyId, userId: m.userId, role: m.companyRole }, async (tx) => {
    const [company] = await tx
      .select({ id: companies.id, name: companies.name, slug: companies.slug, plan: companies.plan, settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, m.companyId));
    if (!company) return null;
    const memberTeams = await tx
      .select({ id: teams.id, name: teams.name, role: teamMemberships.role })
      .from(teamMemberships)
      .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
      .where(and(eq(teamMemberships.userId, m.userId), eq(teamMemberships.companyId, m.companyId)))
      .orderBy(asc(teams.name));
    return {
      company: { ...company, settings: company.settings as unknown as Record<string, unknown> },
      teams: memberTeams,
      primaryTeamId: m.primaryTeamId,
    };
  });
}

export type AuthAuditAction = 'auth.login' | 'auth.logout' | 'auth.signup' | 'auth.invitation_accepted' | 'auth.company_switch';

/**
 * audit_log entry in the actor's own name, in the company it concerns. Company users write through
 * app_web under their RLS context in that company; company-less users (super admins) write a
 * platform-level row through app_platform. Meta carries the login method only — no IPs, no e-mails,
 * no other company's id.
 */
export async function writeAudit(
  dbs: { web: Database; platform: Database },
  actor: { userId: string; companyId: string | null; companyRole: CompanyRole },
  action: AuthAuditAction,
  meta: Record<string, string> = {},
): Promise<void> {
  const values = { companyId: actor.companyId, actorUserId: actor.userId, action, target: `user:${actor.userId}`, meta };
  if (!actor.companyId) {
    await dbs.platform.insert(auditLog).values(values);
    return;
  }
  await withRlsContext(dbs.web, { companyId: actor.companyId, userId: actor.userId, role: actor.companyRole }, (tx) =>
    tx.insert(auditLog).values(values),
  );
}
