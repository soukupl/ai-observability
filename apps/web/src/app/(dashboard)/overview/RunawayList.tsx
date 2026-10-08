import Link from 'next/link';
import { Card } from '@/components/Card';
import { formatCost, formatDateTime, formatDuration, formatTokens } from '@/components/format';
import { formatModel } from '@/lib/model-name';
import type { RunawayRow } from '@/lib/queries/runaways';

const REASON: Record<string, string> = {
  tokens: 'far more tokens than usual',
  cost: '≈ cost over the threshold',
  duration: 'long, with above-normal tokens',
};

/** Recent runaway turns (docs/briefs/runaway-alerts.md): notify only, nothing was stopped. */
export function RunawayList({ rows }: { rows: RunawayRow[] }) {
  return (
    <Card
      title="Runaway turns"
      description="Turns that used far more than usual, flagged after they ended. Thresholds: Admin → Settings."
    >
      <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {rows.map((r) => (
          <li key={r.turnId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
            <Link href={`/turns/${r.turnId}?startedMs=${r.startedMs}`} className="font-medium text-blue-700 hover:underline dark:text-blue-400">
              {formatDateTime(r.startedMs)}
            </Link>
            <span className="text-zinc-700 dark:text-zinc-300">
              {[r.projectName, r.teamName && `team ${r.teamName}`, r.model && formatModel(r.model)].filter(Boolean).join(' · ')}
              {r.isMine && ' · yours'}
            </span>
            <span className="tabular-nums text-zinc-900 dark:text-zinc-100">
              {formatTokens(r.tokens)} tokens · {formatCost(r.costUsd)} · {formatDuration(r.durationMs)}
            </span>
            <span className="text-xs text-red-700 dark:text-red-400">{r.reasons.map((x) => REASON[x] ?? x).join('; ')}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
