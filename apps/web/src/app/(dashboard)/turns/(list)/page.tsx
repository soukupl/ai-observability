import Link from 'next/link';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { exportUrl } from '@/components/export-url';
import { FilterBar } from '@/components/FilterBar';
import { PageHeader } from '@/components/PageHeader';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { canSeeUsers, usesAggregateFunctions } from '@/lib/queries/scope';
import { listTurns, TURN_PAGE_SIZE } from '@/lib/queries/turns';
import { listHref, OUTCOME_VALUES, parseTurnParams, toTableRows } from '../_helpers';

export const metadata = { title: 'Turns' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function TurnsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filters = parseFilters(sp, { allowUser: canSeeUsers(user) });
  const { page, outcome } = parseTurnParams(sp);
  const { options, list } = await withDashboardContext(user, async (ctx) => ({
    options: await loadFilterOptions(ctx),
    list: await listTurns(ctx, filters, { page, pageSize: TURN_PAGE_SIZE, outcome }),
  }));

  const showUser = canSeeUsers(user) && !usesAggregateFunctions(user);
  const rows = toTableRows(list.rows);
  const showAttribution = rows.some((r) => r.attribution);
  const columns: Column[] = [
    { key: 'startedMs', header: 'Started (UTC)', kind: 'datetime', hrefKey: 'href', align: 'left' },
    ...(showUser ? [{ key: 'user', header: 'User', kind: 'text' as const }] : []),
    { key: 'project', header: 'Project', kind: 'text' },
    { key: 'harness', header: 'Harness', kind: 'text' },
    { key: 'model', header: 'Model', kind: 'model' },
    { key: 'effort', header: 'Effort', kind: 'text' },
    { key: 'durationMs', header: 'Duration', kind: 'duration' },
    { key: 'tokens', header: 'Tokens', kind: 'tokens' },
    { key: 'cost', header: '≈ Cost', kind: 'cost', hint: '≈ at API list prices; n/a when the model has no price' },
    { key: 'outcome', header: 'Outcome', kind: 'outcome' },
    ...(showAttribution ? [{ key: 'attribution', header: 'Attribution', kind: 'text' as const, hint: 'verified / matched / unverified' }] : []),
    { key: 'summary', header: 'Summary', kind: 'text' },
  ];

  const first = (page - 1) * list.pageSize + 1;
  const last = (page - 1) * list.pageSize + list.rows.length;
  const pill = (active: boolean) =>
    `inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium ${
      active
        ? 'border-blue-600 bg-blue-600 text-white'
        : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
    }`;
  const btn = 'inline-flex h-8 items-center rounded-md border border-zinc-300 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';

  return (
    <>
      <PageHeader
        title="Turns"
        description="Single turns, newest first. Costs are ≈ at API list prices. Unknown outcomes are shown, not hidden. The last 35 days at most are read from raw turns."
      />
      <FilterBar filters={filters} options={options} />
      {list.ignoredFilters.length > 0 && (
        <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">Not applied in aggregates-only mode: {list.ignoredFilters.join(', ')}.</p>
      )}
      <Card
        title="Turns"
        description={list.total !== null ? `${list.total} matching` : 'Total not available in aggregates-only mode.'}
      >
        <nav aria-label="Outcome filter" className="mb-3 flex flex-wrap gap-2">
          <Link href={listHref(sp, { outcome: null })} className={pill(!outcome)}>
            all outcomes
          </Link>
          {OUTCOME_VALUES.map((o) => (
            <Link key={o} href={listHref(sp, { outcome: o })} className={pill(outcome === o)}>
              {o}
            </Link>
          ))}
        </nav>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey="id"
          caption="Turns"
          emptyMessage="No turns match these filters. Widen the date range or clear a filter."
          exportHref={exportUrl('turns', filters, { outcome })}
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{rows.length > 0 ? `Rows ${first}–${last}${list.total !== null ? ` of ${list.total}` : ''}` : ''}</span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={listHref(sp, { page: page - 1 })} className={btn} rel="prev">
                Previous
              </Link>
            )}
            {list.hasNext && (
              <Link href={listHref(sp, { page: page + 1 })} className={btn} rel="next">
                Next
              </Link>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}
