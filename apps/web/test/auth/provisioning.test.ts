import { describe, expect, it } from 'vitest';
import { decideProvisioning, isEffectiveSuperAdmin, landingPath, type ExistingUser } from '../../src/lib/auth/provisioning';

const member: ExistingUser = { userId: 'u1', companyId: 'c1', isSuperAdmin: false, companyStatus: 'active' };
const superAdmin: ExistingUser = { userId: 's1', companyId: null, isSuperAdmin: true, companyStatus: null };

describe('decideProvisioning', () => {
  it('logs existing users in', () => {
    expect(decideProvisioning(member, false)).toEqual({ kind: 'login', userId: 'u1' });
    expect(decideProvisioning(member, true)).toEqual({ kind: 'login', userId: 'u1' }); // company members never become super admins
    expect(decideProvisioning(superAdmin, true)).toEqual({ kind: 'login', userId: 's1' });
  });
  it('SEC-5: a super admin whose e-mail left SUPER_ADMIN_EMAILS is refused', () => {
    expect(decideProvisioning(superAdmin, false)).toEqual({ kind: 'blocked', reason: 'no-company' });
    const listed = new Set(['root@x.example']);
    expect(isEffectiveSuperAdmin({ isSuperAdmin: true, email: 'Root@X.example' }, listed)).toBe(true);
    expect(isEffectiveSuperAdmin({ isSuperAdmin: true, email: 'gone@x.example' }, listed)).toBe(false);
    expect(isEffectiveSuperAdmin({ isSuperAdmin: false, email: 'root@x.example' }, listed)).toBe(false); // listing alone is not enough
  });
  it('blocks suspended companies and company-less non-admins', () => {
    expect(decideProvisioning({ ...member, companyStatus: 'suspended' }, false)).toEqual({ kind: 'blocked', reason: 'suspended' });
    const orphan = { ...superAdmin, isSuperAdmin: false };
    expect(decideProvisioning(orphan, false)).toEqual({ kind: 'blocked', reason: 'no-company' });
    expect(decideProvisioning(orphan, true)).toEqual({ kind: 'ensure-super-admin' });
  });
  it('new e-mails: super admin list first, else the sign-up step (invitations offered, never auto-accepted)', () => {
    expect(decideProvisioning(null, true)).toEqual({ kind: 'ensure-super-admin' });
    expect(decideProvisioning(null, false)).toEqual({ kind: 'accept-invitation-or-signup' });
  });
  it('lands super admins on /super, others on /overview', () => {
    expect(landingPath(superAdmin)).toBe('/super');
    expect(landingPath(member)).toBe('/overview');
  });
});
