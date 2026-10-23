import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, OutcomeBadge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { formatCost, formatDateTime, formatDuration, formatInt, formatTokens, formatUsageName } from '@/components/format';
import { KpiTile } from '@/components/KpiTile';
import { ModelName } from '@/components/ModelName';
import { PageHeader } from '@/components/PageHeader';
import { requireUser } from '@/lib/auth/session';
import { withDashboardContext } from '@/lib/queries/page';
import { getSessionDetail, resumeCommand, toLiveSessionPayload } from '@/lib/queries/sessions';
import { FLOW_KIND_LABEL, flowHref, turnHref } from '../../flows/_helpers';
import { Fact } from '../../turns/[id]/Fact';
import { outcomeMix, sessionFlowsHref, sessionGraph, sessionTurnsHref } from '../_helpers';
import { CopyText } from './CopyText';
import { CurrentTurnCard, LiveSessionProvider } from './LiveSession';
import { SessionGraph } from './SessionGraph';

export const metadata = { title: 'Session' };

type Props = { params: Promise<{ id: string }> };

const linkCls = 'text-sm font-medium text-blue-700 hover:underline dark:text-blue-400';

/**
 * One harness session (ADR-0026): what it is (title, project, ids to resume it), its totals, the agent graph over the
 * whole session, then its turns in order, each with the flows and workflows it launched, and the skills & MCP used.
 * While the session is not ended the page is live (ADR-0027): a "Now" card, a now-line, and a refresh when it changes.
 */
