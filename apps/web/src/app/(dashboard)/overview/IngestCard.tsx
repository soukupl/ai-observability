import { Card } from '@/components/Card';
import { formatDateTime, formatInt } from '@/components/format';
import type { IngestSummary } from './helpers';

function Stat({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div title={title} className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </div>
  );
}

/**
 * Ingest card (docs/briefs/dashboard-followups-2026-10-10.md): what the collectors delivered, company-wide. `summary`
 * is null when `agg_ingest_stats()` is not available (migration 0015 not applied yet).
 */
export function IngestCard({ summary }: { summary: IngestSummary | null }) {
  return (
    <Card title="Ingest" description="Events received from collectors, company-wide (not filtered); the ledger keeps 30 days.">
      {summary === null ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Ingest stats unavailable.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat
            label="Last event"
            value={summary.ago}
            sub={summary.lastMs === null ? 'no event in the last 30 days' : formatDateTime(summary.lastMs)}
            title={summary.lastMs === null ? undefined : `Last event received ${formatDateTime(summary.lastMs)}`}
          />
          <Stat
            label="Events last 24 h"
            value={formatInt(summary.total24h)}
            sub={summary.byType24h.length > 0 ? summary.byType24h.map((t) => `${formatInt(t.count)} ${t.label}`).join(' · ') : 'nothing received'}
          />
          <Stat label="Events last 7 days" value={formatInt(summary.total7d)} sub="turns, runs, patches and sessions" />
        </div>
      )}
    </Card>
  );
}
