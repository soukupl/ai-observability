import Link from 'next/link';
import { OutcomeBadge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { formatCost, formatDateTime, formatDuration, formatInt, formatTokens } from '@/components/format';
import { COMPLEX_MIN_DURATION_MS, COMPLEX_MIN_STEPS, COMPLEX_REASON_TEXT, type ComplexFlowRow } from './helpers';

/**
 * Long or complex agent flows of the range (docs/briefs/dashboard-followups-2026-10-10.md), the flow counterpart of
 * "Runaway turns": nothing was stopped, the card only points at the flows worth a look.
 */
export function ComplexFlows({ rows, allHref, truncated }: { rows: ComplexFlowRow[]; allHref: string; truncated: boolean }) {
  return (
    <Card
      title="Long or complex agent flows"
      description={`Multi-step sub-agent flows of this range with ${COMPLEX_MIN_STEPS} or more steps, over ${Math.round(COMPLEX_MIN_DURATION_MS / 60_000)} minutes or over 1M tokens, longest first.`}
      actions={
        <Link href={allHref} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
          All agent flows
        </Link>
      }
    >
      {truncated && (
        <p role="note" className="mb-2 text-xs text-amber-700 dark:text-amber-400">
          Too many sub-agent runs in this range: only the first 20,000 were read, so some flows may be missing.
        </p>
      )}
      <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
            <Link href={r.href} className="font-medium text-blue-700 hover:underline dark:text-blue-400">
              {formatDateTime(r.startedMs)}
            </Link>
            <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300" title={r.name}>
              {r.projectName} · {r.name}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {r.kind} · {formatInt(r.steps)} step{r.steps === 1 ? '' : 's'}
              {r.stages > 0 ? ` · ${formatInt(r.stages)} stage${r.stages === 1 ? '' : 's'}` : ''}
            </span>
            <span className="tabular-nums text-zinc-900 dark:text-zinc-100">
              {formatDuration(r.durationMs)} · {formatTokens(r.tokens)} tokens · {formatCost(r.cost)}
            </span>
            <OutcomeBadge outcome={r.outcome} />
            <span className="text-xs text-amber-700 dark:text-amber-400">{r.reasons.map((x) => COMPLEX_REASON_TEXT[x]).join('; ')}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
