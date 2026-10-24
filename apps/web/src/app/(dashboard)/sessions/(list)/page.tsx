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
import { listActiveSessions, listSessions, SESSION_PAGE_SIZE } from '@/lib/queries/sessions';
import { parseSessionPage, sessionsListHref, toSessionTableRows } from '../_helpers';
import { ActiveNow } from './ActiveNow';

export const metadata = { title: 'Sessions' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SessionsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filters = parseFilters(sp, { allowUser: canSeeUsers(user) });
  const page = parseSessionPage(sp);
  const { options, list, active } = await withDashboardContext(user, async (ctx) => ({
    options: await loadFilterOptions(ctx),
    list: await listSessions(ctx, filters, { page, pageSize: SESSION_PAGE_SIZE }),
    active: await listActiveSessions(ctx),
  }));

  const showUser = canSeeUsers(user) && !usesAggregateFunctions(user);
  const rows = toSessionTableRows(list.rows);
  const columns: Column[] = [
    { key: 'title', header: 'Session', kind: 'text', hrefKey: 'href', hint: 'Title: the first turn summary (or the start of the session id); "(open)" = no session end yet and active in the last 30 minutes' },
    { key: 'startedMs', header: 'Started (UTC)', kind: 'datetime', align: 'left' },
    ...(showUser ? [{ key: 'user', header: 'User', kind: 'text' as const }] : []),
    { key: 'project', header: 'Project', kind: 'text' },
    { key: 'harness', header: 'Harness', kind: 'text' },
    { key: 'spanMs', header: 'Span', kind: 'duration', hint: 'First activity to last: workflow agents that outlive their turn count' },
    { key: 'turns', header: 'Turns', kind: 'int' },
    { key: 'runs', header: 'Sub-agents', kind: 'int' },
    { key: 'workflows', header: 'Workflows', kind: 'int', hint: 'Workflow-tool runs' },
    { key: 'flows', header: 'Flows', kind: 'int', hint: 'Agent flows of two or more steps' },
    { key: 'tokens', header: 'Tokens', kind: 'tokens' },
    { key: 'cost', header: '≈ Cost', kind: 'cost', hint: '≈ at API list prices; n/a when the model has no price' },
    { key: 'outcomes', header: 'Outcomes', kind: 'text', hint: 'Turn outcomes of the session' },
  ];

  const first = (page - 1) * list.pageSize + 1;
  const last = (page - 1) * list.pageSize + list.rows.length;
  const hasNext = page * list.pageSize < list.total;
  const btn = 'inline-flex h-8 items-center rounded-md border border-zinc-300 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Harness sessions (what claude --resume lists), newest first: their turns, sub-agents, workflows and flows together. A session is listed when it was active in the range and has a turn matching the filters; its figures cover the whole session. Costs are ≈ at API list prices."
      />
      <ActiveNow initial={active} showUser={showUser} />
      <FilterBar filters={filters} options={options} />
      {list.ownOnly && (
        <p role="note" className="mb-3 text-xs text-amber-700 dark:text-amber-400">
          Aggregates-only mode: a session is one person&apos;s stream of work, so only your own sessions are listed.
        </p>
      )}
      {list.flowsTruncated && (
        <p role="note" className="mb-3 text-xs text-amber-700 dark:text-amber-400">
          These sessions have more than 20,000 sub-agent runs; flow counts may be low.
        </p>
      )}
      <Card title="Sessions" description={`${list.total} matching`}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey="id"
          caption="Sessions"
          emptyMessage="No sessions match these filters. Widen the date range or clear a filter."
          exportHref={exportUrl('sessions', filters)}
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{rows.length > 0 ? `Rows ${first}–${last} of ${list.total}` : ''}</span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={sessionsListHref(sp, { page: page - 1 })} className={btn} rel="prev">
                Previous
              </Link>
            )}
            {hasNext && (
              <Link href={sessionsListHref(sp, { page: page + 1 })} className={btn} rel="next">
                Next
              </Link>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}
