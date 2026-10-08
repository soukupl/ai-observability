import { dbFor, type Database } from '@ai-obs/db';
import { z } from 'zod';
import { getMailer, magicLinkEmail, type Mailer } from '../mail';
import {
  appUrl,
  MAGIC_LINK_TTL_MS,
  SESSION_SLIDE_EVERY_MS,
  SESSION_TTL_MS,
  superAdminEmails,
  type OAuthProvider,
} from './config';
import { decideProvisioning, isEffectiveSuperAdmin, landingPath } from './provisioning';
import { magicLinkLimits } from './rate-limit';
import * as store from './store';
import type { CompanyRole, MembershipSummary } from './session';
import { hashToken, isWellFormedToken, newToken, normalizeEmail } from './tokens';

/** Everything the login flows touch, injectable for tests. */
export interface AuthDeps {
  web: Database;
  platform: Database;
  mailer: Mailer;
  env: NodeJS.ProcessEnv;
}

export function defaultAuthDeps(): AuthDeps {
  return { web: dbFor('web'), platform: dbFor('platform'), mailer: getMailer(), env: process.env };
}

export type LoginMethod = 'magic' | OAuthProvider;

/** A verified identity from a magic link or an OAuth provider. */
export interface VerifiedIdentity {
  email: string;
  name: string | null;
  method: LoginMethod;
  /** OAuth: linked to auth_accounts after login / sign-up. */
  account?: { provider: OAuthProvider; id: string };
}

/**
 * Carried in the signed sign-up cookie until the user submits name + company. For an existing identity
 * the e-mail is the identity's own (users.email), never a differing provider e-mail (D5).
 * `invitationsOnly`: every company of the user is suspended, so only joining an invitation is offered.
 */
export type PendingSignup = VerifiedIdentity & { invitationsOnly?: boolean };

export type LoginErrorCode = 'suspended' | 'no-company' | 'failed';

export type LoginResult =
  | { kind: 'session'; token: string; landing: string }
  | { kind: 'signup'; pending: PendingSignup }
  | { kind: 'error'; code: LoginErrorCode };

// ---- magic link -------------------------------------------------------------------------------

export type MagicLinkRequest = { email: unknown; ip: string | null; next: string | null };
export type MagicLinkResponse = { ok: true } | { ok: false; error: 'invalid_email' | 'rate_limited' };

/** Creates a single-use, 15-minute magic link and e-mails it. Same answer for known and unknown e-mails. */
export async function requestMagicLink(deps: AuthDeps, req: MagicLinkRequest): Promise<MagicLinkResponse> {
  const email = normalizeEmail(req.email);
  if (!email) return { ok: false, error: 'invalid_email' };
  const ipOk = req.ip ? magicLinkLimits.ip.hit(req.ip) : true;
  const emailOk = magicLinkLimits.email.hit(email);
  if (!ipOk || !emailOk) return { ok: false, error: 'rate_limited' };

  const token = newToken();
  await store.insertMagicLink(deps.web, email, hashToken(token), MAGIC_LINK_TTL_MS);
  const link = new URL(`/api/auth/magic/${token}`, appUrl(deps.env));
  if (req.next) link.searchParams.set('next', req.next);
  await deps.mailer.send(magicLinkEmail(email, link.toString(), MAGIC_LINK_TTL_MS / 60_000));
  return { ok: true };
}

/** Consumes the link; the verified e-mail, or null for an unknown / used / expired token. */
export async function verifyMagicLink(deps: AuthDeps, token: unknown): Promise<VerifiedIdentity | null> {
  if (!isWellFormedToken(token)) return null;
  const email = await store.consumeMagicLink(deps.web, hashToken(token));
  return email ? { email, name: null, method: 'magic' } : null;
}

// ---- provisioning + sessions ------------------------------------------------------------------

type Membership = store.MembershipRow;

/**
 * The company a session works in: the active-company membership matching `preferredCompanyId`, else
 * the first active one (the list is ordered last active first, D4), else null.
 */
