import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { VisibilityBanner } from '@/components/VisibilityBanner';
import { defaultAuthDeps, listPendingInvitations } from '@/lib/auth/login';
import { requireUser } from '@/lib/auth/session';

/**
 * Every dashboard view: signed-in company users only, inside the shell, with the visibility mode on top.
 * Invitations from other companies to the user's e-mail show as "Invitations (n)" in the user menu.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const pendingInvitations = (await listPendingInvitations(defaultAuthDeps(), user.email)).length;
  return (
    <AppShell user={user} pendingInvitations={pendingInvitations}>
      <VisibilityBanner mode={user.company.settings.individualVisibility} />
      {children}
    </AppShell>
  );
}
