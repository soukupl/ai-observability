import { describe, expect, it } from 'vitest';
import { decideProvisioning, isEffectiveSuperAdmin, landingPath, type ExistingUser } from '../../src/lib/auth/provisioning';

const member: ExistingUser = { userId: 'u1', isSuperAdmin: false, memberships: 2, activeMemberships: 2 };
const superAdmin: ExistingUser = { userId: 's1', isSuperAdmin: true, memberships: 0, activeMemberships: 0 };
/** An identity whose last membership was removed (D5). */
const orphan: ExistingUser = { userId: 'o1', isSuperAdmin: false, memberships: 0, activeMemberships: 0 };

describe('decideProvisioning', () => {
  it('logs existing members in (into the last active company, chosen by the caller)', () => {
    expect(decideProvisioning(member, false)).toEqual({ kind: 'login', userId: 'u1' });
    expect(decideProvisioning(member, true)).toEqual({ kind: 'login', userId: 'u1' }); // company members never become super admins
    expect(decideProvisioning({ ...member, activeMemberships: 1 }, false)).toEqual({ kind: 'login', userId: 'u1' }); // one company suspended
    expect(decideProvisioning(superAdmin, true)).toEqual({ kind: 'login', userId: 's1' });
  });
  it('SEC-5: a super admin whose e-mail left SUPER_ADMIN_EMAILS is refused', () => {
    expect(decideProvisioning(superAdmin, false)).toEqual({ kind: 'blocked', reason: 'no-company' });
    const listed = new Set(['root@x.example']);
    expect(isEffectiveSuperAdmin({ isSuperAdmin: true, email: 'Root@X.example' }, listed)).toBe(true);
    expect(isEffectiveSuperAdmin({ isSuperAdmin: true, email: 'gone@x.example' }, listed)).toBe(false);
    expect(isEffectiveSuperAdmin({ isSuperAdmin: false, email: 'root@x.example' }, listed)).toBe(false); // listing alone is not enough
  });
  it('D5: an identity without memberships goes through the sign-up step, like a new e-mail', () => {
    expect(decideProvisioning(orphan, false)).toEqual({ kind: 'accept-invitation-or-signup' });
    expect(decideProvisioning(orphan, false, true)).toEqual({ kind: 'accept-invitation-or-signup' });
    expect(decideProvisioning(orphan, true)).toEqual({ kind: 'ensure-super-admin' });
  });
  it('all companies suspended: invitations-only sign-up step when invited, else blocked', () => {
    const suspended: ExistingUser = { ...member, activeMemberships: 0 };
    expect(decideProvisioning(suspended, false)).toEqual({ kind: 'blocked', reason: 'suspended' });
    expect(decideProvisioning(suspended, false, false)).toEqual({ kind: 'blocked', reason: 'suspended' });
    expect(decideProvisioning(suspended, false, true)).toEqual({ kind: 'accept-invitation-only' });
    expect(decideProvisioning(suspended, true, true)).toEqual({ kind: 'accept-invitation-only' }); // still a member: never a super admin
  });
  it('new e-mails: super admin list first, else the sign-up step (invitations offered, never auto-accepted)', () => {
    expect(decideProvisioning(null, true)).toEqual({ kind: 'ensure-super-admin' });
    expect(decideProvisioning(null, false)).toEqual({ kind: 'accept-invitation-or-signup' });
    expect(decideProvisioning(null, false, true)).toEqual({ kind: 'accept-invitation-or-signup' });
  });
  it('lands super admins on /super, others on /overview', () => {
    expect(landingPath({ isSuperAdmin: true, companyId: null })).toBe('/super');
    expect(landingPath({ isSuperAdmin: false, companyId: 'c1' })).toBe('/overview');
  });
});