function chooseActive(memberships: Membership[], preferredCompanyId?: string | null): Membership | null {
  const active = memberships.filter((m) => m.companyStatus === 'active');
  return (preferredCompanyId ? active.find((m) => m.companyId === preferredCompanyId) : undefined) ?? active[0] ?? null;
}

/** The audit actor for a user in a membership (null membership: a company-less, platform-level row). */
const actorIn = (userId: string, m: Pick<Membership, 'companyId' | 'companyRole'> | null | undefined) => ({
  userId,
  companyId: m?.companyId ?? null,
  companyRole: m?.companyRole ?? ('member' as const),
});

async function startSession(
  deps: AuthDeps,
  user: store.IdentityRow,
  method: LoginMethod,
  preferredCompanyId?: string | null,
): Promise<LoginResult> {
  const active = chooseActive(await store.listMemberships(deps.web, user.userId), preferredCompanyId);
  // Only a super admin works without a company; anyone else would get a dead session.
  if (!active && !user.isSuperAdmin) return { kind: 'error', code: 'failed' };
  const token = newToken();
  await store.insertSession(deps.web, user.userId, hashToken(token), SESSION_TTL_MS, active?.companyId ?? null);
  await store.recordLogin(deps.web, user.userId);
  await store.writeAudit(deps, actorIn(user.userId, active), 'auth.login', { method });
  return { kind: 'session', token, landing: landingPath({ isSuperAdmin: user.isSuperAdmin, companyId: active?.companyId ?? null }) };
}

async function linkIfOAuth(deps: AuthDeps, userId: string, identity: VerifiedIdentity) {
  if (identity.account) await store.linkAccount(deps.web, userId, identity.account.provider, identity.account.id);
}

async function loginUserId(
  deps: AuthDeps,
  userId: string | null,
  identity: VerifiedIdentity,
  preferredCompanyId?: string | null,
): Promise<LoginResult> {
  const user = userId ? await store.getUser(deps.web, userId) : null;
  if (!user) return { kind: 'error', code: 'failed' };
  await linkIfOAuth(deps, user.userId, identity);
  return startSession(deps, user, identity.method, preferredCompanyId);
}

/** The verified identity as the sign-up cookie carries it, with the given e-mail (no stale `invitationsOnly`). */
function pendingFor(identity: PendingSignup, email: string, invitationsOnly: boolean): PendingSignup {
  const { invitationsOnly: _stale, ...rest } = identity;
  void _stale;
  return invitationsOnly ? { ...rest, email, invitationsOnly: true } : { ...rest, email };
}

/**
 * Applies the provisioning rules (provisioning.ts) to a verified identity: log in (into the last active
 * company), make a super admin, or go to the sign-up step. Nobody is put into a company automatically:
 * the sign-up step lists the e-mail's pending invitations and the user picks one
 * (acceptPendingInvitation) or creates their own workspace (completeSignup). Auto-accepting "the newest
 * invitation" let any company that invited the address first capture the account (SEC-1).
 */
export async function resolveIdentity(deps: AuthDeps, identity: PendingSignup): Promise<LoginResult> {
  const email = normalizeEmail(identity.email);
  if (!email) return { kind: 'error', code: 'failed' };
  identity = { ...identity, email };

  // An already linked OAuth account wins over the e-mail (the provider e-mail may have changed).
  const linked = identity.account ? await store.findAccountUser(deps.web, identity.account.provider, identity.account.id) : null;
  const existing = linked ? await store.getUser(deps.web, linked) : await store.findUserByEmail(deps.web, email);
  // The account's own e-mail decides super-admin status and is the one the sign-up step works on (D5).
  const subjectEmail = existing?.email ?? email;
  // Only asked when every company of the user is suspended, so the normal login path pays nothing.
  const hasPendingInvitations =
    existing !== null && existing.memberships > 0 && existing.activeMemberships === 0
      ? (await store.pendingInvitations(deps.web, subjectEmail)).length > 0
      : false;
  const decision = decideProvisioning(existing, superAdminEmails(deps.env).has(subjectEmail), hasPendingInvitations);

  switch (decision.kind) {
    case 'blocked':
      return { kind: 'error', code: decision.reason };
    case 'login':
      return loginUserId(deps, decision.userId, identity);
    case 'ensure-super-admin':
      return loginUserId(deps, await store.ensureSuperAdmin(deps.web, subjectEmail, identity.name), identity);
    case 'accept-invitation-or-signup':
      return { kind: 'signup', pending: pendingFor(identity, subjectEmail, false) };
    case 'accept-invitation-only':
      return { kind: 'signup', pending: pendingFor(identity, subjectEmail, true) };
  }
}

