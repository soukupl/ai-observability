import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AttributionBadge, Badge, OutcomeBadge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { StackedBar100 } from '@/components/charts/StackedBar100';
import { AgentFlow } from '@/components/charts/AgentFlow';
import { AgentGraph } from '@/components/charts/AgentGraph';
import { formatCost, formatDateTime, formatDuration, formatInt, formatTokens, formatUsageName } from '@/components/format';
import { ModelName } from '@/components/ModelName';
import { PageHeader } from '@/components/PageHeader';
import { RunTree } from '@/components/RunTree';
import { requireUser } from '@/lib/auth/session';
import { withDashboardContext } from '@/lib/queries/page';
import { getTurnDetail } from '@/lib/queries/turns';
import { parseStartedMs, phaseRow, toRunTree, turnFlow, turnGraph } from '../_helpers';

export const metadata = { title: 'Turn' };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-zinc-900 dark:text-zinc-100">{children}</dd>
    </div>
  );
}

function FlowCard({ detail }: { detail: Parameters<typeof turnFlow>[0] }) {
  const { hiddenLanes, ...flow } = turnFlow(detail);
  return (
    <div className="space-y-3">
      {hiddenLanes > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" role="note">
          +{hiddenLanes} more lane{hiddenLanes === 1 ? '' : 's'} not drawn; the earliest are shown.
        </p>
      )}
      <AgentFlow
        {...flow}
        ariaLabel={`Turn flow: ${flow.nodes.length} sub-agent run${flow.nodes.length === 1 ? '' : 's'} in ${flow.lanes.length} lane${flow.lanes.length === 1 ? '' : 's'}, ${flow.edges.length} link${flow.edges.length === 1 ? '' : 's'}`}
      />
    </div>
  );
}

