import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AttributionBadge, Badge, OutcomeBadge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { StackedBar100 } from '@/components/charts/StackedBar100';
import { AgentGraph } from '@/components/charts/AgentGraph';
import { formatCost, formatDateTime, formatDuration, formatInt, formatTokens, formatUsageName } from '@/components/format';
import { ModelName } from '@/components/ModelName';
import { PageHeader } from '@/components/PageHeader';
import { RunTree } from '@/components/RunTree';
import { requireUser } from '@/lib/auth/session';
import { getFlowFlags } from '@/lib/queries/flow-flags';
import { turnFlows } from '@/lib/queries/flows';
import { withDashboardContext } from '@/lib/queries/page';
import { getTurnDetail } from '@/lib/queries/turns';
import { flowAnchor, turnUsesSummary } from '../../flows/_helpers';
import { parseStartedMs, phaseRow, toRunTree, turnGraph } from '../_helpers';
import { Fact } from './Fact';
import { FlowSection } from './FlowSection';

export const metadata = { title: 'Turn' };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * The single detail page of a turn and its agent flows (ADR-0025): the turn's facts, tokens, phases, skills & MCP,
 * outcome signals and timeline, then one FlowSection per flow of the turn (`#flow-<key>`), then the run tree.
 */
export default async function TurnDetailPage({ params, searchParams }: Props) {
  const user = await requireUser();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const { detail, flows, flags } = await withDashboardContext(user, async (ctx) => {
    const detail = await getTurnDetail(ctx, id, parseStartedMs(sp.startedMs));
    if (!detail) return { detail, flows: [], flags: new Map() };
    const flows = turnFlows(detail, ctx.prices);
    return { detail, flows, flags: flows.length > 0 ? await getFlowFlags(ctx, detail.turn.id) : new Map() };
  });
  if (!detail) notFound();
  const { turn, runs, usage, limited } = detail;
  const phases = phaseRow(turn.phasesMs);
  const signals = turn.outcomeSignals ?? [];
  const tools = Object.entries(turn.tools ?? {}).sort((a, b) => b[1] - a[1]);
  const skills = Object.entries(turn.skills ?? {}).sort((a, b) => b[1].model + b[1].user - (a[1].model + a[1].user));
  const mcp = Object.entries(turn.mcp ?? {}).map(([server, t]) => [server, Object.entries(t).sort((a, b) => b[1] - a[1])] as const);
  const own = turnUsesSummary({ skills: turn.ownSkills, mcp: turn.ownMcp });
  const ownLine = [own.skills && `skills: ${own.skills}`, ...own.mcp.map((m) => `MCP ${m.label}: ${m.calls}`)].filter(Boolean).join(' · ');
  const tk = turn.tokens;

  return (
    <>
      <PageHeader
        title="Turn detail"
        description={formatDateTime(turn.startedMs)}
        actions={
          <>
            <Link href="/turns" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-400">
              All turns
            </Link>
            {flows.length > 0 && (
              <Link href="/flows" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-400">
                All agent flows
              </Link>
            )}
          </>
        }
      />
      {limited && (
        <p role="note" className="mb-3 text-xs text-amber-700 dark:text-amber-400">
          Aggregates-only mode: this is someone else&apos;s turn, so phases, tools, outcome signals and who ran it are not shown.
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
            {turn.userName !== undefined && <Fact label="User">{turn.userName ?? (turn.userId ? 'former member' : '—')}</Fact>}
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
            <Fact label="Sub-agent runs">{formatInt(runs.length)}</Fact>
            <Fact label="Agent flows" title="Sets of two or more sub-agent runs that belong together; each has a section below">
              {flows.length === 0 ? (
                'none'
              ) : (
                <span className="flex flex-col gap-0.5">
                  {flows.map((f) => (
                    <a key={f.key} href={`#${flowAnchor(f.key)}`} className="font-medium text-blue-700 hover:underline dark:text-blue-400">
                      {f.name}
                    </a>
                  ))}
                </span>
              )}
            </Fact>
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

        <Card title="Skills & MCP" description="Skills used and MCP calls made in this turn, sub-agents included; the last line is the main agent alone. Each flow section lists its steps' uses.">
          <dl className="space-y-2 text-sm">
            {limited ? (
              <div>
                <dt className="text-xs text-zinc-500 dark:text-zinc-400">Turn</dt>
                <dd className="text-zinc-900 dark:text-zinc-100">not available in limited form</dd>
              </div>
            ) : (
              <>
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">Skills</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">
                    {skills.length > 0
                      ? skills
                          .map(([name, c]) => `${formatUsageName(name)}${c.user > 0 ? ` (typed ×${c.user})` : ''}${c.model > 0 ? ` (by the model ×${c.model})` : ''}`)
                          .join(', ')
                      : 'none recorded'}
                  </dd>
                </div>
                {mcp.length > 0 ? (
                  mcp.map(([server, calls]) => (
                    <div key={server}>
                      <dt className="text-xs text-zinc-500 dark:text-zinc-400" title={server}>
                        MCP {formatUsageName(server)}
                      </dt>
                      <dd className="text-zinc-900 dark:text-zinc-100">{calls.map(([tool, n]) => `${formatUsageName(tool)} ×${n}`).join(', ')}</dd>
                    </div>
                  ))
                ) : (
                  <div>
                    <dt className="text-xs text-zinc-500 dark:text-zinc-400">MCP calls</dt>
                    <dd className="text-zinc-900 dark:text-zinc-100">none recorded</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400" title="The turn row alone: what the main agent used, without its sub-agents">
                    Main agent alone
                  </dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">{!own.available ? 'not available in limited form' : ownLine || 'none recorded'}</dd>
                </div>
              </>
            )}
          </dl>
        </Card>

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

        {flows.map((f, i) => (
          <FlowSection key={f.key} flow={f} flag={flags.get(f.key) ?? null} companyId={user.companyId} index={i} count={flows.length} />
        ))}

        <Card title="Runs" description="Parent to child.">
          <RunTree root={toRunTree(detail)} />
          {runs.length === 0 && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">No sub-agent runs in this turn.</p>}
        </Card>
      </div>
    </>
  );
}
