import Link from 'next/link';
import { dbFor } from '@ai-obs/db';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { listCompanies, listPlatformAudit } from '@/lib/platform/companies';
import { requireSuperAdminOr404 } from '@/lib/platform/guard';
import { AuditTable } from './AuditTable';
import { CreateCompanyForm } from './forms';

export const metadata = { title: 'Super admin' };
export const dynamic = 'force-dynamic';

const COLUMNS: Column[] = [
  { key: 'name', header: 'Company', hrefKey: 'href' },
  { key: 'slug', header: 'Slug' },
  { key: 'plan', header: 'Plan' },
  { key: 'status', header: 'Status' },
  { key: 'createdAt', header: 'Created', kind: 'datetime' },
  { key: 'users', header: 'Users', kind: 'int' },
  { key: 'teams', header: 'Teams', kind: 'int' },
  { key: 'admins', header: 'Admin contacts' },
];

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SuperPage({ searchParams }: { searchParams: SearchParams }) {
  await requireSuperAdminOr404();
  const sp = await searchParams;
  const q = (typeof sp.q === 'string' ? sp.q : '').slice(0, 80);
  const db = dbFor('platform');
  const [rows, audit] = await Promise.all([listCompanies(db, { q }), listPlatformAudit(db, { limit: 15 })]);
  const suspended = rows.filter((r) => r.status === 'suspended').length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Companies"
        description="Platform console: companies, plans and status. Telemetry is not visible here; the database does not allow it."
      />
      <Card title="Create company" description="Creates the company and e-mails an invitation to its first admin.">
        <CreateCompanyForm />
      </Card>
      <Card
        title={`${rows.length} ${rows.length === 1 ? 'company' : 'companies'}${suspended ? `, ${suspended} suspended` : ''}`}
        actions={
          <form action="/super" className="flex items-center gap-2">
            <input
              name="q"
              defaultValue={q}
              placeholder="Search name or slug"
              aria-label="Search companies"
              className="h-8 w-44 rounded-md border border-zinc-300 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button type="submit" className="h-8 rounded-md border border-zinc-300 px-3 text-xs dark:border-zinc-700">
              Search
            </button>
          </form>
        }
      >
        <DataTable
          caption="Companies"
          columns={COLUMNS}
          rowKey="id"
          exportHref="/super/export"
          defaultSort={{ key: 'createdAt', dir: 'desc' }}
          emptyMessage={q ? 'No company matches the search.' : 'No companies yet.'}
          rows={rows.map((r) => ({
            id: r.id,
            href: `/super/companies/${r.id}`,
            name: r.name,
            slug: r.slug,
            plan: r.plan,
            status: r.status,
            createdAt: r.createdAt,
            users: r.users,
            teams: r.teams,
            admins: r.adminEmails.join(', '),
          }))}
        />
      </Card>
      <Card title="Recent platform actions" description="All companies; every change is audited.">
        <AuditTable rows={audit} showCompany />
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          <Link href="/super/plans" className="underline">Plan definitions</Link>
        </p>
      </Card>
    </div>
  );
}
