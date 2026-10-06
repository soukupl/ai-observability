import Link from 'next/link';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { renameCompanyAction } from '@/lib/admin/actions/company';
import { companyCounts, loadCompany } from '@/lib/admin/company';
import { requireAdminPage } from '@/lib/admin/guard';
import { formatLimit, planLimits, planOverages } from '@/lib/admin/plans';
import { withUserDb } from '@/lib/auth/rls';
import { ActionForm } from './_components/ActionForm';
import { inputCls, labelCls, noteCls } from './_components/ui';

export const metadata = { title: 'Admin' };

function Usage({ label, used, limit, hint }: { label: string; used: number; limit: number | null; hint?: string }) {
  const full = limit !== null && used >= limit;
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${full ? 'text-amber-700 dark:text-amber-400' : ''}`}>
        {used} / {formatLimit(limit)}
      </div>
      {hint && <div className={noteCls}>{hint}</div>}
    </div>
  );
}

export default async function AdminOverviewPage() {
  const user = await requireAdminPage();
  const { company, counts } = await withUserDb(user, async (tx) => ({
    company: await loadCompany(tx, user.companyId),
    counts: await companyCounts(tx, user.companyId),
  }));
  const limits = planLimits(company.plan);
  const s = company.settings;
  const overages = planOverages(company.plan, { ...counts, retentionDays: s.retentionDays });
  const links = [
    ['/admin/teams', 'Teams and memberships'],
    ['/admin/members', 'Members and invitations'],
    ['/admin/tokens', 'Collector tokens'],
    ['/admin/projects', 'Project names and team mapping'],
    ['/admin/settings', 'Privacy, project naming, retention'],
    ['/admin/budgets', 'Monthly budgets'],
    ['/admin/audit', 'Audit log'],
  ] as const;

  return (
    <div className="space-y-4">
      <PageHeader title="Admin" description={`${company.name} · ${company.plan} plan${company.status === 'suspended' ? ' · suspended' : ''}`} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Plan and limits" description="The plan is set by the platform admin. Values are placeholders (no payments).">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Usage label="Users" used={counts.users + counts.pendingInvitations} limit={limits.users} hint={`${counts.users} members + ${counts.pendingInvitations} pending invitations`} />
            <Usage label="Teams" used={counts.teams} limit={limits.teams} />
          </div>
          {overages.length > 0 && (
            <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Over the {company.plan} plan: {overages.join('; ')}. Existing usage is kept; new users and teams are refused until the company is back under the limit, and retention is clamped to the plan maximum.
            </p>
          )}
          <ul className="mt-3 space-y-1 text-sm">
            <li>Max raw retention: {limits.maxRetentionDays} days</li>
            <li>Budgets: {limits.budgets ? 'included' : 'not included'}</li>
            <li>
              {counts.activeTokens} active tokens · {counts.projects} projects
            </li>
          </ul>
        </Card>
        <Card title="Settings" actions={<Link className="text-sm text-blue-700 hover:underline dark:text-blue-400" href="/admin/settings">Change</Link>}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-500 dark:text-zinc-400">Individual visibility</dt>
            <dd>{s.individualVisibility === 'full' ? 'Full detail' : 'Aggregates only'}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Project naming</dt>
            <dd>{s.projectNaming === 'hashed' ? 'Hashed' : 'Plain (git remote)'}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Raw retention</dt>
            <dd>
              {s.retentionDays} days
              {s.retentionDays > limits.maxRetentionDays && <span className="ml-1 text-amber-700 dark:text-amber-400">(above the plan maximum of {limits.maxRetentionDays})</span>}
            </dd>
          </dl>
        </Card>
        <Card title="Company name">
          <ActionForm action={renameCompanyAction} submitLabel="Rename">
            <label className={`${labelCls} grow`}>
              Name
              <input name="name" required maxLength={120} defaultValue={company.name} className={inputCls} />
            </label>
          </ActionForm>
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
