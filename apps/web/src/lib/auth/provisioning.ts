/** What auth_find_user_by_email / auth_get_user return, camel-cased. */
export interface ExistingUser {
  userId: string;
  companyId: string | null;
  isSuperAdmin: boolean;
  companyStatus: 'active' | 'suspended' | null;
}

export type ProvisioningDecision =
  | { kind: 'login'; userId: string }
  | { kind: 'ensure-super-admin' }
  /**
   * New e-mail, not a super admin: the sign-up step, which lists the e-mail's pending invitations
   * (auth_pending_invitations) to join explicitly, next to the solo sign-up form. Never auto-accepted.
   */
  | { kind: 'accept-invitation-or-signup' }
  | { kind: 'blocked'; reason: 'suspended' | 'no-company' };

/**
 * Provisioning rules for a verified e-mail (BRIEF §4, ADR-0013). Pure, so the rules are unit-tested.
 * - Existing company user: log in (unless the company is suspended).
 * - Existing company-less user: a super admin only while the e-mail is still in SUPER_ADMIN_EMAILS
 *   (the list is the source of truth: removing an e-mail revokes the console, see
 *   isEffectiveSuperAdmin); otherwise blocked.
 * - New e-mail in SUPER_ADMIN_EMAILS: platform super admin (wins over a pending invitation, because
 *   super admins cannot be company members).
 * - Otherwise: the sign-up step (join an invitation the user picks, or solo sign-up).
 */
export function decideProvisioning(existing: ExistingUser | null, isSuperAdminEmail: boolean): ProvisioningDecision {
  if (!existing) return isSuperAdminEmail ? { kind: 'ensure-super-admin' } : { kind: 'accept-invitation-or-signup' };
  if (existing.companyId === null) {
    if (!isSuperAdminEmail) return { kind: 'blocked', reason: 'no-company' };
    return existing.isSuperAdmin ? { kind: 'login', userId: existing.userId } : { kind: 'ensure-super-admin' };
  }
  if (existing.companyStatus === 'suspended') return { kind: 'blocked', reason: 'suspended' };
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
