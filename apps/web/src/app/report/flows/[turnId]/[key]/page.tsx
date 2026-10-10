import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { OutcomeBadge } from '@/components/Badge';
import { AgentFlow } from '@/components/charts/AgentFlow';
import { formatCost, formatDuration, formatInt, formatTokens } from '@/components/format';
import { appUrl } from '@/lib/auth/config';
import { requireUser } from '@/lib/auth/session';
import { modelLabels } from '@/lib/model-name';
import { getFlowDetail, type Flow } from '@/lib/queries/flows';
import { withDashboardContext } from '@/lib/queries/page';
import { usesAggregateFunctions } from '@/lib/queries/scope';
import { PrintButton } from '../../../PrintButton';
import { parseStartedMs } from '../../../../(dashboard)/turns/_helpers';
import {
  barSegments,
  flowChart,
  flowFacts,
  flowHref,
  formatClockDate,
  parseFlowKey,
  projectLabel,
  stageBar,
  stepPhaseBars,
  toStepRows,
  turnUsesSummary,
  usesSummary,
  type BarSegment,
} from '../../../../(dashboard)/flows/_helpers';

export const metadata = { title: 'Agent flow report' };

type Props = { params: Promise<{ turnId: string; key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** A section of the report; never split across pages (globals.css `.report-card`). */
function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="report-card rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
      {description && <p className="mt-0.5 mb-3 text-xs text-zinc-500">{description}</p>}
      {!description && <div className="mb-3" />}
      {children}
    </section>
  );
}

/** One 100 % bar: coloured segments with their share; a legend line underneath. */
function Bar({ label, segments, format, labelWidth = 170 }: { label: string; segments: BarSegment[]; format: (v: number) => string; labelWidth?: number }) {
  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="shrink-0 truncate text-zinc-700" style={{ width: labelWidth }} title={label}>
        {label}
      </div>
      <div className="flex h-5 min-w-0 flex-1 overflow-hidden rounded bg-zinc-100" role="img" aria-label={segments.map((s) => `${s.key} ${Math.round(s.share * 100)}%`).join(', ')}>
        {segments.map((s) => (
          <div key={s.key} style={{ width: `${s.share * 100}%`, background: s.color }} title={`${s.key}: ${format(s.value)} (${Math.round(s.share * 100)}%)`} />
        ))}
      </div>
    </div>
  );
}

function Legend({ segments }: { segments: BarSegment[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
      {segments.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
          {s.key}
        </li>
      ))}
    </ul>
  );
}

const th = 'px-2 py-1.5 text-left text-xs font-medium text-zinc-500';
const td = 'px-2 py-1.5 align-top text-xs text-zinc-900';
const num = `${td} text-right tabular-nums whitespace-nowrap`;

