/** What auth_find_user_by_email / auth_get_user return, camel-cased: the identity and its membership counts. */
export interface ExistingUser {
  userId: string;
  isSuperAdmin: boolean;
  /** Companies the user belongs to (company_memberships rows). */
  memberships: number;
  /** Of those, the companies that are not suspended. */
  activeMemberships: number;
}

export type ProvisioningDecision =
  | { kind: 'login'; userId: string }
  | { kind: 'ensure-super-admin' }
  /**
   * New e-mail, or an identity with no memberships (e.g. removed from its last company), not a super
   * admin: the sign-up step, which lists the e-mail's pending invitations (auth_pending_invitations)
   * to join explicitly, next to the solo sign-up form. Never auto-accepted.
   */
  | { kind: 'accept-invitation-or-signup' }
  /** Every company of the user is suspended, but an active company invited them: the sign-up step without solo sign-up. */
  | { kind: 'accept-invitation-only' }
  | { kind: 'blocked'; reason: 'suspended' | 'no-company' };

/**
 * Provisioning rules for a verified e-mail (BRIEF §4, ADR-0013, ADR-0022). Pure, so the rules are unit-tested.
 * - New e-mail in SUPER_ADMIN_EMAILS: platform super admin (wins over a pending invitation, because
 *   super admins cannot be company members). Otherwise: the sign-up step.
 * - Identity without memberships: a super admin only while the e-mail is still in SUPER_ADMIN_EMAILS
 *   (the list is the source of truth: removing an e-mail revokes the console, see isEffectiveSuperAdmin,
 *   and such an identity is blocked); any other identity goes through the sign-up step like a new e-mail.
 * - Member of companies that are all suspended: the invitations-only sign-up step when another company
 *   invited them (`hasPendingInvitations`), else blocked.
 * - Otherwise: log in (into the last active company, chosen by the caller).
 */
export function decideProvisioning(
  existing: ExistingUser | null,
  isSuperAdminEmail: boolean,
  hasPendingInvitations = false,
): ProvisioningDecision {
  if (!existing) return isSuperAdminEmail ? { kind: 'ensure-super-admin' } : { kind: 'accept-invitation-or-signup' };
  if (existing.memberships === 0) {
    if (isSuperAdminEmail) return existing.isSuperAdmin ? { kind: 'login', userId: existing.userId } : { kind: 'ensure-super-admin' };
    // A super admin removed from SUPER_ADMIN_EMAILS can neither join nor create a company (the DB refuses both).
    return existing.isSuperAdmin ? { kind: 'blocked', reason: 'no-company' } : { kind: 'accept-invitation-or-signup' };
  }
  if (existing.activeMemberships === 0) {
    return hasPendingInvitations ? { kind: 'accept-invitation-only' } : { kind: 'blocked', reason: 'suspended' };
  }
  return { kind: 'login', userId: existing.userId };
}

/**
 * Super-admin rights need BOTH the DB flag (users.is_super_admin) and the e-mail still listed in
 * SUPER_ADMIN_EMAILS, checked on every request, so deleting an e-mail from the list revokes the
 * console at once, existing sessions included.
 */
export function isEffectiveSuperAdmin(user: { isSuperAdmin: boolean; email: string }, superAdminEmails: ReadonlySet<string>): boolean {
  return user.isSuperAdmin && superAdminEmails.has(user.email.toLowerCase());
}

/** Where a user lands after login when no (safe) `next` was given. */
export function landingPath(user: { isSuperAdmin: boolean; companyId: string | null }): string {
  return user.isSuperAdmin && !user.companyId ? '/super' : '/overview';
}
