import { Card } from '@/components/Card';
import { AgentGroupsTable } from '@/components/AgentGroupsTable';
import { FilterBar } from '@/components/FilterBar';
import { KpiTile } from '@/components/KpiTile';
import { PageHeader } from '@/components/PageHeader';
import { exportUrl } from '@/components/export-url';
import { formatInt, formatTokens } from '@/components/format';
import { AgentFlow } from '@/components/charts/AgentFlow';
import { HBarChart } from '@/components/charts/HBarChart';
import { AgentGraphWithZoom, TimelineWindowControls } from '@/components/charts/TimelineWindowControls';
import { requireUser } from '@/lib/auth/session';
import { parseFilters } from '@/lib/filters';
import { getAgentTimeline } from '@/lib/queries/agent-timeline';
import { getAgents } from '@/lib/queries/agents';
import { getKpis } from '@/lib/queries/kpis';
import { loadFilterOptions } from '@/lib/queries/lookups';
import { withDashboardContext } from '@/lib/queries/page';
import { addDays } from '@/lib/queries/range';
import { canSeeUsers } from '@/lib/queries/scope';
import { depthBars, groupAgentRows, spawnsPerTurn, tokenBars } from './agents-view';
import { FLOW_MAX_LANES, flowGraph } from './flow-view';
import { timelineGraph, timelineNav } from './timeline-view';

export const metadata = { title: 'Agents' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AgentsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const sp = await searchParams;
  const filters = parseFilters(sp, { allowUser: canSeeUsers(user) });
  const { options, agents, kpis, timeline } = await withDashboardContext(user, async (ctx) => ({
    options: await loadFilterOptions(ctx),
    agents: await getAgents(ctx, filters),
    kpis: await getKpis(ctx, filters),
    timeline: await getAgentTimeline(ctx, filters, sp),
  }));
  const groups = groupAgentRows(agents);
  const bars = tokenBars(groups);
  const depth = depthBars(agents);
  const perTurn = spawnsPerTurn(agents.totalSpawns, kpis.turns);
  const subTokens = agents.rows.reduce((s, r) => s + r.tokens.total, 0);
  const ignored = [...new Set([...agents.ignoredFilters, ...kpis.ignoredFilters, ...timeline.ignoredFilters])];
  const groupOrder = groups.map((g) => g.group);
  const graph = timelineGraph(timeline, groupOrder);
  const { hiddenLanes, ...flow } = flowGraph(timeline, groupOrder);
  const nav = timelineNav('/agents', sp, timeline);
  const cut = timeline.truncated.turns || timeline.truncated.runs;
  const timelineCard = (
    <Card
      title="Agent timeline"
      description="One lane per session (harness and first turn's start), coloured by project. Turns are the trunk; each sub-agent branches off where it starts and merges back where it ends. Workflow agents often keep running after their turn has ended (dashed trunk). Times are UTC."
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
  const flowCard = (
    <Card
      title="Agent flow"
      description="How sub-agents hand work to each other. One lane per workflow run and one per turn for the agents it spawned directly; rows inside a workflow lane are its stages in launch order. Each pill is an agent from start to end, coloured by agent group. A solid arrow links the stages of one item (impl:x → verify:x); a dashed arrow links an agent to the sibling that finished before it started. Hover an agent to follow its chain. Same window and zoom as the timeline above; times are UTC."
    >
      <div className="space-y-3">
        {(hiddenLanes > 0 || timeline.truncated.links) && (
          <p className="text-xs text-amber-700 dark:text-amber-400" role="note">
            {hiddenLanes > 0 && `+${formatInt(hiddenLanes)} more lane${hiddenLanes === 1 ? '' : 's'} not drawn (the first ${FLOW_MAX_LANES} by start are shown). `}
            {timeline.truncated.links && 'This window has more than 10,000 links; only the earliest are drawn. '}
            Zoom in on the timeline or narrow the filters to see all of them.
          </p>
        )}
        <AgentFlow {...flow} ariaLabel={`Agent flow: ${formatInt(flow.nodes.length)} sub-agent runs in ${formatInt(flow.lanes.length)} lanes, ${formatInt(flow.edges.length)} links`} />
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
          {flowCard}
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
          {flowCard}
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
          <Card title="Agent groups" description="One row per group; expand a group to see its agent types.">
            <AgentGroupsTable key={JSON.stringify(filters)} rows={groups} exportHref={exportUrl('agents', filters)} />
          </Card>
        </div>
      )}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Success rate counts runs with a known outcome; the unknown share is shown separately.
      </p>
    </div>
  );
}
