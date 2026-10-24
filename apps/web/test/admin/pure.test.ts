import { describe, expect, it } from 'vitest';
import { navFor } from '../../src/components/nav';
import { auditCsv, metaSummary } from '../../src/lib/admin/audit';
import { settingsInput } from '../../src/lib/admin/deployment';
import { pgCode, userMessage } from '../../src/lib/admin/errors';
import { adminTabsFor } from '../../src/lib/admin/guard';
import { formObject, parse, teamSlug } from '../../src/lib/admin/input';
import { invitationEmail, invitationInput } from '../../src/lib/admin/invitations';
import { modelPriceInput } from '../../src/lib/admin/model-prices';
import { canCreateTokenFor, canEnterAdmin, canManageBudgets, canRevokeToken, isLead } from '../../src/lib/admin/permissions';
import {
  collectorCommand,
  DEFAULT_TOKEN_LIFETIME,
  EXPIRY_WARNING_DAYS,
  expiresAtFor,
  ownTokenInput,
  serviceTokenInput,
  tokenState,
} from '../../src/lib/admin/tokens';
import { AdminError, type Actor } from '../../src/lib/admin/types';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const actor = (over: Partial<Actor> = {}): Actor => ({ id: 'u-me', role: 'member', teams: [{ id: T1, role: 'member' }], ...over });
const admin = actor({ role: 'admin', teams: [] });
const lead = actor({ teams: [{ id: T1, role: 'lead' }, { id: T2, role: 'member' }] });
const member = actor();
const DAY = 86_400_000;

describe('permissions (ADR-0029 T8)', () => {
  it('tokens: people create their own; admins create only service-user tokens', () => {
    expect(canCreateTokenFor(member, { id: 'u-me', kind: 'person' })).toBe(true);
    expect(canCreateTokenFor(member, { id: 'svc', kind: 'service' })).toBe(false);
    expect(canCreateTokenFor(lead, { id: 'svc', kind: 'service' })).toBe(false);
    expect(canCreateTokenFor(admin, { id: 'svc', kind: 'service' })).toBe(true);
    expect(canCreateTokenFor(admin, { id: 'u-other', kind: 'person' })).toBe(false);
  });
  it('revoke: own tokens; admins every token (D6); leads no others', () => {
    expect(canRevokeToken(member, { userId: 'u-me' })).toBe(true);
    expect(canRevokeToken(member, { userId: 'u-other' })).toBe(false);
    expect(canRevokeToken(lead, { userId: 'u-other' })).toBe(false);
    expect(canRevokeToken(admin, { userId: 'u-other' })).toBe(true);
  });
  it('admin area: admins and leads; budgets managed by admins only', () => {
    expect(canEnterAdmin(admin)).toBe(true);
    expect(canEnterAdmin(lead)).toBe(true);
    expect(canEnterAdmin(member)).toBe(false);
    expect(isLead(lead)).toBe(true);
    expect(canManageBudgets(lead)).toBe(false);
    expect(canManageBudgets(admin)).toBe(true);
  });
  it('tabs: admins see the whole console, leads only Budgets', () => {
    expect(adminTabsFor(admin).map((t) => t.href)).toEqual([
      '/admin',
      '/admin/settings',
      '/admin/teams',
      '/admin/members',
      '/admin/invitations',
      '/admin/service-users',
      '/admin/tokens',
      '/admin/projects',
      '/admin/budgets',
      '/admin/model-prices',
      '/admin/audit',
    ]);
    expect(adminTabsFor(lead).map((t) => t.href)).toEqual(['/admin/budgets']);
    expect(adminTabsFor(member)).toEqual([]);
  });
  it('sidebar: My tokens for everyone, Admin for admins, Budgets for leads, no super admin or company entries', () => {
    const hrefs = (u: Pick<Actor, 'role' | 'teams'>) => navFor(u).map((i) => i.href);
    expect(hrefs(member)).toContain('/tokens');
    expect(hrefs(member)).not.toContain('/admin');
    expect(hrefs(admin).at(-1)).toBe('/admin');
    expect(hrefs(lead).at(-1)).toBe('/admin/budgets');
    for (const u of [member, lead, admin]) expect(hrefs(u).some((h) => h.startsWith('/super') || h === '/invitations')).toBe(false);
  });
});

describe('tokens (ADR-0029 T5, T6)', () => {
  it('lifetimes: 30 / 90 / 365 days or none, default 90', () => {
    const now = new Date('2026-10-24T10:00:00Z');
    expect(DEFAULT_TOKEN_LIFETIME).toBe('90');
    expect(expiresAtFor('30', now)?.toISOString()).toBe('2026-11-23T10:00:00.000Z');
    expect(expiresAtFor('90', now)!.getTime() - now.getTime()).toBe(90 * DAY);
    expect(expiresAtFor('365', now)!.getTime() - now.getTime()).toBe(365 * DAY);
    expect(expiresAtFor('none', now)).toBeNull();
    expect(parse(ownTokenInput, { name: ' Laptop ' })).toEqual({ name: 'Laptop', lifetime: '90' });
    expect(parse(ownTokenInput, { name: 'x', lifetime: 'none' }).lifetime).toBe('none');
    expect(() => parse(ownTokenInput, { name: 'x', lifetime: '7' })).toThrow(AdminError);
    expect(() => parse(serviceTokenInput, { name: 'x', userId: 'nope' })).toThrow(AdminError);
  });
  it('state: revoked, expired, expiring within 14 days, active', () => {
    const now = 1_000 * DAY;
    expect(EXPIRY_WARNING_DAYS).toBe(14);
    expect(tokenState({ revokedMs: now - 1, expiresMs: now + 100 * DAY }, now)).toBe('revoked');
    expect(tokenState({ revokedMs: null, expiresMs: now }, now)).toBe('expired');
    expect(tokenState({ revokedMs: null, expiresMs: now + 14 * DAY }, now)).toBe('expiring');
    expect(tokenState({ revokedMs: null, expiresMs: now + 15 * DAY }, now)).toBe('active');
    expect(tokenState({ revokedMs: null, expiresMs: null }, now)).toBe('active');
  });
  it('the collector command logs in to this server with the pasted token', () => {
    expect(collectorCommand('aiobs_u_x', 'https://obs.example/')).toBe('npx @soukupl/ai-obs login --server https://obs.example --token aiobs_u_x');
  });
});

