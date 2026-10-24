import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';
import { VisibilityBanner } from '@/components/VisibilityBanner';
import { requireUser } from '@/lib/auth/session';

/** Every dashboard view: signed-in members only, inside the shell, with the deployment's visibility mode on top. */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <AppShell user={user}>
      <VisibilityBanner mode={user.deployment.settings.individualVisibility} />
      {children}
    </AppShell>
  );
}
