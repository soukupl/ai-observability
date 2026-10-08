import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OutcomeBadge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { AgentFlow } from '@/components/charts/AgentFlow';
import { StackedBar100 } from '@/components/charts/StackedBar100';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { requireUser } from '@/lib/auth/session';
import { getFlowDetail } from '@/lib/queries/flows';
import { withDashboardContext } from '@/lib/queries/page';
import { usesAggregateFunctions } from '@/lib/queries/scope';
import { parseStartedMs } from '../../../turns/_helpers';
import { flowChart, flowChartDescription, flowFacts, parseFlowKey, stageBar, STEP_LABEL_WIDTH, stepPhaseBars, toStepRows, usesSummary } from '../../_helpers';

export const metadata = { title: 'Agent flow' };

type Props = { params: Promise<{ turnId: string; key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

function Fact({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-zinc-900 dark:text-zinc-100">{children}</dd>
    </div>
  );
}

const stepColumns: Column[] = [
  { key: 'n', header: '#', kind: 'int', align: 'left' },
  { key: 'stage', header: 'Stage', kind: 'text' },
  { key: 'label', header: 'Step', kind: 'text' },
  { key: 'group', header: 'Group', kind: 'text' },
  { key: 'model', header: 'Model', kind: 'model' },
  { key: 'effort', header: 'Effort', kind: 'text' },
  { key: 'startedMs', header: 'Start (UTC)', kind: 'datetime' },
  { key: 'offsetMs', header: '+ Offset', kind: 'duration', hint: 'Time from the flow start' },
  { key: 'durationMs', header: 'Duration', kind: 'duration' },
  { key: 'tokens', header: 'Tokens', kind: 'tokens' },
  { key: 'cost', header: '≈ Cost', kind: 'cost', hint: "≈ at the run's model price on that day; n/a when the model has no price" },
  { key: 'skills', header: 'Skills', kind: 'text', sortable: false },
  { key: 'mcp', header: 'MCP calls', kind: 'text', sortable: false, hint: 'server/tool ×calls' },
  { key: 'outcome', header: 'Outcome', kind: 'outcome' },
];

export default async function FlowDetailPage({ params, searchParams }: Props) {
  const user = await requireUser();
  const [{ turnId, key: rawKey }, sp] = await Promise.all([params, searchParams]);
  const key = parseFlowKey(rawKey);
  if (!key) notFound();
  const flow = await withDashboardContext(user, (ctx) => getFlowDetail(ctx, turnId, key, parseStartedMs(sp.startedMs)));
  if (!flow) notFound();

  const limited = usesAggregateFunctions(user) && !flow.turn.isMine;
  const facts = flowFacts(flow);
  const chart = flowChart(flow);
  const steps = toStepRows(flow);
  const uses = usesSummary(flow);
  const stages = stageBar(flow);
  const phases = stepPhaseBars(flow);

  return (
    <>
      <PageHeader
        title="Agent flow"
        description={flow.name}
        actions={
          <Link href="/flows" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-400">
            All agent flows
          </Link>
        }
      />
      {limited && (
        <p role="note" className="mb-3 text-xs text-amber-700 dark:text-amber-400">
          Aggregates-only mode: this flow belongs to someone else&apos;s turn, so it is shown without who ran it and its turn opens in limited form.
        </p>
      )}
      <div className="space-y-4">
        <Card title="Facts">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {facts.map((f) => (
              <Fact key={f.label} label={f.label} title={f.title}>
                {f.kind === 'outcome' ? (
                  <OutcomeBadge outcome={f.value} />
                ) : f.href ? (
                  <Link href={f.href} className="font-medium text-blue-700 hover:underline dark:text-blue-400">
                    {f.value}
                  </Link>
                ) : (
                  f.value
                )}
              </Fact>
            ))}
          </dl>
        </Card>

        <Card title="Flow" description={flowChartDescription(flow)}>
          <AgentFlow
            {...chart}
            ariaLabel={`Agent flow: ${chart.nodes.length} step${chart.nodes.length === 1 ? '' : 's'} in ${flow.stages.length} stage${flow.stages.length === 1 ? '' : 's'}, ${chart.edges.length} link${chart.edges.length === 1 ? '' : 's'}`}
          />
        </Card>

        <Card title="Steps" description="One row per sub-agent run, in stage and start order. Offset is the time from the flow's first start.">
          <DataTable columns={stepColumns} rows={steps} rowKey="id" caption="Steps of the flow" emptyMessage="No steps." />
        </Card>

        {(uses.skills || uses.mcp.length > 0) && (
          <Card title="Skills & MCP" description="Skills used and MCP calls made by the flow's steps, summed.">
            <dl className="space-y-2 text-sm">
              {uses.skills && (
                <div>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">Skills</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">{uses.skills}</dd>
                </div>
              )}
              {uses.mcp.map((m) => (
                <div key={m.server}>
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400" title={m.server}>
                    MCP {m.label}
                  </dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">{m.calls}</dd>
                </div>
              ))}
            </dl>
          </Card>
        )}

        {stages && (
          <Card title="Time by stage" description="Summed step durations per stage (parallel steps all count), coloured as in the Flow card.">
            <StackedBar100 rows={[{ label: 'this flow', values: stages.values }]} keys={stages.keys} colorIndex={stages.colorIndex} valueFormat="duration" labelWidth={70} ariaLabel="Time split of the flow by stage" />
          </Card>
        )}

        {phases && (
          <Card title="Phases per step" description="Where each step's time went (# is the step's row in the Steps table).">
            <StackedBar100 rows={phases.rows} keys={phases.keys} valueFormat="duration" labelWidth={STEP_LABEL_WIDTH} ariaLabel="Phase split of each step" />
          </Card>
        )}
      </div>
    </>
  );
}
