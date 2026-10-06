import { Card } from '@/components/Card';
import { FilterBar } from '@/components/FilterBar';
import { KpiTile } from '@/components/KpiTile';
import { PageHeader } from '@/components/PageHeader';
import { formatCost, formatDuration, formatInt, formatPercent, formatTokens } from '@/components/format';
import { TokensAreaChart } from '@/components/charts/TokensAreaChart';
import { exportUrl } from '@/components/export-url';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { getBudgetProgress } from '@/lib/queries/budgets';
import { getKpis } from '@/lib/queries/kpis';
import { getTokenSeries } from '@/lib/queries/timeseries';
import { addDays } from '@/lib/queries/range';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { canSeeUsers } from '@/lib/queries/scope';
import { BudgetBars } from './BudgetBars';
import { zeroFilledChartRows } from './helpers';
import { OutcomeMix } from './OutcomeMix';

export const metadata = { title: 'Overview' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function OverviewPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const filters = parseFilters(await searchParams, { allowUser: canSeeUsers(user) });
  const { options, kpis, series, budgets } = await withDashboardContext(user, async (ctx) => ({
    options: await loadFilterOptions(ctx),
    kpis: await getKpis(ctx, filters),
    series: await getTokenSeries(ctx, filters),
    budgets: await getBudgetProgress(ctx),
  }));
  const rollup = kpis.range.source === 'rollup';
  const success = kpis.successRate;
  const empty = kpis.turns === 0;
  const chartData = zeroFilledChartRows(series.points, series.models);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Overview"
        description={`${kpis.range.fromDay} to ${addDays(kpis.range.toDay, -1)} (UTC). ${rollup ? 'Long range: read from daily rollups.' : 'Read from raw turns.'}`}
      />
      <FilterBar filters={filters} options={options} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile label="Turns" value={formatInt(kpis.turns)} />
        <KpiTile
          label="Tokens"
          value={formatTokens(kpis.tokens.total)}
          sub={`${formatTokens(kpis.tokens.input)} in · ${formatTokens(kpis.tokens.output)} out · ${formatTokens(kpis.tokens.cacheRead)} cache`}
          title="Input excludes cache reads and writes; thinking tokens are part of output."
        />
        <KpiTile
          label="Est. cost"
          value={formatCost(kpis.cost)}
          sub={kpis.cost.partial ? `no price for ${kpis.cost.unknownModels.join(', ')}` : 'at API list prices'}
          title="Estimated at API list prices from the price table; not an invoice."
        />
        <KpiTile
          label="Success rate"
          value={formatPercent(success)}
          sub={`${formatPercent(kpis.unknownShare)} of turns unknown`}
          tone={success === null ? 'default' : success >= 0.8 ? 'good' : success >= 0.5 ? 'warn' : 'bad'}
          title="Successful turns / turns with a known outcome. Unknown outcomes (no tests, last turn of a session) are not counted as failures."
        />
        <KpiTile
          label="Median turn"
          value={kpis.medianAvailable ? formatDuration(kpis.medianDurationMs) : 'n/a'}
          sub={kpis.medianAvailable ? (kpis.medianApproximate ? 'from a sample of recent turns' : undefined) : 'needs raw turns (older than your retention window are gone)'}
        />
      </div>
      {kpis.ignoredFilters.length > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Not applied to every figure: {kpis.ignoredFilters.join(', ')} (aggregates-only mode).</p>
      )}
      <BudgetBars budgets={budgets} />
      <Card
        title="Tokens over time by model"
        description={rollup ? 'Daily rollups: attributed to each turn’s primary model.' : 'Tokens per day and model.'}
        actions={<a className="text-xs text-blue-600 hover:underline dark:text-blue-400" href={exportUrl('overview', filters)}>CSV</a>}
      >
        {empty ? (
          <p className="py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">No data in this range. Adjust the filters or the date range.</p>
        ) : (
          <TokensAreaChart data={chartData} series={series.models} />
        )}
      </Card>
      <OutcomeMix outcomes={kpis.outcomes} approximate={kpis.approximate} />
    </div>
  );
}