/** The pending invitations for an e-mail (newest first): the sign-up step and /invitations list them. */
export async function listPendingInvitations(deps: Pick<AuthDeps, 'web'>, email: string): Promise<store.PendingInvitation[]> {
  const normalized = normalizeEmail(email);
  return normalized ? store.pendingInvitations(deps.web, normalized) : [];
}

/**
 * The user confirmed "Join <company>" on the sign-up step: accepts exactly that invitation, then a
 * session in that company. Re-runs the rules first (the user may be able to log in by now, e.g. a double
 * submit → plain login). `{ kind: 'signup' }` back means the invitation is gone (expired, revoked, not
 * for this e-mail).
 */
export async function acceptPendingInvitation(deps: AuthDeps, pending: PendingSignup, invitationId: string): Promise<LoginResult> {
  const again = await resolveIdentity(deps, pending);
  if (again.kind !== 'signup') return again;
  const accepted = await store.acceptInvitation(deps.web, again.pending.email, pending.name, invitationId);
  if (!accepted) return again;
  const joined = (await store.listMemberships(deps.web, accepted.userId)).find((m) => m.companyId === accepted.companyId);
  await store.writeAudit(deps, actorIn(accepted.userId, joined), 'auth.invitation_accepted', { method: pending.method });
  return loginUserId(deps, accepted.userId, again.pending, accepted.companyId);
}

/** Solo sign-up (Free plan, one team, the user is admin + lead), then a session in the new company. */
export async function completeSignup(
  deps: AuthDeps,
  pending: PendingSignup,
  details: { name: string; company: string },
): Promise<LoginResult> {
  // Re-run the rules: the user may be able to log in by now (double submit) or be blocked. Pending
  // invitations do not stop this: the sign-up step showed them and the user chose their own workspace.
  const again = await resolveIdentity(deps, pending);
  if (again.kind !== 'signup') return again;
  if (again.pending.invitationsOnly) return { kind: 'error', code: 'suspended' };
  // The identity's own e-mail, so a linked OAuth account with another provider e-mail reuses the identity (D5).
  const userId = await store.createSoloCompany(deps.web, again.pending.email, details.name, details.company);
  const user = userId ? await store.getUser(deps.web, userId) : null;
  if (!user) return { kind: 'error', code: 'failed' };
  // auth_create_solo_company only accepts an identity without memberships, so the new company is its only one.
  const [company] = await store.listMemberships(deps.web, user.userId);
  await store.writeAudit(deps, actorIn(user.userId, company), 'auth.signup', { method: pending.method });
  await linkIfOAuth(deps, user.userId, again.pending);
  return startSession(deps, user, pending.method, company?.companyId);
}

/** Ends a session (logout), audited in the session's active company while the user is still a member there. */
export async function endSession(deps: AuthDeps, token: string | undefined): Promise<void> {
  if (!isWellFormedToken(token)) return;
  const session = await store.deleteSession(deps.web, hashToken(token));
  const user = session ? await store.getUser(deps.web, session.userId) : null;
  if (!session || !user) return;
  const m = (await store.listMemberships(deps.web, user.userId)).find((x) => x.companyId === session.activeCompanyId);
  await store.writeAudit(deps, actorIn(user.userId, m), 'auth.logout');
}

/**
 * The user behind a session token (sliding its expiry), working in the session's active company; null
 * if invalid. The active company is the stored one while it is still an active membership, else the
 * first active membership (last active first), and the session is repointed to it. `user.isSuperAdmin`
 * is the effective right: the DB flag AND the e-mail still in SUPER_ADMIN_EMAILS (read from `deps.env`,
 * default process.env), so removing an e-mail ends existing super-admin sessions. A user with no active
 * membership gets null (unless an effective super admin, who has none).
 */
