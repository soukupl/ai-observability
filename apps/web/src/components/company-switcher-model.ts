import type { CompanyRole, MembershipSummary } from '../lib/auth/session';

/** What the header and the user menu show for the company: rendered only from this model (unit-tested). */
export type SwitcherModel =
  /** Super admin: "Platform", no switcher. */
  | { mode: 'platform' }
  /** A single membership: its company name, no switcher. */
  | { mode: 'name'; name: string }
  | {
      mode: 'switcher';
      active: { companyId: string; name: string };
      /** Every membership in the given order (last used first); exactly one is `active`. */
      items: { companyId: string; name: string; slug: string; role: CompanyRole; active: boolean }[];
    };

interface SwitcherUser {
  isSuperAdmin: boolean;
  company: { id: string; name: string } | null;
  memberships: MembershipSummary[];
}

/** The company switcher's rules: platform for company-less users, a plain name for one company, a switcher for two or more. */
export function companySwitcherModel(user: SwitcherUser): SwitcherModel {
  const company = user.company;
  if (!company) return { mode: 'platform' };
  if (user.memberships.length < 2) return { mode: 'name', name: company.name };
  return {
    mode: 'switcher',
    active: { companyId: company.id, name: company.name },
    items: user.memberships.map((m) => ({
      companyId: m.companyId,
      name: m.name,
      slug: m.slug,
      role: m.role,
      active: m.companyId === company.id,
    })),
  };
}