export default async function TurnDetailPage({ params, searchParams }: Props) {
  const user = await requireUser();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const detail = await withDashboardContext(user, (ctx) => getTurnDetail(ctx, id, parseStartedMs(sp.startedMs)));
  if (!detail) notFound();
  const { turn, runs, usage, limited } = detail;
  const phases = phaseRow(turn.phasesMs);
  const signals = turn.outcomeSignals ?? [];
  const tools = Object.entries(turn.tools ?? {}).sort((a, b) => b[1] - a[1]);
  const skills = Object.entries(turn.skills ?? {}).sort((a, b) => b[1].model + b[1].user - (a[1].model + a[1].user));
  const mcp = Object.entries(turn.mcp ?? {}).map(([server, t]) => [server, Object.entries(t).sort((a, b) => b[1] - a[1])] as const);
  const tk = turn.tokens;

  return (
    <>
      <PageHeader
        title="Turn detail"
        description={formatDateTime(turn.startedMs)}
        actions={
          <Link href="/turns" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-400">
            All turns
          </Link>
        }
      />
      {limited && (
        <p role="note" className="mb-3 text-xs text-amber-700 dark:text-amber-400">
          Aggregates-only mode: this is someone else&apos;s turn, so phases, tools and outcome signals are not shown.
        </p>
      )}
      <div className="space-y-4">
        <Card title="Facts">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Fact label="Outcome">
              <span className="inline-flex flex-wrap items-center gap-1">
                <OutcomeBadge outcome={turn.outcome} />
                {turn.outcomeProvisional && <Badge tone="warn" title="Outcome may still change when the next prompt arrives">provisional</Badge>}
              </span>
            </Fact>
            {turn.userName !== undefined && <Fact label="User">{turn.userName ?? (turn.userId ? 'unknown user' : '—')}</Fact>}
            {turn.attribution && !limited && (
              <Fact label="Attribution">
                <AttributionBadge attribution={turn.attribution} />
              </Fact>
            )}
            <Fact label="Team">{turn.teamName ?? '—'}</Fact>
            <Fact label="Project">{turn.projectName ?? '—'}</Fact>
            <Fact label="Harness">{turn.harness}</Fact>
            <Fact label="Model"><ModelName id={turn.model} /></Fact>
            <Fact label="Effort">{turn.effort ?? '—'}</Fact>
            <Fact label="Duration">{formatDuration(turn.durationMs)}</Fact>
            <Fact label="≈ Cost (API list prices)">{formatCost(turn.cost)}</Fact>
            {turn.filesTouched !== null && <Fact label="Files touched">{formatInt(turn.filesTouched)}</Fact>}
            {turn.linesAdded !== null && (
              <Fact label="Lines">
                +{formatInt(turn.linesAdded)} / −{formatInt(turn.linesRemoved)}
              </Fact>
            )}
          </dl>
          {turn.summary && <p className="mt-3 border-t border-zinc-100 pt-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">{turn.summary}</p>}
        </Card>

        <Card title="Tokens" description="Input excludes cache reads and writes; thinking tokens are part of output.">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Fact label="Total">{formatTokens(tk.total)}</Fact>
            <Fact label="Input">{formatTokens(tk.input)}</Fact>
            <Fact label="Output">{formatTokens(tk.output)}</Fact>
            <Fact label="Cache read">{formatTokens(tk.cacheRead)}</Fact>
            <Fact label="Cache write">{formatTokens(tk.cacheWrite)}</Fact>
            <Fact label="Thinking (in output)">{formatTokens(tk.reasoning)}</Fact>
          </dl>
          {usage && usage.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Usage by model</caption>
                <thead>
                  <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    <th className="px-2 py-2 text-left font-medium">Model</th>
                    <th className="px-2 py-2 text-left font-medium">Effort</th>
                    <th className="px-2 py-2 text-right font-medium">Tokens</th>
                    <th className="px-2 py-2 text-right font-medium">≈ Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((u) => (
                    <tr key={`${u.model}|${u.effort}`} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                      <td className="px-2 py-2"><ModelName id={u.model} /></td>
                      <td className="px-2 py-2">{u.effort ?? '—'}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatTokens(u.tokens.total)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatCost(u.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {!limited && (
          <Card title="Phases" description="Where the turn's time went.">
            {phases ? (
              <StackedBar100 rows={[{ label: 'this turn', values: phases.values }]} keys={phases.keys} valueFormat="duration" labelWidth={70} ariaLabel="Phase split of the turn" />
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No phase data for this turn.</p>
            )}
            {tools.length > 0 && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Tools: {tools.map(([k, v]) => `${k} ×${v}`).join(', ')}</p>
            )}
          </Card>
        )}

        {!limited && (skills.length > 0 || mcp.length > 0) && (
          <Card title="Skills & MCP" description="Skills used and MCP calls made in this turn, sub-agents included.">
            <dl className="space-y-2 text-sm">
              {skills.length > 0 && (
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">Skills</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">
                    {skills
                      .map(([name, c]) => `${formatUsageName(name)}${c.user > 0 ? ` (typed ×${c.user})` : ''}${c.model > 0 ? ` (by the model ×${c.model})` : ''}`)
                      .join(', ')}
                  </dd>
                </div>
              )}
              {mcp.map(([server, calls]) => (
                <div key={server}>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400" title={server}>
                    MCP {formatUsageName(server)}
                  </dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">{calls.map(([tool, n]) => `${formatUsageName(tool)} ×${n}`).join(', ')}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}

        {!limited && (
          <Card title="Outcome signals" description="Why the outcome was classified this way.">
            {signals.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {signals.map((s) => (
                  <li key={s}>
                    <Badge>{s}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No signals recorded (outcome {turn.outcome}).</p>
            )}
          </Card>
        )}

        <Card
          title="Timeline"
          description="The turn is the trunk; each sub-agent branches off where it starts and merges back where it ends. Workflow agents can keep running after the turn has ended (dashed trunk). Times are UTC."
        >
          <AgentGraph {...turnGraph(detail)} />
        </Card>

        {runs.length > 0 && (
          <Card
            title="Flow"
            description="How this turn's sub-agents hand work to each other: one lane per workflow run (rows are its stages in launch order) and one for the agents the main agent spawned. A solid arrow links the stages of one item; a dashed arrow links an agent to the sibling that finished before it started. Hover an agent to follow its chain. Times are UTC."
          >
            <FlowCard detail={detail} />
          </Card>
        )}

        <Card title="Runs" description="Parent to child.">
          <RunTree root={toRunTree(detail)} />
          {runs.length === 0 && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">No sub-agent runs in this turn.</p>}
        </Card>
      </div>
    </>
  );
}