export default async function FlowReportPage({ params, searchParams }: Props) {
  const user = await requireUser();
  const [{ turnId, key: rawKey }, sp] = await Promise.all([params, searchParams]);
  const key = parseFlowKey(rawKey);
  if (!key) notFound();
  const flow: Flow | null = await withDashboardContext(user, (ctx) => getFlowDetail(ctx, turnId, key, parseStartedMs(sp.startedMs)));
  if (!flow) notFound();

  const limited = usesAggregateFunctions(user) && !flow.turn.isMine;
  const facts = flowFacts(flow);
  const chart = flowChart(flow);
  const steps = toStepRows(flow);
  const names = modelLabels(steps.map((s) => s.model).filter((m): m is string => m !== null));
  const uses = usesSummary(flow);
  const turnUses = turnUsesSummary(flow.turn);
  const stages = stageBar(flow);
  const phases = stepPhaseBars(flow);
  const stageSegments = stages ? barSegments(stages.values, stages.keys, stages.colorIndex) : null;
  const phaseLegend = phases ? barSegments(Object.fromEntries(phases.keys.map((k) => [k, 1])), phases.keys) : null;
  const generatedAt = formatClockDate(Date.now());
  const detailUrl = new URL(flowHref(flow), appUrl()).toString();
  const autoPrint = first(sp.print) === '1';

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Agent flow report</p>
          <h1 className="mt-0.5 text-xl font-semibold break-words text-zinc-900">{flow.name}</h1>
          <p className="mt-1 text-sm text-zinc-600">
            {projectLabel(flow.turn)} · {flow.turn.harness} · started {formatClockDate(flow.startedMs)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Generated {generatedAt} · <a href={detailUrl}>{detailUrl}</a>
          </p>
        </div>
        <PrintButton autoPrint={autoPrint} />
      </header>
      {limited && (
        <p role="note" className="text-xs text-amber-700">
          Aggregates-only mode: this flow belongs to someone else&apos;s turn, so it is shown without who ran it and without phases or the turn&apos;s own skills.
        </p>
      )}

      <Section title="Facts">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
          {facts.map((f) => (
            <div key={f.label} className="min-w-0" title={f.title}>
              <dt className="text-xs text-zinc-500">{f.label}</dt>
              <dd className="mt-0.5 break-words text-sm text-zinc-900">{f.kind === 'outcome' ? <OutcomeBadge outcome={f.value} /> : f.value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Flow" description="The flow's steps in time: one row per stage, pills are agents from start to end coloured by agent group; arrows are hand-overs between steps. Times are UTC.">
        <div style={{ width: 960, maxWidth: '100%' }}>
          <AgentFlow
            {...chart}
            ariaLabel={`Agent flow: ${chart.nodes.length} step${chart.nodes.length === 1 ? '' : 's'} in ${flow.stages.length} stage${flow.stages.length === 1 ? '' : 's'}, ${chart.edges.length} link${chart.edges.length === 1 ? '' : 's'}`}
          />
        </div>
      </Section>

      <Section title="Steps" description="One row per sub-agent run, in stage and start order. Offset is the time from the flow's first start; ≈ cost at the run's model price on that day.">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-zinc-200">
                <th className={th}>#</th>
                <th className={th}>Stage</th>
                <th className={th}>Step</th>
                <th className={th}>Group</th>
                <th className={th}>Model</th>
                <th className={th}>Effort</th>
                <th className={th}>Start (UTC)</th>
                <th className={`${th} text-right`}>+ Offset</th>
                <th className={`${th} text-right`}>Duration</th>
                <th className={`${th} text-right`}>Tokens</th>
                <th className={`${th} text-right`}>≈ Cost</th>
                <th className={th}>Skills</th>
                <th className={th}>MCP calls</th>
                <th className={th}>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => (
                <tr key={s.id} className="border-b border-zinc-100">
                  <td className={num}>{s.n}</td>
                  <td className={td}>{s.stage ?? '—'}</td>
                  <td className={`${td} break-words`}>{s.label}</td>
                  <td className={td}>{s.group}</td>
                  <td className={td} title={s.model ?? undefined}>
                    {s.model ? (names[s.model] ?? s.model) : '—'}
                  </td>
                  <td className={td}>{s.effort ?? '—'}</td>
                  <td className={`${td} whitespace-nowrap`}>{formatClockDate(s.startedMs).replace(' UTC', '')}</td>
                  <td className={num}>+{formatDuration(s.offsetMs)}</td>
                  <td className={num}>{formatDuration(s.durationMs)}</td>
                  <td className={num}>{formatTokens(s.tokens)}</td>
                  <td className={num}>{formatCost(s.cost)}</td>
                  <td className={td}>{s.skills ?? '—'}</td>
                  <td className={td}>{s.mcp ?? '—'}</td>
                  <td className={td}>
                    <OutcomeBadge outcome={s.outcome} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Skills & MCP" description="Skills used and MCP calls made by the flow's steps (summed), and by the turn's main agent that launched the flow.">
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-xs text-zinc-500">Skills (steps)</dt>
            <dd className="text-zinc-900">{uses.skills ?? 'none recorded'}</dd>
          </div>
          {uses.mcp.length > 0 ? (
            uses.mcp.map((m) => (
              <div key={m.server}>
                <dt className="text-xs text-zinc-500" title={m.server}>
                  MCP {m.label} (steps)
                </dt>
                <dd className="text-zinc-900">{m.calls}</dd>
              </div>
            ))
          ) : (
            <div>
              <dt className="text-xs text-zinc-500">MCP calls (steps)</dt>
              <dd className="text-zinc-900">none recorded</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-zinc-500">Turn (main agent)</dt>
            <dd className="text-zinc-900">
              {!turnUses.available
                ? 'not available in limited form'
                : [turnUses.skills && `skills: ${turnUses.skills}`, ...turnUses.mcp.map((m) => `MCP ${m.label}: ${m.calls}`)].filter(Boolean).join(' · ') || 'none recorded'}
            </dd>
          </div>
        </dl>
      </Section>

      {stages && stageSegments && (
        <Section title="Time by stage" description="Summed step durations per stage (parallel steps all count).">
          <Bar label="this flow" segments={stageSegments} format={formatDuration} labelWidth={70} />
          <Legend segments={stageSegments} />
          <p className="mt-2 text-xs text-zinc-600">{stageSegments.map((s) => `${s.key} ${formatDuration(s.value)} (${Math.round(s.share * 100)}%)`).join(' · ')}</p>
        </Section>
      )}

      {phases && phaseLegend && (
        <Section title="Phases per step" description="Where each step's time went (# is the step's row in the Steps table).">
          <div className="space-y-1.5">
            {phases.rows.map((r) => (
              <Bar key={r.label} label={r.label} segments={barSegments(r.values, phases.keys)} format={formatDuration} />
            ))}
          </div>
          <Legend segments={phaseLegend} />
        </Section>
      )}

      <footer className="text-xs text-zinc-500">
        ai-obs · {formatInt(flow.steps.length)} step{flow.steps.length === 1 ? '' : 's'} · {formatTokens(flow.tokens.total)} tokens · {formatCost(flow.cost)} ≈ at API list prices · generated {generatedAt}
      </footer>
    </div>
  );
}
