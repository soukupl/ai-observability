import Link from 'next/link';
import { notFound } from 'next/navigation';
import { dbFor } from '@ai-obs/db';
import { Badge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { KpiTile } from '@/components/KpiTile';
import { PageHeader } from '@/components/PageHeader';
import { formatDateTime } from '@/components/format';
import { getCompanyDetail, listPlatformAudit } from '@/lib/platform/companies';
import { requireSuperAdminOr404 } from '@/lib/platform/guard';
import { limitLabel, overLimit, planDef } from '@/lib/platform/plans';
import { isUuid } from '@/lib/platform/validate';
import { AuditTable } from '../../AuditTable';
import { InviteAdminForm, PlanForm, StatusForm } from '../../forms';

export const metadata = { title: 'Company' };
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CompanyPage({ params, searchParams }: Props) {
  await requireSuperAdminOr404();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const sp = await searchParams;
  const db = dbFor('platform');
  const company = await getCompanyDetail(db, id);
  if (!company) notFound();
  const audit = await listPlatformAudit(db, { companyId: id, limit: 50 });
  const plan = planDef(company.plan);
  const now = Date.now();

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <Link href="/super" className="text-blue-700 hover:underline dark:text-blue-400">
          ← Companies
        </Link>
      </p>
      <PageHeader
        title={company.name}
        description={`${company.slug} · created ${formatDateTime(company.createdAt)}`}
        actions={<Badge tone={company.status === 'active' ? 'good' : 'bad'}>{company.status}</Badge>}
      />
      {sp.created && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Company created and the first admin invited.
          {sp.mail === 'failed' ? ' The e-mail could not be sent; use "Invite admin" below to send it again.' : ''}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile label="Plan" value={plan.name} sub={`raw retention up to ${plan.retentionLabel}`} />
        <KpiTile
          label="Members"
          value={String(company.users)}
          sub={limitLabel(company.users, plan.maxUsers)}
          title={overLimit(company.users, plan.maxUsers) ? 'Over the plan limit (limits are informational for now)' : undefined}
        />
        <KpiTile label="Teams" value={String(company.teams)} sub={limitLabel(company.teams, plan.maxTeams)} />
      </div>
      {(overLimit(company.users, plan.maxUsers) || overLimit(company.teams, plan.maxTeams)) && (
        <p className="text-sm text-amber-700 dark:text-amber-400">This company is over the limits of its plan.</p>
      )}

      <Card title="Plan" description="Changes apply immediately and are audited.">
        <PlanForm companyId={company.id} plan={company.plan} />
      </Card>
      <Card
        title="Status"
        description={
          company.status === 'active'
            ? 'Suspending stops ingest (403) and dashboard access to this company. Data is kept.'
            : 'This company is suspended: ingest returns 403 and its members cannot open it (their other companies are unaffected).'
        }
      >
        <StatusForm companyId={company.id} status={company.status} />
      </Card>

      <Card title="Admins" description="Admin contacts only; no other users are visible to the platform.">
        {company.admins.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No admin has joined yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {company.admins.map((a) => (
              <li key={a.email} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="min-w-0 break-all">
                  {a.email}
                  {a.name ? <span className="text-zinc-500 dark:text-zinc-400"> · {a.name}</span> : null}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {a.lastActiveAt ? `last active ${formatDateTime(a.lastActiveAt)}` : 'not active here yet'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Admin invitations</h3>
        {company.invitations.length === 0 ? (
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">No invitations.</p>
        ) : (
          <ul className="mb-3 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
            {company.invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0 break-all">{i.email}</span>
                <span className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  sent {formatDateTime(i.createdAt)}
                  {i.acceptedAt ? <Badge tone="good">accepted</Badge> : i.expiresAt < now ? <Badge tone="warn">expired</Badge> : <Badge tone="info">pending</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <InviteAdminForm companyId={company.id} />
      </Card>

      <Card title="Platform actions" description="Audit of changes made by super admins to this company.">
        <AuditTable rows={audit} />
      </Card>
    </div>
  );
}
