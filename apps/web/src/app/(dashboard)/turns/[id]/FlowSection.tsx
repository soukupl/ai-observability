import Link from 'next/link';
import { OutcomeBadge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { AgentFlow } from '@/components/charts/AgentFlow';
import { StackedBar100 } from '@/components/charts/StackedBar100';
import { DataTable, type Column } from '@/components/DataTable';
import type { FlowFlag } from '@/lib/queries/flow-flags';
import type { Flow } from '@/lib/queries/flows';
import { flowAnchor, flowChart, flowChartDescription, flowSectionFacts, formatClockDate, reportHref, stageBar, STEP_LABEL_WIDTH, stepPhaseBars, toStepRows, usesSummary } from '../../flows/_helpers';
import { FlagButton } from '../../flows/FlagButton';
import { Fact } from './Fact';

/**
 * One agent flow of the turn, as a section of the turn page (ADR-0025: the turn page is the single detail page of a
 * turn and its flows; the former `/flows/<turnId>/<key>` page redirects to `#flow-<key>`). Facts the turn's own card
 * already shows (project, harness, the turn) are left out; the main agent's skills and MCP calls sit in the turn's
 * Skills & MCP card.
 */

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

export function FlowSection({ flow, flag, companyId, index, count }: { flow: Flow; flag: FlowFlag | null; companyId: string; index: number; count: number }) {
  const facts = flowSectionFacts(flow);
  const chart = flowChart(flow);
  const steps = toStepRows(flow);
  const uses = usesSummary(flow);
  const stages = stageBar(flow);
  const phases = stepPhaseBars(flow);
  const ordinal = count > 1 ? ` ${index + 1} of ${count}` : '';

  return (
    <section id={flowAnchor(flow.key)} aria-label={`Agent flow${ordinal}: ${flow.name}`} className="scroll-mt-4 space-y-4 rounded-xl border border-dashed border-zinc-300 p-3 dark:border-zinc-700">
      <Card
        title={`Agent flow${ordinal}: ${flow.name}`}
        description={flag ? <>Flagged for later on {formatClockDate(flag.createdAtMs)}{flag.note && <> · “{flag.note}”</>}</> : undefined}
        actions={
          <>
            <Link href="/flows" className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-400">
              All agent flows
            </Link>
            <a
              href={reportHref(flow)}
              target="_blank"
              rel="noopener"
              className="inline-flex h-9 items-center rounded-md border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              title="Opens a print-ready report of this flow in a new tab; use your browser's Save as PDF"
            >
              Download PDF
            </a>
            <FlagButton companyId={companyId} turnId={flow.turnId} flowKey={flow.key} startedMs={flow.turn.startedMs} flag={flag} />
          </>
        }
      >
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
          <Fact label="Skills (steps)">{uses.skills ?? 'none recorded'}</Fact>
          {uses.mcp.length > 0 ? (
            uses.mcp.map((m) => (
              <Fact key={m.server} label={`MCP ${m.label} (steps)`} title={m.server}>
                {m.calls}
              </Fact>
            ))
          ) : (
            <Fact label="MCP calls (steps)">none recorded</Fact>
          )}
        </dl>
      </Card>

      <Card title="Flow" description={flowChartDescription(flow)}>
        <AgentFlow
          {...chart}
          ariaLabel={`Agent flow: ${chart.nodes.length} step${chart.nodes.length === 1 ? '' : 's'} in ${flow.stages.length} stage${flow.stages.length === 1 ? '' : 's'}, ${chart.edges.length} link${chart.edges.length === 1 ? '' : 's'}`}
        />
      </Card>

      <Card title="Steps" description="One row per sub-agent run, in stage and start order. Offset is the time from the flow's first start.">
        <DataTable columns={stepColumns} rows={steps} rowKey="id" caption={`Steps of the flow ${flow.name}`} emptyMessage="No steps." />
      </Card>

      {stages && (
        <Card title="Time by stage" description="Summed step durations per stage (parallel steps all count), coloured as in the Flow card.">
          <StackedBar100 rows={[{ label: 'this flow', values: stages.values }]} keys={stages.keys} colorIndex={stages.colorIndex} valueFormat="duration" labelWidth={70} ariaLabel={`Time split of the flow ${flow.name} by stage`} />
        </Card>
      )}

      {phases && (
        <Card title="Phases per step" description="Where each step's time went (# is the step's row in the Steps table).">
          <StackedBar100 rows={phases.rows} keys={phases.keys} valueFormat="duration" labelWidth={STEP_LABEL_WIDTH} ariaLabel={`Phase split of each step of the flow ${flow.name}`} />
        </Card>
      )}
    </section>
  );
}