export default async function SessionDetailPage({ params }: Props) {
  const user = await requireUser();
  const { id } = await params;
  const { detail, nowMs } = await withDashboardContext(user, async (ctx) => ({ detail: await getSessionDetail(ctx, id), nowMs: ctx.now.getTime() }));
  if (!detail) notFound();
  const { session: s, turns, flows, workflows } = detail;
  const live = toLiveSessionPayload(s, nowMs);
  const isLive = live.status.state !== 'ended';
  const resume = resumeCommand(s.harness, s.harnessSessionId);
  const flowsByTurn = new Map<string, typeof flows>();
  for (const f of flows) flowsByTurn.set(f.turnId, [...(flowsByTurn.get(f.turnId) ?? []), f]);
  const workflowsByTurn = new Map<string, typeof workflows>();
  for (const w of workflows) workflowsByTurn.set(w.turnId, [...(workflowsByTurn.get(w.turnId) ?? []), w]);
  const skills = Object.entries(detail.skills).sort((a, b) => b[1].model + b[1].user - (a[1].model + a[1].user));
  const mcp = Object.entries(detail.mcp).map(([server, t]) => [server, Object.entries(t).sort((a, b) => b[1] - a[1])] as const);

  const content = (
    <div className="space-y-4">
      {isLive && <CurrentTurnCard />}
      <Card title="Session">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Project">{s.projectName ?? (s.projectId ? 'unknown project' : '—')}</Fact>
          <Fact label="Harness">{s.harness}</Fact>
          {s.userName !== undefined && <Fact label="User">{s.userName ?? (s.userId ? 'former member' : '—')}</Fact>}
          <Fact label="Started (UTC)">{formatDateTime(s.startedMs)}</Fact>
          <Fact label="Ended" title="When the harness reported the session end; open = no end yet and active in the last 30 minutes">
            <span className="inline-flex flex-wrap items-center gap-1">
              {s.endedMs !== null ? `${formatDateTime(s.endedMs)}${s.endReason ? ` (${s.endReason})` : ''}` : s.open ? <Badge tone="warn">open</Badge> : 'no end reported'}
            </span>
          </Fact>
          <Fact label="Last activity (UTC)">{formatDateTime(s.lastActivityMs)}</Fact>
        </dl>
        <dl className="mt-3 space-y-2">
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Session id</dt>
            <dd className="mt-0.5">
              <CopyText text={s.harnessSessionId} label="Copy the session id" />
            </dd>
          </div>
          {resume && (
            <div>
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Resume it</dt>
              <dd className="mt-0.5">
                <CopyText text={resume} label="Copy the resume command" />
              </dd>
            </div>
          )}
        </dl>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Turns" value={formatInt(s.turns)} sub={outcomeMix(s.outcomes)} />
        <KpiTile label="Sub-agent runs" value={formatInt(s.runs)} sub={`${formatInt(s.workflows)} workflow${s.workflows === 1 ? '' : 's'} · ${formatInt(s.flows)} flow${s.flows === 1 ? '' : 's'}`} />
        <KpiTile label="Tokens" value={formatTokens(s.tokens.total)} sub={formatCost(s.cost)} title="≈ cost at API list prices" />
        <KpiTile label="Span" value={formatDuration(s.spanMs)} sub="first activity to last" title="Workflow agents that outlive their turn count" />
      </div>

      <Card title="Timeline" description="Turns as the trunk, sub-agents as branches, over the whole session. Click a turn to open it, a sub-agent to open its flow (or its turn). Times are UTC.">
        <SessionGraph graph={sessionGraph(detail)} />
      </Card>

      <Card title="Turns" description="In order. Each turn lists the agent flows and workflows it launched.">
        {turns.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{isLive ? 'No finished turn yet.' : 'No turns left in this session.'}</p>
        ) : (
          <ol className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {turns.map((t, i) => {
              const tf = flowsByTurn.get(t.id) ?? [];
              const tw = (workflowsByTurn.get(t.id) ?? []).filter((w) => !w.flow);
              return (
                <li key={t.id} className="py-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-zinc-400">{i + 1}</span>
                    <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{formatDateTime(t.startedMs)}</span>
                    <Link href={turnHref(t)} className="min-w-0 flex-1 font-medium text-blue-700 hover:underline dark:text-blue-400">
                      {t.summary ?? 'turn (no summary yet)'}
                    </Link>
                    <OutcomeBadge outcome={t.outcome} />
                    <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                      {formatDuration(t.durationMs)} · {formatTokens(t.tokens.total)} · {formatCost(t.cost)} · {formatInt(t.runs)} sub-agent{t.runs === 1 ? '' : 's'} ·{' '}
                      <ModelName id={t.model} />
                    </span>
                  </div>
                  {(tf.length > 0 || tw.length > 0) && (
                    <ul className="mt-1 ml-9 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                      {tf.map((f) => (
                        <li key={f.key}>
                          <Link href={flowHref(f)} className="font-medium text-blue-700 hover:underline dark:text-blue-400">
                            {f.name}
                          </Link>{' '}
                          — {FLOW_KIND_LABEL[f.kind]}, {f.steps.length} steps, {formatDuration(f.durationMs)}, {formatTokens(f.tokens.total)} <OutcomeBadge outcome={f.outcome} />
                        </li>
                      ))}
                      {tw.map((w) => (
                        <li key={w.orchestrationId} title={w.orchestrationId}>
                          workflow {w.orchestrationId.slice(0, 16)} — {w.steps} agent{w.steps === 1 ? '' : 's'}, {formatDuration(w.endedMs - w.startedMs)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <Card title="Skills & MCP" description="Skills used and MCP calls made in the session, sub-agents included.">
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">Skills</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">
              {skills.length > 0
                ? skills.map(([name, c]) => `${formatUsageName(name)}${c.user > 0 ? ` (typed ×${c.user})` : ''}${c.model > 0 ? ` (by the model ×${c.model})` : ''}`).join(', ')
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
        </dl>
      </Card>
    </div>
  );

  return (
    <>
      <PageHeader
        title={s.title}
        description={`Session, ${formatDateTime(s.startedMs)}`}
        actions={
          <>
            <Link href="/sessions" className={linkCls}>
              All sessions
            </Link>
            <Link href={sessionTurnsHref(s.id)} className={linkCls}>
              Its turns
            </Link>
            {flows.length > 0 && (
              <Link href={sessionFlowsHref(s.id)} className={linkCls}>
                Its agent flows
              </Link>
            )}
          </>
        }
      />
      {detail.retentionCut && (
        <p role="note" className="mb-3 text-xs text-amber-700 dark:text-amber-400">
          This session started before the raw retention window: its oldest turns may have been deleted, so the figures cover only the turns still kept.
        </p>
      )}
      {detail.truncated && (
        <p role="note" className="mb-3 text-xs text-amber-700 dark:text-amber-400">
          This session has more than 20,000 sub-agent runs; only the oldest were read, so some runs and flows are missing.
        </p>
      )}
      {isLive ? (
        <LiveSessionProvider sessionId={s.id} companyId={user.companyId} initial={live}>
          {content}
        </LiveSessionProvider>
      ) : (
        content
      )}
    </>
  );
}