describe('inputs', () => {
  it('settings: retention 30–730 days (no plans), runaway thresholds in range', () => {
    const base = { individualVisibility: 'full', projectNaming: 'plain' };
    expect(parse(settingsInput, { ...base, retentionDays: '30' }).retentionDays).toBe(30);
    expect(parse(settingsInput, { ...base, retentionDays: '730' }).retentionDays).toBe(730);
    expect(() => parse(settingsInput, { ...base, retentionDays: '29' })).toThrow(/at least 30/);
    expect(() => parse(settingsInput, { ...base, retentionDays: '731' })).toThrow(/at most 730/);
    expect(() => parse(settingsInput, { ...base, retentionDays: '100.5' })).toThrow(AdminError);
    expect(parse(settingsInput, { ...base, retentionDays: '395', runawayCostUsd: '', runawayHours: '4' })).toMatchObject({ runawayCostUsd: undefined, runawayHours: 4 });
    expect(() => parse(settingsInput, { ...base, retentionDays: '395', runawayHours: '100' })).toThrow(AdminError);
  });
  it('team slugs: lower-case letters, digits and -; 1–63', () => {
    expect(parse(teamSlug, ' Platform-2 ')).toBe('platform-2');
    for (const bad of ['', 'a b', 'ä', 'x'.repeat(64), 'a_b']) expect(() => parse(teamSlug, bad), bad).toThrow(AdminError);
  });
  it('invitation: lower-cases e-mails, empty select → null, role and team role default to member', () => {
    expect(parse(invitationInput, { email: ' New@X.Test ', teamId: '' })).toEqual({ email: 'new@x.test', teamId: null, teamRole: 'member', role: 'member' });
    expect(parse(invitationInput, { email: 'a@x.test', teamId: T1, teamRole: 'lead', role: 'admin' })).toMatchObject({ teamRole: 'lead', role: 'admin' });
    expect(() => parse(invitationInput, { email: 'nope' })).toThrow(AdminError);
  });
  it('model prices: a date and four non-negative prices', () => {
    const p = { model: 'claude-x', effectiveFrom: '2026-10-01', input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' };
    expect(parse(modelPriceInput, p)).toMatchObject({ input: 3, cacheRead: 0.3 });
    expect(() => parse(modelPriceInput, { ...p, input: '-1' })).toThrow(AdminError);
    expect(() => parse(modelPriceInput, { ...p, effectiveFrom: '1.10.2026' })).toThrow(AdminError);
  });
  it('formObject drops Next action fields', () => {
    const fd = new FormData();
    fd.set('name', 'x');
    fd.set('$ACTION_ID_abc', '');
    expect(formObject(fd)).toEqual({ name: 'x' });
  });
});

describe('helpers', () => {
  it('invitation e-mail names the deployment and the team, links to the login page and escapes HTML', () => {
    const m = invitationEmail(
      { id: 'i', email: 'new@x.test', teamName: 'A<b>', deploymentName: 'Acme & Co', expiresAt: new Date('2026-10-13T00:00:00Z') },
      { appUrl: 'https://obs.example', inviter: 'Alice' },
    );
    expect(m.to).toBe('new@x.test');
    expect(m.subject).toBe('You are invited to Acme & Co');
    expect(m.text).toContain('Alice invited you to Acme & Co (team A<b>)');
    expect(m.text).toContain('https://obs.example/login');
    expect(m.text).toContain('7 days');
    expect(m.text).not.toContain('/invitations');
    expect(m.html).toContain('Acme &amp; Co');
    expect(m.html).not.toContain('A<b>');
  });
  it('error messages never leak SQL', () => {
    expect(userMessage(new AdminError('Nope.'))).toBe('Nope.');
    expect(userMessage({ cause: { code: '23505' } })).toBe('That already exists.');
    expect(userMessage({ code: '42501' })).toMatch(/not allowed/);
    expect(userMessage(new Error('relation "x" does not exist'))).toMatch(/Something went wrong/);
    expect(pgCode({ cause: { code: '23503' } })).toBe('23503');
  });
  it('audit meta summary and CSV', () => {
    expect(metaSummary({ source: 'manual', limit: 5, after: { a: 1 } })).toBe('source=manual, limit=5, after={"a":1}');
    expect(metaSummary({ s: 'x'.repeat(300) }).length).toBe(120);
    const csv = auditCsv([{ id: '1', atMs: Date.UTC(2026, 9, 6), actor: 'Alice', action: 'team.create', target: 'team:1', meta: { name: 'A' } }]);
    expect(csv.headers).toEqual(['at', 'actor', 'action', 'target', 'meta']);
    expect(csv.rows[0]).toEqual(['2026-10-06T00:00:00.000Z', 'Alice', 'team.create', 'team:1', '{"name":"A"}']);
  });
});
