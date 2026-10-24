import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { adminTabsFor, requireAdminOrLead } from '@/lib/admin/guard';
import { AdminNav } from './_components/AdminNav';

export const metadata = { title: { default: 'Admin', template: '%s · Admin' } };

/** Admin console of the deployment (BRIEF §8, ADR-0028). Admins see every tab; team leads see Budgets only. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireAdminOrLead();
  return (
    <AppShell user={user}>
      <AdminNav tabs={adminTabsFor(user)} />
      {children}
    </AppShell>
  );
}