export async function loadSessionUser(deps: Pick<AuthDeps, 'web'> & Partial<Pick<AuthDeps, 'env'>>, token: string | undefined) {
  if (!isWellFormedToken(token)) return null;
  const tokenHash = hashToken(token);
  const session = await store.touchSession(deps.web, tokenHash, SESSION_TTL_MS, SESSION_SLIDE_EVERY_MS);
  const row = session ? await store.getUser(deps.web, session.userId) : null;
  if (!session || !row) return null;
  const isSuperAdmin = isEffectiveSuperAdmin(row, superAdminEmails(deps.env ?? process.env));
  const all = await store.listMemberships(deps.web, row.userId);
  const active = chooseActive(all, session.activeCompanyId);
  if ((active?.companyId ?? null) !== session.activeCompanyId) {
    await store.setSessionCompany(deps.web, tokenHash, active?.companyId ?? null);
  }
  if (!active) {
    if (!isSuperAdmin) return null;
    return { user: { ...row, isSuperAdmin, companyId: null, companyRole: 'member' as CompanyRole }, context: null, memberships: [] };
  }
  const user = { ...row, isSuperAdmin, companyId: active.companyId as string | null, companyRole: active.companyRole };
  const context = await store.loadCompanyContext(deps.web, {
    userId: row.userId,
    companyId: active.companyId,
    companyRole: active.companyRole,
    primaryTeamId: active.primaryTeamId,
  });
  if (!context) return null;
  const memberships: MembershipSummary[] = all
    .filter((m) => m.companyStatus === 'active')
    .map((m) => ({ companyId: m.companyId, name: m.companyName, slug: m.companySlug, role: m.companyRole, plan: m.plan }));
  return { user, context, memberships };
}

const Uuid = z.uuid();

/**
 * The header switcher: points the session at another company the user belongs to. The SQL refuses a
 * company the user is not a member of, a suspended one and an expired session (false). One
 * `auth.company_switch` row is written in the destination company only, with empty meta: the
 * destination's admins can read their audit log and must not learn the origin company.
 */
export async function switchActiveCompany(deps: AuthDeps, token: string | undefined, companyId: unknown): Promise<boolean> {
  const id = Uuid.safeParse(companyId);
  if (!isWellFormedToken(token) || !id.success) return false;
  const current = await loadSessionUser(deps, token);
  if (!current) return false;
  if (current.user.companyId === id.data) return true;
  if (!(await store.setSessionCompany(deps.web, hashToken(token), id.data))) return false;
  const role = current.memberships.find((m) => m.companyId === id.data)?.role ?? 'member';
  await store.writeAudit(deps, actorIn(current.user.userId, { companyId: id.data, companyRole: role }), 'auth.company_switch');
  return true;
}

/**
 * A signed-in user accepts an invitation to another company (/invitations, D9): adds the membership to
 * their own identity (the invitation must be for their e-mail), switches the session there and audits
 * it in the new company. Null when the invitation is gone or not acceptable.
 */
export async function acceptInvitationForSession(
  deps: AuthDeps,
  token: string | undefined,
  invitationId: unknown,
): Promise<{ companyId: string } | null> {
  const id = Uuid.safeParse(invitationId);
  if (!isWellFormedToken(token) || !id.success) return null;
  const current = await loadSessionUser(deps, token);
  if (!current || !current.user.companyId) return null;
  const accepted = await store.acceptInvitation(deps.web, current.user.email, current.user.name, id.data);
  if (!accepted) return null;
  if (accepted.userId !== current.user.userId) throw new Error('accepted an invitation for another identity');
  await store.setSessionCompany(deps.web, hashToken(token), accepted.companyId);
  const joined = (await store.listMemberships(deps.web, accepted.userId)).find((m) => m.companyId === accepted.companyId);
  await store.writeAudit(deps, actorIn(accepted.userId, joined), 'auth.invitation_accepted', { method: 'session' });
  return { companyId: accepted.companyId };
}
