import { Badge } from '@/components/Badge';
import { formatDateTime } from '@/components/format';
import type { AuditRow } from '@/lib/platform/companies';

const LABEL: Record<string, string> = {
  'platform.company_created': 'Company created',
  'platform.plan_changed': 'Plan changed',
  'platform.company_suspended': 'Suspended',
  'platform.company_unsuspended': 'Reactivated',
  'platform.admin_invited': 'Admin invited',
};

function detail(r: AuditRow): string {
  const m = r.meta as Record<string, string | undefined>;
  switch (r.action) {
    case 'platform.plan_changed':
      return `${m.from} → ${m.to}`;
    case 'platform.company_created':
      return `plan ${m.plan}, first admin ${m.adminEmail}`;
    case 'platform.company_suspended':
      return m.reason ? `reason: ${m.reason}` : '';
    case 'platform.admin_invited':
      return r.target ?? '';
    default:
      return '';
  }
}

/** Server-rendered audit list (platform actions). */
export function AuditTable({ rows, showCompany = false }: { rows: AuditRow[]; showCompany?: boolean }) {
  if (rows.length === 0) {
    return <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">No platform actions yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Platform actions</caption>
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <th className="whitespace-nowrap px-2 py-2 font-medium">When (UTC)</th>
            <th className="px-2 py-2 font-medium">Action</th>
            {showCompany && <th className="px-2 py-2 font-medium">Company</th>}
            <th className="px-2 py-2 font-medium">Detail</th>
            <th className="px-2 py-2 font-medium">By</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatDateTime(r.at)}</td>
              <td className="whitespace-nowrap px-2 py-2">
                <Badge tone={r.action.includes('suspended') ? 'bad' : 'neutral'}>{LABEL[r.action] ?? r.action}</Badge>
              </td>
              {showCompany && <td className="px-2 py-2">{r.companyName ?? '—'}</td>}
              <td className="px-2 py-2">{detail(r) || '—'}</td>
              <td className="px-2 py-2">{r.actorEmail ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
