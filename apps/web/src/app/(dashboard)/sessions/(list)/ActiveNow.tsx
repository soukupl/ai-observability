'use client';

import { Card } from '@/components/Card';
import { DataTable, type Column } from '@/components/DataTable';
import { HALT_MESSAGE, useLivePoll, useTick } from '@/components/live-poll';
import { liveElapsedMs, type ActiveSessionsPayload } from '@/lib/live/status';
import { toActiveNowRows } from '../_helpers';

/**
 * "Active now" (ADR-0027): the viewer's running sessions at the top of /sessions, polled every 10 s while the tab is
 * visible, with the elapsed time ticking locally between polls. Not narrowed by the page filters.
 */
export function ActiveNow({ initial, showUser }: { initial: ActiveSessionsPayload; showUser: boolean }) {
  const { data, receivedAtMs, failing, halted } = useLivePoll('/api/live/sessions', initial);
  const tick = useTick(data.rows.length > 0 && halted === null);
  const rows = toActiveNowRows(data.rows, (r) => (tick === null ? r.elapsedMs : liveElapsedMs(r.sinceMs, data.nowMs, receivedAtMs, tick)));
  const columns: Column[] = [
    { key: 'title', header: 'Session', kind: 'text', hrefKey: 'href' },
    { key: 'state', header: 'Status', kind: 'text', hint: 'working = a turn is in progress; idle = waiting for the next prompt' },
    { key: 'elapsedMs', header: 'For', kind: 'duration', hint: 'Working: since the prompt was submitted. Idle: since the last turn ended (or the session started)' },
    ...(showUser ? [{ key: 'user', header: 'User', kind: 'text' as const }] : []),
    { key: 'project', header: 'Project', kind: 'text' },
    { key: 'harness', header: 'Harness', kind: 'text' },
    { key: 'turns', header: 'Turns', kind: 'int' },
    { key: 'runs', header: 'Sub-agents', kind: 'int' },
    { key: 'tokens', header: 'Tokens', kind: 'tokens' },
    { key: 'cost', header: '≈ Cost', kind: 'cost', hint: '≈ at API list prices; n/a when the model has no price' },
    { key: 'lastOutcome', header: 'Last outcome', kind: 'outcome' },
  ];
  const description = `Sessions running right now: working = a turn is in progress, idle = waiting for the next prompt (up to 30 minutes). Refreshes every 10 s while this tab is visible; not narrowed by the filters below.${
    data.ownOnly ? ' Aggregates-only mode: only your own sessions.' : ''
  }`;

  return (
    <Card title="Active now" description={description} className="mb-4">
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No sessions running.</p>
      ) : (
        <DataTable columns={columns} rows={rows} rowKey="id" caption="Sessions running now" />
      )}
      {data.truncated && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Showing the 100 most recent.</p>}
      {halted && (
        <p role="note" className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          {HALT_MESSAGE[halted]}
        </p>
      )}
      {!halted && failing && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Couldn&apos;t refresh; retrying.</p>}
    </Card>
  );
}
