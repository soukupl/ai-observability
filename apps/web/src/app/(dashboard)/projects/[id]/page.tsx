import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { DataTable } from '@/components/DataTable';
import { EffortSuggestions } from '@/components/EffortSuggestions';
import { exportUrl } from '@/components/export-url';
import { FilterBar } from '@/components/FilterBar';
import { KpiTile } from '@/components/KpiTile';
import { PageHeader } from '@/components/PageHeader';
import { StackedBar100 } from '@/components/charts/StackedBar100';
import { TokensAreaChart } from '@/components/charts/TokensAreaChart';
import { formatCost, formatDuration, formatInt, formatPercent, formatTokens } from '@/components/format';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { getEffortAdvice } from '@/lib/queries/effort';
import { getKpis } from '@/lib/queries/kpis';
import { listProjects, loadFilterOptions, listTeams } from '@/lib/queries/lookups';
import { getModelsEffort } from '@/lib/queries/models';
import { withDashboardContext } from '@/lib/queries/page';
import { getPhases } from '@/lib/queries/phases';
import { canSeeUsers } from '@/lib/queries/scope';
import { getTokenSeries } from '@/lib/queries/timeseries';
import { listTurns } from '@/lib/queries/turns';
import { zeroFilledChartRows } from '../../overview/helpers';
import { MODEL_COLUMNS, isUnnamedHash, modelTableRows, phaseStackRows, turnsHref } from '../helpers';

export const metadata = { title: 'Project' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProjectDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const user = await requireUser();
  const base = parseFilters(await searchParams, { allowUser: canSeeUsers(user) });
  const f = { ...base, projectId: id };

  const data = await withDashboardContext(user, async (ctx) => {
    const projects = await listProjects(ctx);
    const project = projects.find((p) => p.id === id);
    if (!project) return null;
    return {
      project,
      teams: await listTeams(ctx),
      options: await loadFilterOptions(ctx),
      kpis: await getKpis(ctx, f),
      series: await getTokenSeries(ctx, f),
      models: await getModelsEffort(ctx, f),
      advice: await getEffortAdvice(ctx, f),
      phases: await getPhases(ctx, f, 'project'),
      turns: await listTurns(ctx, f, { page: 1, pageSize: 10 }),
    };
  });
  if (!data) notFound();
  const { project, kpis, series, models, advice, phases, turns } = data;
  const team = data.teams.find((t) => t.id === project.teamId);
  const unnamed = isUnnamedHash(project);
  const stack = phaseStackRows(phases.rows);
  const success = kpis.successRate;
  const ignored = [...new Set([...kpis.ignoredFilters, ...phases.ignoredFilters, ...turns.ignoredFilters])];
  const chartData = zeroFilledChartRows(series.points, series.models);

  return (
    <>
      <PageHeader
        title={project.name}
        description={
          <>
            <Link href="/projects" className="text-blue-700 hover:underline dark:text-blue-400">
              All projects
            </Link>
            {' · '}Team: {team?.name ?? 'unmapped'} · Key: <span className="break-all font-mono text-xs">{project.key}</span>
          </>
        }
        actions={unnamed ? <Badge tone="info">Unnamed</Badge> : undefined}
      />
      {unnamed && <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">This project is identified by a hashed key: name it in Admin → Projects.</p>}
      <FilterBar filters={f} options={data.options} />
      {ignored.length > 0 && <p className="mb-3 text-xs text-amber-700 dark:text-amber-400">Not applied to every figure: {ignored.join(', ')}.</p>}
      {(kpis.approximate || kpis.medianApproximate) && <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{kpis.approximate ? 'Median and outcome shares' : 'The median'} come{kpis.approximate ? '' : 's'} from a sample of recent turns.</p>}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile label="Turns" value={formatInt(kpis.turns)} />
        <KpiTile label="Tokens" value={formatTokens(kpis.tokens.total)} sub={`${formatTokens(kpis.tokens.input)} in · ${formatTokens(kpis.tokens.output)} out · ${formatTokens(kpis.tokens.cacheRead)} cache`} />
        <KpiTile label="Est. cost" value={formatCost(kpis.cost)} sub={kpis.cost.partial ? `no price for ${kpis.cost.unknownModels.join(', ')}` : '≈ at API list prices'} />
        <KpiTile
          label="Success rate"
          value={formatPercent(success)}
          sub={`${formatPercent(kpis.unknownShare)} of turns unknown`}
          tone={success === null ? 'default' : success >= 0.8 ? 'good' : success >= 0.5 ? 'warn' : 'bad'}
        />
        <KpiTile label="Median turn" value={kpis.medianAvailable ? formatDuration(kpis.medianDurationMs) : 'n/a'} sub={kpis.medianAvailable ? (kpis.medianApproximate ? 'from a sample of recent turns' : undefined) : 'needs raw turns (older than your retention window are gone)'} />
      </div>

      <div className="space-y-4">
        <Card title="Tokens over time" description="By model, per UTC day.">
          {kpis.turns === 0 ? <Empty /> : <TokensAreaChart data={chartData} series={series.models} />}
        </Card>
        <Card title="Models and effort" description="A turn counts for its primary model. Cost is ≈ at API list prices.">
          <DataTable caption="Models and effort" columns={MODEL_COLUMNS} rows={modelTableRows(models.rows)} defaultSort={{ key: 'tokens', dir: 'desc' }} exportHref={exportUrl('models', f)} emptyMessage="No turns for this project in this range." />
        </Card>
        <EffortSuggestions advice={advice} showProject={false} />
        <Card title="Time by phase" description="Share of turn time per phase (raw turns only).">
          {stack.rows.length === 0 ? <Empty text="No phase data in this range." /> : <StackedBar100 rows={stack.rows} keys={stack.keys} valueFormat="duration" ariaLabel="Time by phase" />}
        </Card>
        <Card
          title="Recent turns"
          actions={
            <Link href={turnsHref(id, base)} className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400">
              All turns
            </Link>
          }
        >
          {turns.rows.length === 0 ? (
            <Empty text="No turns in this range." />
          ) : (
            <DataTable
              caption="Recent turns"
              columns={[
                { key: 'started', header: 'Started', kind: 'datetime', hrefKey: 'href' },
                { key: 'model', header: 'Model', kind: 'text' },
                { key: 'effort', header: 'Effort', kind: 'text' },
                { key: 'tokens', header: 'Tokens', kind: 'tokens' },
                { key: 'cost', header: '≈ Cost', kind: 'cost' },
                { key: 'duration', header: 'Duration', kind: 'duration' },
                { key: 'outcome', header: 'Outcome', kind: 'outcome' },
              ]}
              rows={turns.rows.map((t) => ({ id: t.id, href: `/turns/${t.id}`, started: t.startedMs, model: t.model, effort: t.effort, tokens: t.tokens.total, cost: t.cost, duration: t.durationMs, outcome: t.outcome }))}
              rowKey="id"
              defaultSort={{ key: 'started', dir: 'desc' }}
            />
          )}
        </Card>
      </div>
    </>
  );
}

function Empty({ text = 'No turns for this project in this range.' }: { text?: string }) {
  return <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">{text}</p>;
}
