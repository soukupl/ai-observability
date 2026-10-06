import { dbFor, type Database } from '@ai-obs/db';
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

/** Carried in the signed sign-up cookie until the user submits name + company. */
export type PendingSignup = VerifiedIdentity;

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

async function startSession(deps: AuthDeps, user: store.UserRow, method: LoginMethod): Promise<LoginResult> {
  const token = newToken();
  await store.insertSession(deps.web, user.userId, hashToken(token), SESSION_TTL_MS);
  await store.recordLogin(deps.web, user.userId);
  await store.writeAudit(deps, user, 'auth.login', { method });
  return { kind: 'session', token, landing: landingPath(user) };
}

async function linkIfOAuth(deps: AuthDeps, userId: string, identity: VerifiedIdentity) {
  if (identity.account) await store.linkAccount(deps.web, userId, identity.account.provider, identity.account.id);
}

async function loginUserId(deps: AuthDeps, userId: string | null, identity: VerifiedIdentity): Promise<LoginResult> {
  const user = userId ? await store.getUser(deps.web, userId) : null;
  if (!user) return { kind: 'error', code: 'failed' };
  await linkIfOAuth(deps, user.userId, identity);
  return startSession(deps, user, identity.method);
}

/**
 * Applies the provisioning rules (provisioning.ts) to a verified identity: log in, make a super
 * admin, or go to the sign-up step. A new e-mail is never put into a company automatically: the
 * sign-up step lists its pending invitations and the user picks one (acceptPendingInvitation) or
 * creates their own workspace (completeSignup). Auto-accepting "the newest invitation" let any
 * company that invited the address first capture the account (SEC-1).
 */
export async function resolveIdentity(deps: AuthDeps, identity: VerifiedIdentity): Promise<LoginResult> {
  const email = normalizeEmail(identity.email);
  if (!email) return { kind: 'error', code: 'failed' };
  identity = { ...identity, email };

  // An already linked OAuth account wins over the e-mail (the provider e-mail may have changed).
  const linked = identity.account ? await store.findAccountUser(deps.web, identity.account.provider, identity.account.id) : null;
  const existing = linked ? await store.getUser(deps.web, linked) : await store.findUserByEmail(deps.web, email);
  // The account's own e-mail decides super-admin status (a linked provider e-mail may differ).
  const subjectEmail = existing?.email ?? email;
  const decision = decideProvisioning(existing, superAdminEmails(deps.env).has(subjectEmail));

  switch (decision.kind) {
    case 'blocked':
      return { kind: 'error', code: decision.reason };
    case 'login':
      return loginUserId(deps, decision.userId, identity);
    case 'ensure-super-admin':
      return loginUserId(deps, await store.ensureSuperAdmin(deps.web, subjectEmail, identity.name), identity);
    case 'accept-invitation-or-signup':
      return { kind: 'signup', pending: identity };
  }
}

/** The pending invitations the sign-up step offers for a verified e-mail (newest first). */
export async function listPendingInvitations(deps: Pick<AuthDeps, 'web'>, email: string): Promise<store.PendingInvitation[]> {
  const normalized = normalizeEmail(email);
  return normalized ? store.pendingInvitations(deps.web, normalized) : [];
}

/**
 * The user confirmed "Join <company>" on the sign-up step: accepts exactly that invitation, then a
 * session. Re-runs the rules first (the user may exist by now, e.g. a double submit → plain login).
 * `{ kind: 'signup' }` back means the invitation is gone (expired, revoked, not for this e-mail).
 */
export async function acceptPendingInvitation(deps: AuthDeps, pending: PendingSignup, invitationId: string): Promise<LoginResult> {
  const again = await resolveIdentity(deps, pending);
  if (again.kind !== 'signup') return again;
  const userId = await store.acceptInvitation(deps.web, again.pending.email, pending.name, invitationId);
  if (!userId) return again;
  const user = await store.getUser(deps.web, userId);
  if (user) await store.writeAudit(deps, user, 'auth.invitation_accepted', { method: pending.method });
  return loginUserId(deps, userId, again.pending);
}

/** Solo sign-up (Free plan, one team, the user is admin + lead), then a session. */
export async function completeSignup(
  deps: AuthDeps,
  pending: PendingSignup,
  details: { name: string; company: string },
): Promise<LoginResult> {
  // Re-run the rules: the user may already exist (double submit) or be blocked. Pending invitations do
  // not stop this: the sign-up step showed them and the user chose their own workspace.
  const again = await resolveIdentity(deps, pending);
  if (again.kind !== 'signup') return again;
  const userId = await store.createSoloCompany(deps.web, pending.email, details.name, details.company);
  const user = userId ? await store.getUser(deps.web, userId) : null;
  if (!user) return { kind: 'error', code: 'failed' };
  await store.writeAudit(deps, user, 'auth.signup', { method: pending.method });
  await linkIfOAuth(deps, user.userId, pending);
  return startSession(deps, user, pending.method);
}

/** Ends a session (logout). Unknown tokens are ignored. */
export async function endSession(deps: AuthDeps, token: string | undefined): Promise<void> {
  if (!isWellFormedToken(token)) return;
  const userId = await store.deleteSession(deps.web, hashToken(token));
  const user = userId ? await store.getUser(deps.web, userId) : null;
  if (user) await store.writeAudit(deps, user, 'auth.logout');
}

/**
 * The user behind a session token (sliding its expiry), with company + teams; null if invalid.
 * `user.isSuperAdmin` is the effective right: the DB flag AND the e-mail still in SUPER_ADMIN_EMAILS
 * (read from `deps.env`, default process.env), so removing an e-mail ends existing super-admin sessions.
 */
export async function loadSessionUser(deps: Pick<AuthDeps, 'web'> & Partial<Pick<AuthDeps, 'env'>>, token: string | undefined) {
  if (!isWellFormedToken(token)) return null;
  const userId = await store.touchSession(deps.web, hashToken(token), SESSION_TTL_MS, SESSION_SLIDE_EVERY_MS);
  const row = userId ? await store.getUser(deps.web, userId) : null;
  if (!row || row.companyStatus === 'suspended') return null;
  const user = { ...row, isSuperAdmin: isEffectiveSuperAdmin(row, superAdminEmails(deps.env ?? process.env)) };
  if (!user.companyId) return user.isSuperAdmin ? { user, context: null } : null;
  const context = await store.loadCompanyContext(deps.web, user);
  return context ? { user, context } : null;
}
