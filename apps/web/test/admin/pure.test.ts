import { describe, expect, it } from 'vitest';
import { auditCsv, metaSummary } from '../../src/lib/admin/audit';
import { pgCode, userMessage } from '../../src/lib/admin/errors';
import { formObject, parse } from '../../src/lib/admin/input';
import { invitationEmail, invitationInput } from '../../src/lib/admin/invitations';
import { canCreateToken, canEnterAdmin, canManageBudgets, canRevokeToken, isLead } from '../../src/lib/admin/permissions';
import { budgetsAllowed, capacityError, formatLimit, PLAN_LIMITS, planOverages, remaining, retentionBounds, retentionError } from '../../src/lib/admin/plans';
import { staleCompany } from '../../src/lib/admin/run';
import { collectorCommand, mdmConfig } from '../../src/lib/admin/tokens';
import { AdminError, type Actor } from '../../src/lib/admin/types';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const actor = (over: Partial<Actor> = {}): Actor => ({ id: 'u-me', companyId: 'c', companyRole: 'member', teams: [{ id: T1, role: 'member' }], ...over });
const admin = actor({ companyRole: 'admin', teams: [] });
const lead = actor({ teams: [{ id: T1, role: 'lead' }, { id: T2, role: 'member' }] });
const member = actor();

describe('plan limits (BRIEF §10)', () => {
  it('uses the shared table from @ai-obs/db', () => {
    expect(PLAN_LIMITS.free).toMatchObject({ users: 3, teams: 1, maxRetentionDays: 30, budgets: false });
    expect(PLAN_LIMITS.team).toMatchObject({ users: 50, teams: 10, budgets: true });
    expect(PLAN_LIMITS.business.users).toBeNull();
  });
  it('capacityError blocks only beyond the limit', () => {
    expect(capacityError('free', 'teams', 0)).toBeNull();
    expect(capacityError('free', 'teams', 1)).toMatch(/free plan allows 1 teams/);
    expect(capacityError('free', 'users', 2)).toBeNull();
    expect(capacityError('free', 'users', 3)).toMatch(/free plan allows 3 members.*pending invitations/);
    expect(capacityError('team', 'users', 49)).toBeNull();
    expect(capacityError('team', 'users', 48, 3)).not.toBeNull();
    expect(capacityError('business', 'teams', 10_000)).toBeNull();
  });
  it('remaining / formatLimit', () => {
    expect(remaining(3, 1)).toBe(2);
    expect(remaining(3, 5)).toBe(0);
    expect(remaining(null, 5)).toBeNull();
    expect(formatLimit(null)).toBe('unlimited');
  });
  it('retention bounds follow the plan', () => {
    expect(retentionBounds('free')).toEqual({ min: 30, max: 30 });
    expect(retentionBounds('business').max).toBe(730);
    expect(retentionError('team', 395)).toBeNull();
    expect(retentionError('team', 396)).toMatch(/between 30 and 395/);
    expect(retentionError('team', 29)).not.toBeNull();
    expect(retentionError('team', 100.5)).not.toBeNull();
  });
  it('planOverages lists grandfathered usage above the plan, [] otherwise', () => {
    expect(planOverages('free', { users: 3, pendingInvitations: 0, teams: 1, retentionDays: 30 })).toEqual([]);
    const over = planOverages('free', { users: 20, pendingInvitations: 2, teams: 5, retentionDays: 90 });
    expect(over).toHaveLength(3);
    expect(over.join(' ')).toMatch(/22 users.*limit of 3/);
    expect(over.join(' ')).toMatch(/5 teams.*limit of 1/);
    expect(over.join(' ')).toMatch(/90 days.*maximum of 30/);
    expect(planOverages('business', { users: 10_000, teams: 10_000 })).toEqual([]);
  });
  it('budgets are not on Free', () => {
    expect(budgetsAllowed('free')).toBe(false);
    expect(budgetsAllowed('team')).toBe(true);
  });
});

