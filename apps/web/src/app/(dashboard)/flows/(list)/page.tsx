import Link from 'next/link';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { exportUrl } from '@/components/export-url';
import { FilterBar } from '@/components/FilterBar';
import { KpiTile } from '@/components/KpiTile';
import { PageHeader } from '@/components/PageHeader';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { getFlows } from '@/lib/queries/flows';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { canSeeUsers } from '@/lib/queries/scope';
import { OUTCOME_VALUES, parseTurnParams } from '../../turns/_helpers';
import { flowKpis, flowsListHref, flowsPaging, toFlowTableRows } from '../_helpers';

export const metadata = { title: 'Agent flows' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const columns: Column[] = [
  { key: 'startedMs', header: 'Started (UTC)', kind: 'datetime', align: 'left' },
  { key: 'project', header: 'Project', kind: 'text' },
  { key: 'name', header: 'Flow', kind: 'text', hrefKey: 'href', hint: 'Stages of a workflow, or the agents of a sequence' },
  { key: 'kind', header: 'Kind', kind: 'text', hint: 'workflow = one Workflow-tool run; agent sequence = Agent-tool runs that hand work on' },
  { key: 'steps', header: 'Steps', kind: 'int' },
  { key: 'stages', header: 'Stages', kind: 'text' },
  { key: 'durationMs', header: 'Duration', kind: 'duration', hint: 'First step start to last step end' },
  { key: 'tokens', header: 'Tokens', kind: 'tokens' },
  { key: 'cost', header: '≈ Cost', kind: 'cost', hint: "≈ per step at the run's model price on that day; n/a when the model has no price" },
  { key: 'models', header: 'Models', kind: 'text' },
  { key: 'outcome', header: 'Outcome', kind: 'outcome', hint: 'failed if any step failed, else abandoned if any was, else success when all are known' },
];

export default async function FlowsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filters = parseFilters(sp, { allowUser: canSeeUsers(user) });
  const { page, outcome } = parseTurnParams(sp);
  const { options, list } = await withDashboardContext(user, async (ctx) => ({
    options: await loadFilterOptions(ctx),
    list: await getFlows(ctx, filters, { page, outcome }),
  }));

  const rows = toFlowTableRows(list.flows);
  const kpis = flowKpis(list.totals, list.truncated);
  const { first, last, lastPage, pastEnd, hasPrev, hasNext, emptyMessage } = flowsPaging(page, list.pageSize, list.total, rows.length);
  const pill = (active: boolean) =>
    `inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium ${
      active
        ? 'border-blue-600 bg-blue-600 text-white'
        : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
    }`;
  const btn = 'inline-flex h-8 items-center rounded-md border border-zinc-300 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agent flows"
        description="Multi-step sub-agent flows of one turn: a Workflow-tool run, or Agent-tool agents that hand work to each other. Only flows with 2 or more steps, newest first. Costs are ≈ at API list prices."
      />
      <FilterBar filters={filters} options={options} />
      {list.ignoredFilters.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">Not applied in aggregates-only mode: {list.ignoredFilters.join(', ')}.</p>
      )}
      {list.truncated && (
        <p role="note" className="text-xs text-amber-700 dark:text-amber-400">
          Too many sub-agent runs in this range: the first 20,000 were read, so the newest flows may be missing or incomplete. Narrow the date range or add a filter.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <KpiTile key={k.label} label={k.label} value={k.value} sub={k.sub} title={k.title} />
        ))}
      </div>
      <Card title="Flows" description={`${list.total} matching`}>
        <nav aria-label="Outcome filter" className="mb-3 flex flex-wrap gap-2">
          <Link href={flowsListHref(sp, { outcome: null })} className={pill(!outcome)}>
            all outcomes
          </Link>
          {OUTCOME_VALUES.map((o) => (
            <Link key={o} href={flowsListHref(sp, { outcome: o })} className={pill(outcome === o)}>
              {o}
            </Link>
          ))}
        </nav>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey="id"
          caption="Agent flows"
          emptyMessage={emptyMessage}
          exportHref={exportUrl('flows', filters, { outcome })}
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{rows.length > 0 ? `Rows ${first}–${last} of ${list.total}` : ''}</span>
          <div className="flex gap-2">
            {pastEnd && (
              <Link href={flowsListHref(sp, { page: lastPage })} className={btn}>
                Last page
              </Link>
            )}
            {hasPrev && (
              <Link href={flowsListHref(sp, { page: page - 1 })} className={btn} rel="prev">
                Previous
              </Link>
            )}
            {hasNext && (
              <Link href={flowsListHref(sp, { page: page + 1 })} className={btn} rel="next">
                Next
              </Link>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
