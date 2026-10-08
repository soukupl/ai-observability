import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { Card } from '@/components/Card';
import { StackedBar100 } from '@/components/charts/StackedBar100';
import { exportUrl } from '@/components/export-url';
import { FilterBar } from '@/components/FilterBar';
import { PageHeader } from '@/components/PageHeader';
import { requireUser } from '@/lib/auth/session';
import { parseFilters, serializeFilters } from '@/lib/filters';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { getPhases, PHASE_GROUPS, PHASES } from '@/lib/queries/phases';
import { addDays } from '@/lib/queries/range';
import { canSeeUsers } from '@/lib/queries/scope';
import { rows as sqlRows } from '@/lib/queries/sqlutil';
import { chartRows, GROUP_LABEL, parseGroup } from './helpers';
import { PhaseRules } from './PhaseRules';
import { PhaseTable } from './PhaseTable';

export const metadata = { title: 'Phases' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PhasesPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filters = parseFilters(sp, { allowUser: canSeeUsers(user) });
  const group = parseGroup(sp.group);

  const { options, phases, versions } = await withDashboardContext(user, async (ctx) => {
    const options = await loadFilterOptions(ctx);
    const phases = await getPhases(ctx, filters, group);
    // Rule versions present in the range (RLS-scoped); usually one.
    const v = await sqlRows<{ v: unknown }>(
      ctx.tx,
      sql`select distinct phase_rules_version as v from turns
          where started_at >= ${phases.range.fromIso}::timestamptz and started_at < ${phases.range.toIso}::timestamptz order by 1`,
    );
    return { options, phases, versions: v.map((r) => Number(r.v)) };
  });

  const groupHref = (g: string) => {
    const p = serializeFilters(filters);
    p.set('group', g);
    return `/phases?${p.toString()}`;
  };
  const data = chartRows(phases.rows, group);
  const label = GROUP_LABEL[group];

  return (
    <>
      <PageHeader
        title="Phases"
        description={`Where time goes, ${phases.range.fromDay} to ${addDays(phases.range.toDay, -1)} (UTC), by ${label.toLowerCase()}. Always read from raw turns; very long ranges beyond raw retention are empty.`}
      />
      <FilterBar filters={filters} options={options} />
      <nav aria-label="Group by" className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-500 dark:text-zinc-400">Group by</span>
        {PHASE_GROUPS.map((g) => (
          <Link
            key={g}
            href={groupHref(g)}
            aria-current={g === group ? 'page' : undefined}
            className={`rounded-md border px-3 py-1.5 font-medium ${
              g === group
                ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            {GROUP_LABEL[g]}
          </Link>
        ))}
      </nav>
      {phases.ignoredFilters.length > 0 && (
        <p role="note" className="mb-3 text-xs text-amber-700 dark:text-amber-400">
          Not applied in this view (aggregates-only mode): {phases.ignoredFilters.join(', ')}.
        </p>
      )}
      <div className="space-y-4">
        <Card title={`Time split by ${label.toLowerCase()}`} description="Each bar is 100 % of that row's phase time; hover for hours and share.">
          {data.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              No phase data for this selection. Try a wider range or fewer filters.
            </p>
          ) : (
            <StackedBar100 rows={data} keys={[...PHASES]} valueFormat="duration" ariaLabel={`Phase time split by ${label.toLowerCase()}`} />
          )}
        </Card>
        {data.length > 0 && (
          <Card title="Hours and share">
            <PhaseTable rows={phases.rows} group={group} groupLabel={label} exportHref={exportUrl('phases', filters, { group })} />
          </Card>
        )}
        <PhaseRules version={versions} />
      </div>
    </>
  );
}
