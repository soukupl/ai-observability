import { Card } from '@/components/Card';
import { AgentGroupsTable } from '@/components/AgentGroupsTable';
import { FilterBar } from '@/components/FilterBar';
import { KpiTile } from '@/components/KpiTile';
import { PageHeader } from '@/components/PageHeader';
import { exportUrl } from '@/components/export-url';
import { formatInt, formatTokens } from '@/components/format';
import { HBarChart } from '@/components/charts/HBarChart';
import { AgentGraphWithZoom, TimelineWindowControls } from '@/components/charts/TimelineWindowControls';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { getAgentTimeline } from '@/lib/queries/agent-timeline';
import { getAgents } from '@/lib/queries/agents';
import { buildFlows } from '@/lib/queries/flows';
import { getKpis } from '@/lib/queries/kpis';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { addDays } from '@/lib/queries/range';
import { canSeeUsers, usesAggregateFunctions } from '@/lib/queries/scope';
import { depthBars, flowsQueryString, groupAgentRows, spawnsPerTurn, tokenBars } from './agents-view';
import { runHrefs, timelineFlowInput, timelineGraph, timelineNav } from './timeline-view';

export const metadata = { title: 'Agents' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AgentsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filters = parseFilters(sp, { allowUser: canSeeUsers(user) });
  const { options, agents, kpis, timeline, flows } = await withDashboardContext(user, async (ctx) => {
    const timeline = await getAgentTimeline(ctx, filters, sp);
    return {
      options: await loadFilterOptions(ctx),
      agents: await getAgents(ctx, filters),
      kpis: await getKpis(ctx, filters),
      timeline,
      // The window's flows, so every drawn run can link to its flow's detail page (brief dashboard-followups-2026-10-10).
      flows: buildFlows({ ...timelineFlowInput(timeline), links: timeline.links, prices: ctx.prices }),
    };
  });
  const groups = groupAgentRows(agents);
  const bars = tokenBars(groups);
  const depth = depthBars(agents);
  const perTurn = spawnsPerTurn(agents.totalSpawns, kpis.turns);
  const subTokens = agents.rows.reduce((s, r) => s + r.tokens.total, 0);
  const ignored = [...new Set([...agents.ignoredFilters, ...kpis.ignoredFilters, ...timeline.ignoredFilters])];
  const groupOrder = groups.map((g) => g.group);
  // Session lanes link to their session page only where they carry the stored id (not the aggregate pseudonyms).
  const graph = timelineGraph(timeline, groupOrder, runHrefs(flows, timeline.turns, timeline.runs), { sessionLinks: !usesAggregateFunctions(user) });
  const flowsQuery = flowsQueryString(sp);
  const nav = timelineNav('/agents', sp, timeline);
  const cut = timeline.truncated.turns || timeline.truncated.runs;
  const timelineCard = (
    <Card
      title="Agent timeline"
      description="One lane per session (harness and first turn's start), coloured by project. Turns are the trunk; each sub-agent branches off where it starts and merges back where it ends. Workflow agents often keep running after their turn has ended (dashed trunk). Click a sub-agent to open its flow (or its turn when it ran alone); click a turn to open the turn. Times are UTC."
    >
      <div className="space-y-3">
        <TimelineWindowControls day={timeline.window.day} fromMin={timeline.window.fromMin} toMin={timeline.window.toMin} {...nav} />
        {cut && (
          <p className="text-xs text-amber-700 dark:text-amber-400" role="note">
            This window has more than {timeline.truncated.turns ? '1,000 turns' : '5,000 sub-agent runs'}; only the earliest are drawn. Zoom in
            (drag on the time axis) or narrow the filters to see all of them.
          </p>
        )}
        <AgentGraphWithZoom graph={graph} day={timeline.window.day} />
      </div>
    </Card>
  );
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
        <div className="space-y-4">
          <Card>
            <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
              No sub-agent runs for this selection. Main-agent work is not listed here.
            </p>
          </Card>
          {timelineCard}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiTile label="Sub-agent spawns" value={formatInt(agents.totalSpawns)} sub={`${groups.length} agent groups · ${agents.rows.length} agent types`} />
            <KpiTile
              label="Spawns per turn"
              value={perTurn === null ? 'n/a' : perTurn.toFixed(2)}
              sub={`${formatInt(kpis.turns)} turns in range`}
              title="Sub-agent spawns divided by turns. One turn can spawn several sub-agents, so this is not the share of turns that used any."
            />
            <KpiTile label="Sub-agent tokens" value={formatTokens(subTokens)} sub="tokens used by sub-agent runs" />
          </div>
          {timelineCard}
          <Card title="Tokens by agent group" description="Tokens used by sub-agent runs of each group.">
            <HBarChart data={bars} valueFormat="tokens" ariaLabel="Tokens by agent group" />
          </Card>
          <Card title="Sub-agent depth" description="Runs per nesting depth.">
            {depth && depth.length > 0 ? (
              <HBarChart data={depth} valueFormat="int" labelWidth={80} ariaLabel="Runs by nesting depth" />
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                The depth histogram is not available in aggregates-only mode; average and maximum depth per group are in the table.
              </p>
            )}
          </Card>
          <Card title="Agent groups" description="One row per group; expand a group to see its agent types. “flows →” lists the multi-step flows of that group under the same filters.">
            <AgentGroupsTable key={JSON.stringify(filters)} rows={groups} exportHref={exportUrl('agents', filters)} flowsQuery={flowsQuery} />
          </Card>
        </div>
      )}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Success rate counts runs with a known outcome; the unknown share is shown separately.
      </p>
    </div>
  );
}
