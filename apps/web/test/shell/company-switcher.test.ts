import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { companySwitcherModel } from '../../src/components/company-switcher-model';
import type { MembershipSummary } from '../../src/lib/auth/session';

/**
 * The header company switcher (ADR-0022). The model holds every rule (pure); the components import
 * 'use server' actions, so they are checked at source level (as in test/views/layout-spacing.test.ts).
 */
const acme: MembershipSummary = { companyId: 'c-acme', name: 'Acme', slug: 'acme', role: 'admin', plan: 'team' };
const globex: MembershipSummary = { companyId: 'c-globex', name: 'Globex', slug: 'globex', role: 'member', plan: 'free' };
const company = (m: MembershipSummary) => ({ id: m.companyId, name: m.name });

describe('companySwitcherModel', () => {
  it('a super admin sees "Platform" and no switcher', () => {
    expect(companySwitcherModel({ isSuperAdmin: true, company: null, memberships: [] })).toEqual({ mode: 'platform' });
  });
  it('one company: its plain name', () => {
    expect(companySwitcherModel({ isSuperAdmin: false, company: company(acme), memberships: [acme] })).toEqual({ mode: 'name', name: 'Acme' });
  });
  it('two or more: a switcher in the given order, exactly the active company marked, slug and role carried', () => {
    const model = companySwitcherModel({ isSuperAdmin: false, company: company(globex), memberships: [globex, acme] });
    expect(model).toEqual({
      mode: 'switcher',
      active: { companyId: 'c-globex', name: 'Globex' },
      items: [
        { companyId: 'c-globex', name: 'Globex', slug: 'globex', role: 'member', active: true },
        { companyId: 'c-acme', name: 'Acme', slug: 'acme', role: 'admin', active: false },
      ],
    });
    if (model.mode !== 'switcher') throw new Error('expected a switcher');
    expect(model.items.filter((i) => i.active)).toHaveLength(1);
  });
});

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/components/${rel}`, import.meta.url)), 'utf8');

describe('switcher placements (source level)', () => {
  const shell = src('AppShell.tsx');
  const switcher = src('CompanySwitcher.tsx');

  it('AppShell builds one model and renders it in the header and inside the user menu', () => {
    expect(shell).toMatch(/const switcher = companySwitcherModel\(user\)/);
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    expect(header).toMatch(/<CompanySwitcher model=\{switcher\} \/>/);
    // The user menu is the last <details> in the header; on phones it is the only placement.
    const menu = header.slice(header.lastIndexOf('<details'));
    expect(menu).toMatch(/<CompanySwitchList items=\{switcher\.items\} \/>/);
    expect(menu).toMatch(/Invitations \(\{pendingInvitations\}\)/);
    // No company-name branching of its own left in the shell.
    expect(shell).not.toMatch(/user\.company\?\.name \?\? 'Platform'/);
  });

  it('the header placement is md and up only', () => {
    const header = switcher.slice(switcher.indexOf('export function CompanySwitcher('));
    expect(header).toMatch(/className="relative hidden md:block"/);
    expect(header).toMatch(/hidden truncate text-sm text-zinc-500 md:inline/);
  });

  it('each row posts switchCompany with a hidden companyId; the active row is aria-current and not a button', () => {
    const list = switcher.slice(switcher.indexOf('export function CompanySwitchList('), switcher.indexOf('export function CompanySwitcher('));
    expect(switcher).toMatch(/import \{ switchCompany \} from '@\/lib\/auth\/actions'/);
    expect(list).toMatch(/<form action=\{switchCompany\}>/);
    expect(list).toMatch(/<input type="hidden" name="companyId" value=\{item\.companyId\} \/>/);
    const activeBranch = list.slice(list.indexOf('item.active ?'), list.indexOf(') : ('));
    expect(activeBranch).toMatch(/aria-current="true"/);
    expect(activeBranch).not.toMatch(/<button/);
  });
});
