import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { requireSuperAdminOr404 } from '@/lib/platform/guard';
import { PLANS } from '@/lib/platform/plans';

export const metadata = { title: 'Plans' };

const num = (n: number | null) => (n === null ? 'unlimited' : String(n));
const yes = (b: boolean) => (b ? 'Yes' : '–');

export default async function PlansPage() {
  await requireSuperAdminOr404();
  const rows: [string, (p: (typeof PLANS)[number]) => string][] = [
    ['Users', (p) => num(p.maxUsers)],
    ['Teams', (p) => num(p.maxTeams)],
    ['Max raw retention', (p) => p.retentionLabel],
    ['Budgets', (p) => yes(p.budgets)],
    ['SSO (when built)', (p) => yes(p.sso)],
  ];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Plans"
        description="Definitions are placeholders (BRIEF §10), no payments. New sign-ups land on Free; the plan of a company is set on its page."
      />
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Plan definitions</caption>
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th scope="col" className="px-2 py-2 font-medium" />
                {PLANS.map((p) => (
                  <th key={p.id} scope="col" className="px-2 py-2 font-medium">
                    {p.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, f]) => (
                <tr key={label} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <th scope="row" className="whitespace-nowrap px-2 py-2 text-left font-medium">
                    {label}
                  </th>
                  {PLANS.map((p) => (
                    <td key={p.id} className="px-2 py-2 tabular-nums">
                      {f(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Limits are shown to the platform for now; ingest and the dashboard do not enforce them yet.</p>
      </Card>
    </div>
  );
}
