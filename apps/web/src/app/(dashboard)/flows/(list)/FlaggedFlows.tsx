import Link from 'next/link';
import { Card } from '@/components/Card';
import { formatDateTime } from '@/components/format';
import type { FlaggedFlowRow } from '@/lib/queries/flow-flags';
import { flaggedFlowHref, turnHref } from '../_helpers';
import { UnflagButton } from './UnflagButton';

/**
 * "Flagged for later" card at the top of /flows (ADR-0024): the viewer's own flags, newest first, regardless of the
 * date range and filters (that is what "later" means). A flag whose turn is no longer visible still shows and can be
 * removed; its links are omitted.
 */
export function FlaggedFlows({ rows, companyId }: { rows: FlaggedFlowRow[]; companyId: string }) {
  if (rows.length === 0) return null;
  return (
    <Card title="Flagged for later" description="Flows you flagged on their detail page. Only you see your flags; the date range and filters do not apply here.">
      <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
            {r.turn ? (
              <Link href={flaggedFlowHref({ turnId: r.turnId, key: r.key, turn: r.turn })} className="font-medium text-blue-700 hover:underline dark:text-blue-400">
                {r.flowName}
              </Link>
            ) : (
              <span className="font-medium text-zinc-500 dark:text-zinc-400" title="The turn of this flow is no longer visible to you.">
                {r.flowName}
              </span>
            )}
            {r.turn && (
              <span className="text-zinc-700 dark:text-zinc-300">
                {[r.turn.projectName, formatDateTime(r.turn.startedMs)].filter(Boolean).join(' · ')}
                {' · '}
                <Link href={turnHref({ id: r.turnId, startedMs: r.turn.startedMs })} className="text-blue-700 hover:underline dark:text-blue-400">
                  {r.turn.summary ?? 'turn'}
                </Link>
              </span>
            )}
            {r.note && <span className="text-zinc-600 italic dark:text-zinc-400">“{r.note}”</span>}
            <span className="text-xs text-zinc-500 dark:text-zinc-400">flagged {formatDateTime(r.flaggedAtMs)}</span>
            <UnflagButton companyId={companyId} id={r.id} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
