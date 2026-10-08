import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { adminTabsFor, requireAdminOrLead } from '@/lib/admin/guard';
import { AdminNav } from './_components/AdminNav';

export const metadata = { title: { default: 'Admin', template: '%s · Admin' } };

/**
 * Company admin console (BRIEF §8) for the ACTIVE company. Admins see every tab; team leads see Tokens and Budgets.
 * Forms are bound to the company they were rendered for (D10): each PAGE renders its own CompanyScopeProvider
 * from its own requireUser(), because this shared layout is not re-rendered on client navigation between tabs
 * and would otherwise keep a company the session has since switched away from.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireAdminOrLead();
  return (
    <AppShell user={user}>
      <AdminNav tabs={adminTabsFor(user)} />
      {children}
    </AppShell>
  );
}
