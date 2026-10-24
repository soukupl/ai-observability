import Link from 'next/link';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { deploymentCounts, loadDeployment } from '@/lib/admin/deployment';
import { requireAdminPage } from '@/lib/admin/guard';
import { withUserDb } from '@/lib/auth/rls';

export const metadata = { title: 'Admin' };

function Stat({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href} className="rounded-lg border border-zinc-200 p-3 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </Link>
  );
}

export default async function AdminOverviewPage() {
  const user = await requireAdminPage();
  const { dep, counts } = await withUserDb(user, async (tx) => ({ dep: await loadDeployment(tx), counts: await deploymentCounts(tx) }));
  const s = dep.settings;
  const links = [
    ['/admin/settings', 'Name, privacy, project naming, retention, runaway alerts'],
    ['/admin/teams', 'Teams, slugs and memberships'],
    ['/admin/members', 'Members and roles'],
    ['/admin/invitations', 'Invitations'],
    ['/admin/service-users', 'Service users for CI, bots and shared machines'],
    ['/admin/tokens', 'Every collector token'],
    ['/admin/projects', 'Project names and team mapping'],
    ['/admin/budgets', 'Monthly budgets'],
    ['/admin/model-prices', 'Model prices'],
    ['/admin/audit', 'Audit log'],
  ] as const;

  return (
    <div className="space-y-4">
      <PageHeader title="Admin" description={`${dep.name} (${dep.slug})`} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Members" value={counts.members} href="/admin/members" />
        <Stat label="Pending invitations" value={counts.pendingInvitations} href="/admin/invitations" />
        <Stat label="Teams" value={counts.teams} href="/admin/teams" />
        <Stat label="Service users" value={counts.serviceUsers} href="/admin/service-users" />
        <Stat label="Live tokens" value={counts.activeTokens} href="/admin/tokens" />
        <Stat label="Projects" value={counts.projects} href="/admin/projects" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Settings" actions={<Link className="text-sm text-blue-700 hover:underline dark:text-blue-400" href="/admin/settings">Change</Link>}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-500 dark:text-zinc-400">Individual visibility</dt>
            <dd>{s.individualVisibility === 'full' ? 'Full detail' : 'Aggregates only'}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Project naming</dt>
            <dd>{s.projectNaming === 'hashed' ? 'Hashed' : 'Plain (git remote)'}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Raw retention</dt>
            <dd>{s.retentionDays} days</dd>
          </dl>
        </Card>
        <Card title="Manage">
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {links.map(([href, label]) => (
              <li key={href}>
                <Link href={href} className="text-blue-700 hover:underline dark:text-blue-400">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
