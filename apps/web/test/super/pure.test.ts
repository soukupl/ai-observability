import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS } from '@ai-obs/db';
import { PLANS, limitLabel, overLimit, planDef, retentionLabel } from '../../src/lib/platform/plans';
import { parseEmail, parseName, parsePlan, parseSlug, slugFromName } from '../../src/lib/platform/validate';
import { adminInvitationEmail } from '../../src/lib/platform/mail';

describe('plans', () => {
  it('matches BRIEF §10', () => {
    expect(PLANS.map((p) => [p.id, p.maxUsers, p.maxTeams, p.budgets, p.sso])).toEqual([
      ['free', 3, 1, false, false],
      ['team', 50, 10, true, false],
      ['business', null, null, true, true],
    ]);
    expect(planDef('team').retentionLabel).toBe('13 months');
  });
  it('is derived from the enforced PLAN_LIMITS (cannot drift)', () => {
    expect(PLANS.map((p) => p.id).sort()).toEqual(Object.keys(PLAN_LIMITS).sort());
    for (const p of PLANS) {
      const l = PLAN_LIMITS[p.id];
      expect([p.maxUsers, p.maxTeams, p.maxRetentionDays, p.budgets, p.sso]).toEqual([l.users, l.teams, l.maxRetentionDays, l.budgets, l.sso]);
    }
    expect([30, 395, 730].map(retentionLabel)).toEqual(['30 days', '13 months', '24 months']);
  });
  it('limit labels', () => {
    expect(limitLabel(2, 3)).toBe('2 of 3');
    expect(limitLabel(9, null)).toBe('9 (unlimited)');
    expect(overLimit(4, 3)).toBe(true);
    expect(overLimit(99, null)).toBe(false);
  });
});

describe('validation', () => {
  it('names', () => {
    expect(parseName('  Acme   Corp ')).toEqual({ ok: true, value: 'Acme Corp' });
    expect(parseName('A').ok).toBe(false);
    expect(parseName(undefined).ok).toBe(false);
  });
  it('slugs', () => {
    expect(parseSlug('Acme-1')).toEqual({ ok: true, value: 'acme-1' });
    for (const bad of ['', '-a', 'a-', 'a b', 'a_b', 'x'.repeat(41)]) expect(parseSlug(bad).ok).toBe(false);
    expect(slugFromName('Acme & Sons, Inc.')).toBe('acme-sons-inc');
  });
  it('e-mails are lower-cased and checked', () => {
    expect(parseEmail(' Boss@Acme.Example ')).toEqual({ ok: true, value: 'boss@acme.example' });
    for (const bad of ['', 'x', 'a@b', 'a b@c.d', 'a@b.c,d@e.f']) expect(parseEmail(bad).ok).toBe(false);
  });
  it('plans', () => {
    expect(parsePlan('team').ok).toBe(true);
    expect(parsePlan('enterprise').ok).toBe(false);
  });
});

describe('invitation e-mail', () => {
  it('escapes the company name in html and points at the login page', () => {
    const m = adminInvitationEmail('a@b.example', '<b>Evil</b>', 'http://localhost:3000/login', 14);
    expect(m.html).not.toContain('<b>Evil</b>');
    expect(m.text).toContain('http://localhost:3000/login');
    expect(m.to).toBe('a@b.example');
  });
});