describe('token-kind permissions (ADR-0022, brief Q2/Q9)', () => {
  it('user tokens: anyone, for themselves', () => {
    expect(canCreateToken(member, 'user')).toBe(true);
    expect(canCreateToken(lead, 'user')).toBe(true);
    expect(canCreateToken(admin, 'user')).toBe(true);
  });
  it('company tokens: admins, and leads of any team; plain members never', () => {
    expect(canCreateToken(member, 'company')).toBe(false);
    expect(canCreateToken(lead, 'company')).toBe(true);
    expect(canCreateToken(admin, 'company')).toBe(true);
  });
  it('revoke: own user tokens, company tokens for leads, admins everything (D6)', () => {
    const mine = { kind: 'user' as const, userId: 'u-me' };
    const someoneElses = { kind: 'user' as const, userId: 'u-other' };
    const companyTok = { kind: 'company' as const, userId: null };
    expect(canRevokeToken(member, mine)).toBe(true);
    expect(canRevokeToken(member, someoneElses)).toBe(false);
    expect(canRevokeToken(lead, someoneElses)).toBe(false);
    expect(canRevokeToken(member, companyTok)).toBe(false);
    expect(canRevokeToken(lead, companyTok)).toBe(true);
    expect(canRevokeToken(admin, someoneElses)).toBe(true);
    expect(canRevokeToken(admin, companyTok)).toBe(true);
  });
  it('admin area: admins and leads; budgets managed by admins only', () => {
    expect(canEnterAdmin(admin)).toBe(true);
    expect(canEnterAdmin(lead)).toBe(true);
    expect(canEnterAdmin(member)).toBe(false);
    expect(isLead(lead)).toBe(true);
    expect(canManageBudgets(lead)).toBe(false);
    expect(canManageBudgets(admin)).toBe(true);
  });
});

describe('helpers', () => {
  it('collector command and MDM config', () => {
    expect(collectorCommand('aiobs_c_x', 'https://obs.example/')).toBe('npx @soukupl/ai-obs init --token aiobs_c_x --endpoint https://obs.example');
    expect(mdmConfig('aiobs_c_x', 'https://obs.example', { slug: 'acme' })).toEqual({
      endpoint: 'https://obs.example',
      token: 'aiobs_c_x',
      company: 'acme',
      install: 'npx @soukupl/ai-obs init --token aiobs_c_x --endpoint https://obs.example',
    });
  });
  it('invitation e-mail links to the login page and escapes HTML', () => {
    const m = invitationEmail(
      { id: 'i', email: 'new@x.test', teamName: 'A<b>', companyName: 'Acme & Co', expiresAt: new Date('2026-10-13T00:00:00Z') },
      { appUrl: 'https://obs.example', inviter: 'Alice' },
    );
    expect(m.to).toBe('new@x.test');
    expect(m.text).toContain('https://obs.example/login?next=/invitations');
    expect(m.text).toContain('open Invitations');
    expect(m.text).toContain('2026-10-13');
    expect(m.html).toContain('Acme &amp; Co');
    expect(m.html).not.toContain('A<b>');
  });
  it('input parsing: lower-cases e-mails, empty select → null, readable errors', () => {
    expect(parse(invitationInput, { email: ' New@X.Test ', teamId: '' })).toMatchObject({ email: 'new@x.test', teamId: null, teamRole: 'member', companyRole: 'member' });
    expect(() => parse(invitationInput, { email: 'nope' })).toThrow(AdminError);
    const fd = new FormData();
    fd.set('name', 'x');
    fd.set('$ACTION_ID_abc', '');
    expect(formObject(fd)).toEqual({ name: 'x' });
    fd.set('_companyId', 'c-1');
    expect(formObject(fd)).toEqual({ name: 'x' });
  });
  it('D10: a form rendered for another company, or without the field, is refused', () => {
    const fd = new FormData();
    expect(staleCompany(fd, 'B')).toMatchObject({ status: 'error', message: expect.stringMatching(/active company changed/) });
    fd.set('_companyId', 'A');
    expect(staleCompany(fd, 'B')).toMatchObject({ status: 'error' });
    fd.set('_companyId', 'B');
    expect(staleCompany(fd, 'B')).toBeNull();
  });
  it('error messages never leak SQL', () => {
    expect(userMessage(new AdminError('Nope.'))).toBe('Nope.');
    expect(userMessage({ cause: { code: '23505' } })).toBe('That already exists.');
    expect(userMessage({ code: '42501' })).toMatch(/not allowed/);
    expect(userMessage(new Error('relation "x" does not exist'))).toMatch(/Something went wrong/);
    expect(pgCode({ cause: { code: '23503' } })).toBe('23503');
  });
  it('audit meta summary and CSV', () => {
    expect(metaSummary({ kind: 'company', limit: 5, after: { a: 1 } })).toBe('kind=company, limit=5, after={"a":1}');
    expect(metaSummary({ s: 'x'.repeat(300) }).length).toBe(120);
    const csv = auditCsv([{ id: '1', atMs: Date.UTC(2026, 9, 6), actor: 'Alice', action: 'team.create', target: 'team:1', meta: { name: 'A' } }]);
    expect(csv.headers).toEqual(['at', 'actor', 'action', 'target', 'meta']);
    expect(csv.rows[0]).toEqual(['2026-10-06T00:00:00.000Z', 'Alice', 'team.create', 'team:1', '{"name":"A"}']);
  });
});
