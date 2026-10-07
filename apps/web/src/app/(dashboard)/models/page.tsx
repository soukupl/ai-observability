import Link from 'next/link';
import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { EffortSuggestions } from '@/components/EffortSuggestions';
import { HBarChart } from '@/components/charts/HBarChart';
import { exportUrl } from '@/components/export-url';
import { FilterBar } from '@/components/FilterBar';
import { PageHeader } from '@/components/PageHeader';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { getEffortAdvice } from '@/lib/queries/effort';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { getModelsEffort } from '@/lib/queries/models';
import { withDashboardContext } from '@/lib/queries/page';
import { addDays } from '@/lib/queries/range';
import { canSeeUsers } from '@/lib/queries/scope';
import { getWastedSpend } from '@/lib/queries/wasted';
import { chartData, parseGrouping, PRIMARY_TURNS_HINT, toTableRows, withWasted, type Grouping } from './group';

export const metadata = { title: 'Models & effort' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function Toggle({ current, params }: { current: Grouping; params: Record<string, string | string[] | undefined> }) {
  const href = (g: Grouping) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (k !== 'group' && typeof v === 'string') p.set(k, v);
    p.set('group', g);
    return `?${p.toString()}`;
  };
  const cls = (on: boolean) =>
    `inline-flex h-8 items-center px-3 text-xs font-medium ${on ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'}`;
  return (
    <div role="group" aria-label="Group by" className="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
      <Link href={href('effort')} className={cls(current === 'effort')} aria-current={current === 'effort'} scroll={false}>Model × effort</Link>
      <Link href={href('model')} className={cls(current === 'model')} aria-current={current === 'model'} scroll={false}>Model only</Link>
    </div>
  );
}

export default async function ModelsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filters = parseFilters(sp, { allowUser: canSeeUsers(user) });
  const group = parseGrouping(sp.group);
  const { options, result, advice, wasted } = await withDashboardContext(user, async (ctx) => ({
    options: await loadFilterOptions(ctx),
    result: await getModelsEffort(ctx, filters),
    advice: await getEffortAdvice(ctx, filters),
    wasted: await getWastedSpend(ctx, filters),
  }));
  const rows = withWasted(toTableRows(result.rows, group), wasted.byModel, group);

  const columns: Column[] = [
    { key: 'model', header: 'Model', kind: 'text' },
    ...(group === 'effort' ? [{ key: 'effort', header: 'Effort', kind: 'text' } as Column] : []),
    { key: 'turns', header: 'Primary turns', kind: 'int', align: 'right', hint: PRIMARY_TURNS_HINT },
    { key: 'input', header: 'Input', kind: 'tokens', align: 'right', hint: 'Excludes cache reads and writes.' },
    { key: 'output', header: 'Output', kind: 'tokens', align: 'right', hint: 'Includes thinking tokens.' },
    { key: 'cacheRead', header: 'Cache read', kind: 'tokens', align: 'right' },
    { key: 'cacheWrite', header: 'Cache write', kind: 'tokens', align: 'right' },
    { key: 'total', header: 'Total', kind: 'tokens', align: 'right' },
    { key: 'cost', header: '≈ Cost', kind: 'cost', align: 'right', hint: '≈ at API list prices; n/a when the model has no price.' },
    { key: 'wasted', header: 'Wasted ≈', kind: 'cost', align: 'right', hint: '≈ Cost of failed and abandoned turns (tokens of this model × effort).' },
    { key: 'wastedShare', header: 'Wasted share', kind: 'percent', align: 'right', hint: 'Wasted ≈ cost / ≈ cost.' },
    { key: 'successRate', header: 'Success', kind: 'percent', align: 'right', hint: 'Successful / turns with a known outcome.' },
    { key: 'unknownShare', header: 'Unknown', kind: 'percent', align: 'right', hint: 'Share of turns with unknown outcome (not counted as failures).' },
    { key: 'medianDurationMs', header: 'Median time', kind: 'duration', align: 'right', hint: result.medianAvailable ? 'Median turn duration.' : 'Median needs raw turns (older than your retention window are gone).' },
  ];
  const noMedian = !result.medianAvailable;
  const costBars = chartData(rows, group, (r) => r.cost.usd);
  const tokenBars = chartData(rows, group, (r) => r.total);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Models & effort"
        description={`${result.range.fromDay} to ${addDays(result.range.toDay, -1)} (UTC). Cost is ≈ at API list prices.`}
        actions={<Toggle current={group} params={sp} />}
      />
      <FilterBar filters={filters} options={options} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card title="≈ Cost by model" description="≈ at API list prices; models without a price are omitted.">
          {costBars.length ? <HBarChart data={costBars} valueFormat="cost" labelWidth={group === 'model' ? 130 : 170} ariaLabel="Estimated cost by model" /> : <p className="py-6 text-center text-sm text-zinc-500">No priced usage.</p>}
        </Card>
        <Card title="Tokens by model" description="Input + output + cache.">
          {tokenBars.length ? <HBarChart data={tokenBars} valueFormat="tokens" labelWidth={group === 'model' ? 130 : 170} ariaLabel="Tokens by model" /> : <p className="py-6 text-center text-sm text-zinc-500">No usage.</p>}
        </Card>
      </div>
      <EffortSuggestions advice={advice} />
      <Card title={group === 'model' ? 'By model' : 'By model × effort'}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey="key"
          caption="Models and effort"
          emptyMessage="No model usage for this selection. Try a wider date range or fewer filters."
          exportHref={exportUrl('models', filters)}
          defaultSort={{ key: 'cost', dir: 'desc' }}
        />
        <ul className="mt-3 space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          <li>The CSV export is always model × effort.</li>
          {rows.some((r) => r.turns === null) && <li>A — under Primary turns means the model only ran inside sub-agents: its tokens and cost are counted, but no turn has it as its primary model.</li>}
          {noMedian && <li>Median duration needs raw turns, which are gone past your retention window; shown as —.</li>}
          {group === 'model' && !noMedian && <li>Median is shown only for models with a single effort level; medians cannot be combined.</li>}
        </ul>
      </Card>
    </div>
  );
}
