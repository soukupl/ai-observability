import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { adminTabsFor, requireAdminOrLead } from '@/lib/admin/guard';
import { AdminNav } from './_components/AdminNav';

export const metadata = { title: { default: 'Admin', template: '%s · Admin' } };

/** Company admin console (BRIEF §8). Admins see every tab; team leads see Tokens and Budgets. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireAdminOrLead();
  return (
    <AppShell user={user}>
      <AdminNav tabs={adminTabsFor(user)} />
      {children}
    </AppShell>
  );
}
