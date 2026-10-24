import type { MemberRole, UserKind } from '@ai-obs/db';

/** What auth_find_user_by_email / auth_get_user say about an e-mail: the identity and its membership role (or null). */
export interface ExistingUser {
  userId: string;
  kind: UserKind;
  /** memberships.role; null when the identity has no membership (removed member, ADR-0022 D1). */
  role: MemberRole | null;
}

/** Why a new member got in (written to the audit log). */
export type ProvisioningRule = 'admin-email' | 'invitation' | 'allowed-domain';

export type ProvisioningDecision =
  | { kind: 'login'; userId: string }
  /** auth_provision_member with this role, then any pending invitations are accepted for their teams. */
  | { kind: 'provision'; role: MemberRole; rule: 'admin-email' | 'allowed-domain' }
  /** auth_accept_invitation for every pending invitation (the first one creates the membership). */
  | { kind: 'accept-invitations' }
  /**
   * `not-invited`: unknown e-mail, not in ADMIN_EMAILS, no invitation, domain not allowed.
   * `removed`: the identity exists but its membership was removed, and nobody re-invited it.
   */
  | { kind: 'refuse'; reason: 'not-invited' | 'removed' };

export interface ProvisioningInput {
  existing: ExistingUser | null;
  /** The e-mail is listed in ADMIN_EMAILS. */
  isAdminEmail: boolean;
  /** At least one open invitation exists for the e-mail. */
  hasInvitation: boolean;
  /** The verified e-mail's domain is listed in ALLOWED_EMAIL_DOMAINS. */
  domainAllowed: boolean;
}

/**
 * Login provisioning for a verified e-mail (ADR-0028 E6, E7). Pure, so the rules are unit-tested.
 * - A person with a membership logs in.
 * - An e-mail never seen before becomes admin when listed in ADMIN_EMAILS, else a member through its pending
 *   invitations (auto-accepted, team and role from the invitation), else a member with no team when its domain is in
 *   ALLOWED_EMAIL_DOMAINS, else it is refused.
 * - An identity whose membership was removed gets back in only through a new invitation: ADMIN_EMAILS grants admin
 *   at first login only, and the domain rule must not undo an admin's removal.
 * - Service users have no e-mail and never log in.
 */
export function decideProvisioning(input: ProvisioningInput): ProvisioningDecision {
  const { existing } = input;
  if (existing && existing.kind !== 'person') return { kind: 'refuse', reason: 'not-invited' };
  if (existing?.role) return { kind: 'login', userId: existing.userId };
  if (existing) return input.hasInvitation ? { kind: 'accept-invitations' } : { kind: 'refuse', reason: 'removed' };
  if (input.isAdminEmail) return { kind: 'provision', role: 'admin', rule: 'admin-email' };
  if (input.hasInvitation) return { kind: 'accept-invitations' };
  if (input.domainAllowed) return { kind: 'provision', role: 'member', rule: 'allowed-domain' };
  return { kind: 'refuse', reason: 'not-invited' };
}

/** The domain part of a normalized e-mail ('' when there is none). */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).toLowerCase();
}

/** Exact domain match against ALLOWED_EMAIL_DOMAINS (no sub-domain wildcard: `corp.example` does not admit `x.corp.example`). */
export function isAllowedDomain(email: string, allowed: ReadonlySet<string>): boolean {
  const domain = emailDomain(email);
  return domain !== '' && allowed.has(domain);
}

/**
 * The order invitations are auto-accepted in: an admin invitation first (the first accepted invitation creates the
 * membership and so decides the role and primary team), otherwise newest first as auth_pending_invitations returns them.
 */
export function acceptanceOrder<T extends { role: MemberRole }>(invitations: readonly T[]): T[] {
  return [...invitations.filter((i) => i.role === 'admin'), ...invitations.filter((i) => i.role !== 'admin')];
}

/** Where a user lands after login: the one-time welcome notice after joining, else `next` or /overview. */
export function landingPath(joined: boolean, next: string | null): string {
  if (joined) return next ? `/welcome?next=${encodeURIComponent(next)}` : '/welcome';
  return next ?? '/overview';
}
