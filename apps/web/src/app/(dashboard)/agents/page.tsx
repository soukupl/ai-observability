import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar } from '@/components/FilterBar';
import { KpiTile } from '@/components/KpiTile';
import { PageHeader } from '@/components/PageHeader';
import { exportUrl } from '@/components/export-url';
import { formatInt, formatTokens } from '@/components/format';
import { HBarChart } from '@/components/charts/HBarChart';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { getAgents } from '@/lib/queries/agents';
import { getKpis } from '@/lib/queries/kpis';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { addDays } from '@/lib/queries/range';
import { canSeeUsers } from '@/lib/queries/scope';
import { agentTableRows, depthBars, spawnsPerTurn, tokenBars } from './agents-view';

export const metadata = { title: 'Agents' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const COLUMNS: Column[] = [
  { key: 'agentType', header: 'Agent type', kind: 'text', align: 'left' },
  { key: 'spawns', header: 'Spawns', kind: 'int', align: 'right', hint: 'Sub-agent runs started.' },
  { key: 'tokens', header: 'Tokens', kind: 'tokens', align: 'right' },
  { key: 'tokenShare', header: 'Token share', kind: 'percent', align: 'right', hint: 'Share of all sub-agent tokens.' },
  { key: 'successRate', header: 'Success rate', kind: 'percent', align: 'right', hint: 'Successful runs / runs with a known outcome.' },
  { key: 'unknownShare', header: 'Unknown', kind: 'percent', align: 'right', hint: 'Runs whose outcome could not be determined; not counted as failures.' },
  { key: 'avgDepth', header: 'Avg depth', kind: 'text', align: 'right' },
  { key: 'maxDepth', header: 'Max depth', kind: 'int', align: 'right' },
];

export default async function AgentsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const filters = parseFilters(await searchParams, { allowUser: canSeeUsers(user) });
  const { options, agents, kpis } = await withDashboardContext(user, async (ctx) => ({
    options: await loadFilterOptions(ctx),
    agents: await getAgents(ctx, filters),
    kpis: await getKpis(ctx, filters),
  }));
  const bars = tokenBars(agents);
  const depth = depthBars(agents);
  const perTurn = spawnsPerTurn(agents.totalSpawns, kpis.turns);
  const subTokens = agents.rows.reduce((s, r) => s + r.tokens.total, 0);
  const ignored = [...new Set([...agents.ignoredFilters, ...kpis.ignoredFilters])];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agents"
        description={`Sub-agent usage, ${agents.range.fromDay} to ${addDays(agents.range.toDay, -1)} (UTC). Read from raw turns.`}
      />
      <FilterBar filters={filters} options={options} />
      {ignored.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="note">
          Not applied to every figure in aggregates-only mode: {ignored.join(', ')}.
        </p>
      )}
      {agents.rows.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No sub-agent runs for this selection. Main-agent work is not listed here.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile label="Sub-agent spawns" value={formatInt(agents.totalSpawns)} sub={`${agents.rows.length} agent types`} />
            <KpiTile
              label="Spawns per turn"
              value={perTurn === null ? 'n/a' : perTurn.toFixed(2)}
              sub={`${formatInt(kpis.turns)} turns in range`}
              title="Sub-agent spawns divided by turns. One turn can spawn several sub-agents, so this is not the share of turns that used any."
            />
            <KpiTile label="Sub-agent tokens" value={formatTokens(subTokens)} sub="tokens used by sub-agent runs" />
          </div>
          <Card title="Tokens by agent type" description="Tokens used by sub-agent runs of each type.">
            <HBarChart data={bars} valueFormat="tokens" ariaLabel="Tokens by agent type" />
          </Card>
          <Card title="Sub-agent depth" description="Runs per nesting depth.">
            {depth && depth.length > 0 ? (
              <HBarChart data={depth} valueFormat="int" labelWidth={80} ariaLabel="Runs by nesting depth" />
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                The depth histogram is not available in aggregates-only mode; average and maximum depth per type are in the table.
              </p>
            )}
          </Card>
          <Card title="Agent types">
            <DataTable columns={COLUMNS} rows={agentTableRows(agents)} exportHref={exportUrl('agents', filters)} />
          </Card>
        </div>
      )}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Success rate counts runs with a known outcome; the unknown share is shown separately.
      </p>
    </div>
  );
}
