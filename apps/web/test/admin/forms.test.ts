import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source guards for the single-deployment console (ADR-0028): the company-era machinery (D10 form binding, the
 * company switcher, the super console, plans, the platform DB role) must not come back, and every admin action goes
 * through the session gate + RLS transaction (runAdmin / messageAction).
 */
const src = join(__dirname, '../../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => relative(src, p);
const sources = walk(src).filter((p) => /\.tsx?$/.test(p));

describe('single deployment: no company-era code', () => {
  it('the removed surfaces are gone', () => {
    for (const p of [
      'app/super',
      'lib/platform',
      'app/(auth)/signup',
      'app/api/auth/signup',
      'app/(dashboard)/invitations',
      'components/CompanySwitcher.tsx',
      'components/company-switcher-model.ts',
      'lib/admin/plans.ts',
      'lib/admin/company.ts',
      'app/admin/_components/CompanyScope.tsx',
    ])
      expect(existsSync(join(src, p)), p).toBe(false);
  });

  it('nothing uses the platform DB role, SUPER_ADMIN_EMAILS, plans or the D10 company field', () => {
    const banned: [RegExp, string][] = [
      [/dbFor\(\s*['"]platform['"]\s*\)/, "dbFor('platform')"],
      [/SUPER_ADMIN_EMAILS/, 'SUPER_ADMIN_EMAILS'],
      [/requireSuperAdmin|isSuperAdmin/, 'super admin'],
      [/_companyId|CompanyField|CompanyScopeProvider/, 'D10 company binding'],
      [/lib\/admin\/plans|PLAN_LIMITS/, 'plans'],
      [/\bcompanyMemberships\b|company_memberships/, 'company memberships'],
    ];
    for (const p of sources) {
      const text = readFileSync(p, 'utf8');
      for (const [re, what] of banned) expect(re.test(text), `${rel(p)} uses ${what}`).toBe(false);
    }
  });
});

describe('admin actions', () => {
  it('every exported action runs through runAdmin / messageAction with a gate', () => {
    const dir = join(src, 'lib/admin/actions');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text.startsWith("'use server';"), f).toBe(true);
      const actions = text.split(/^export async function /m).slice(1);
      expect(actions.length).toBeGreaterThan(0);
      for (const body of actions) {
        const name = body.slice(0, body.indexOf('('));
        expect(body, `${f}: ${name}`).toMatch(/(runAdmin|messageAction)\('(admin|user)', /);
      }
    }
  });

  it('service users, tokens of others, model prices and settings are admin-gated', () => {
    const gateOf = (file: string, fn: string) => {
      const text = readFileSync(join(src, 'lib/admin/actions', file), 'utf8');
      const body = text.split(`export async function ${fn}(`)[1] ?? '';
      return /(runAdmin|messageAction)\('(admin|user)'/.exec(body)?.[2];
    };
    expect(gateOf('service-users.ts', 'createServiceUserAction')).toBe('admin');
    expect(gateOf('service-users.ts', 'disableServiceUserAction')).toBe('admin');
    expect(gateOf('tokens.ts', 'createServiceTokenAction')).toBe('admin');
    expect(gateOf('tokens.ts', 'createOwnTokenAction')).toBe('user');
    expect(gateOf('settings.ts', 'saveModelPriceAction')).toBe('admin');
    expect(gateOf('settings.ts', 'updateSettingsAction')).toBe('admin');
  });

  it('the device page acts only through the device_* definer functions under the user context', () => {
    const actions = readFileSync(join(src, 'lib/auth/device-actions.ts'), 'utf8');
    expect(actions).toMatch(/requireUser\(\)/);
    expect(actions).toMatch(/withUserDb\(user,/);
    const lib = readFileSync(join(src, 'lib/auth/device.ts'), 'utf8');
    expect(lib).toMatch(/device_lookup\(/);
    expect(lib).toMatch(/device_approve\(/);
    expect(lib).toMatch(/device_deny\(/);
    expect(lib).not.toMatch(/from\s+device_codes|update\s+device_codes/i);
  });
});
