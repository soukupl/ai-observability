import type { ReactNode } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { requireSuperAdminOr404 } from '@/lib/platform/guard';

/** The platform console: super admins only (others get 404). No telemetry is shown here (ADR-0006). */
export default async function SuperLayout({ children }: { children: ReactNode }) {
  const user = await requireSuperAdminOr404();
  return (
    <AppShell user={user}>
      <nav aria-label="Console" className="mb-4 flex gap-4 border-b border-zinc-200 text-sm dark:border-zinc-800">
        <Link href="/super" className="-mb-px border-b-2 border-transparent px-1 py-2 hover:border-zinc-400">
          Companies
        </Link>
        <Link href="/super/plans" className="-mb-px border-b-2 border-transparent px-1 py-2 hover:border-zinc-400">
          Plans
        </Link>
      </nav>
      {children}
    </AppShell>
  );
}
