import Link from 'next/link';
import { Card } from '@/components/Card';
import { DataTable } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { listAuditLog, metaSummary } from '@/lib/admin/audit';
import { requireAdminPage } from '@/lib/admin/guard';
import { withUserDb } from '@/lib/auth/rls';
import { CompanyScopeProvider } from '../_components/CompanyScope';

export const metadata = { title: 'Audit log' };

const PAGE_SIZE = 50;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireAdminPage();
  const raw = (await searchParams).page;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(Array.isArray(raw) ? (raw[0] ?? '1') : (raw ?? '1'), 10) || 1));
  const { rows, total } = await withUserDb(user, (tx) => listAuditLog(tx, user.companyId, { page, pageSize: PAGE_SIZE }));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) => (p === 1 ? '/admin/audit' : `/admin/audit?page=${p}`);

  return (
    <CompanyScopeProvider companyId={user.companyId}>
      <div className="space-y-4">
        <PageHeader title="Audit log" description="Logins, token changes, settings, admin changes and exports. Newest first, times in UTC." />
        <Card>
          <DataTable
            caption="Audit log"
            exportHref="/admin/audit/export.csv"
            rowKey="id"
            emptyMessage="No entries yet."
            columns={[
              { key: 'at', header: 'At', kind: 'datetime', sortable: false },
              { key: 'actor', header: 'Actor', sortable: false },
              { key: 'action', header: 'Action', sortable: false },
              { key: 'target', header: 'Target', sortable: false },
              { key: 'meta', header: 'Details', sortable: false },
            ]}
            rows={rows.map((r) => ({ id: r.id, at: r.atMs, actor: r.actor, action: r.action, target: r.target, meta: metaSummary(r.meta) }))}
          />
          <nav aria-label="Pages" className="mt-3 flex items-center justify-between text-sm">
            {page > 1 ? <Link href={link(page - 1)} className="text-blue-700 hover:underline dark:text-blue-400">← Newer</Link> : <span />}
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Page {page} of {pages} · {total} entries
            </span>
            {page < pages ? <Link href={link(page + 1)} className="text-blue-700 hover:underline dark:text-blue-400">Older →</Link> : <span />}
          </nav>
        </Card>
      </div>
    </CompanyScopeProvider>
  );
}
