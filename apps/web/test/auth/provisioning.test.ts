import { describe, expect, it } from 'vitest';
import {
  acceptanceOrder,
  decideProvisioning,
  emailDomain,
  isAllowedDomain,
  landingPath,
  type ExistingUser,
  type ProvisioningInput,
} from '../../src/lib/auth/provisioning';

const member: ExistingUser = { userId: 'u1', kind: 'person', role: 'member' };
const admin: ExistingUser = { userId: 'a1', kind: 'person', role: 'admin' };
const removed: ExistingUser = { userId: 'r1', kind: 'person', role: null };
const service: ExistingUser = { userId: 's1', kind: 'service', role: 'member' };
const input = (over: Partial<ProvisioningInput>): ProvisioningInput => ({
  existing: null,
  isAdminEmail: false,
  hasInvitation: false,
  domainAllowed: false,
  ...over,
});

describe('login provisioning (ADR-0028 E6, E7)', () => {
  it('an existing member logs in, whatever the other rules say', () => {
    expect(decideProvisioning(input({ existing: member }))).toEqual({ kind: 'login', userId: 'u1' });
    expect(decideProvisioning(input({ existing: admin, isAdminEmail: true, hasInvitation: true, domainAllowed: true }))).toEqual({ kind: 'login', userId: 'a1' });
  });

  it('an unknown e-mail in ADMIN_EMAILS becomes admin (wins over an invitation and the domain rule)', () => {
    expect(decideProvisioning(input({ isAdminEmail: true }))).toEqual({ kind: 'provision', role: 'admin', rule: 'admin-email' });
    expect(decideProvisioning(input({ isAdminEmail: true, hasInvitation: true, domainAllowed: true }))).toEqual({
      kind: 'provision',
      role: 'admin',
      rule: 'admin-email',
    });
  });

  it('an invited unknown e-mail joins through its invitations (auto-accepted, before the domain rule)', () => {
    expect(decideProvisioning(input({ hasInvitation: true }))).toEqual({ kind: 'accept-invitations' });
    expect(decideProvisioning(input({ hasInvitation: true, domainAllowed: true }))).toEqual({ kind: 'accept-invitations' });
  });

  it('an unknown e-mail of an allowed domain joins as a member', () => {
    expect(decideProvisioning(input({ domainAllowed: true }))).toEqual({ kind: 'provision', role: 'member', rule: 'allowed-domain' });
  });

  it('refuses an unknown e-mail that no rule admits', () => {
    expect(decideProvisioning(input({}))).toEqual({ kind: 'refuse', reason: 'not-invited' });
  });

  it('a removed member gets back in only through a new invitation (not ADMIN_EMAILS, not the domain rule)', () => {
    expect(decideProvisioning(input({ existing: removed, isAdminEmail: true, domainAllowed: true }))).toEqual({ kind: 'refuse', reason: 'removed' });
    expect(decideProvisioning(input({ existing: removed, hasInvitation: true }))).toEqual({ kind: 'accept-invitations' });
  });

  it('a service user never logs in', () => {
    expect(decideProvisioning(input({ existing: service, isAdminEmail: true, hasInvitation: true }))).toEqual({ kind: 'refuse', reason: 'not-invited' });
  });
});

describe('domain allow-list', () => {
  it('matches the exact domain of a normalized e-mail, no sub-domains', () => {
    const allowed = new Set(['corp.example']);
    expect(emailDomain('a@corp.example')).toBe('corp.example');
    expect(emailDomain('nobody')).toBe('');
    expect(isAllowedDomain('dev@corp.example', allowed)).toBe(true);
    expect(isAllowedDomain('dev@sub.corp.example', allowed)).toBe(false);
    expect(isAllowedDomain('dev@corp.example.evil', allowed)).toBe(false);
    expect(isAllowedDomain('corp.example', allowed)).toBe(false);
    expect(isAllowedDomain('dev@corp.example', new Set())).toBe(false);
  });
});

describe('invitation acceptance order', () => {
  it('accepts an admin invitation first (the first accepted creates the membership), else newest first', () => {
    const invs = [
      { id: 'new-member', role: 'member' as const },
      { id: 'old-admin', role: 'admin' as const },
      { id: 'old-member', role: 'member' as const },
    ];
    expect(acceptanceOrder(invs).map((i) => i.id)).toEqual(['old-admin', 'new-member', 'old-member']);
    expect(acceptanceOrder([])).toEqual([]);
  });
});

describe('landing path', () => {
  it('shows the one-time welcome notice after joining, keeping `next`', () => {
    expect(landingPath(true, null)).toBe('/welcome');
    expect(landingPath(true, '/device?code=ABCD-EFGH')).toBe('/welcome?next=%2Fdevice%3Fcode%3DABCD-EFGH');
    expect(landingPath(false, null)).toBe('/overview');
    expect(landingPath(false, '/device')).toBe('/device');
  });
});
