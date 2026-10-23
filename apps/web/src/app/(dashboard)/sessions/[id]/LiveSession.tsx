'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Badge } from '@/components/Badge';
import { Card } from '@/components/Card';
import { formatCost, formatDateTime, formatDuration, formatInt, formatTokens } from '@/components/format';
import { HALT_MESSAGE, useLivePoll, useTick, type PollHalt } from '@/components/live-poll';
import { liveElapsedMs, type LiveSessionPayload } from '@/lib/live/status';
import { Fact } from '../../turns/[id]/Fact';

/**
 * Live mode of the session page (ADR-0027): while the session is not ended, the page polls its live payload every 10 s
 * (tab visible), re-renders on the server when anything shown changed (`rev`), and ticks the elapsed time locally.
 */

interface LiveSessionValue {
  data: LiveSessionPayload;
  receivedAtMs: number;
  failing: boolean;
  halted: PollHalt | null;
}

const LiveSessionContext = createContext<LiveSessionValue | null>(null);

export function LiveSessionProvider({ sessionId, companyId, initial, children }: { sessionId: string; companyId: string; initial: LiveSessionPayload; children: ReactNode }) {
  const router = useRouter();
  const { data, receivedAtMs, failing, halted } = useLivePoll(`/api/live/sessions/${sessionId}?company=${encodeURIComponent(companyId)}`, initial, {
    enabled: initial.status.state !== 'ended',
  });
  useEffect(() => {
    if (data.rev !== initial.rev) router.refresh();
    // Only a new poll result triggers a refresh (not a new `initial`); useLivePoll then adopts the refreshed payload.
  }, [data.rev]);
  // The 1 s tick lives in CurrentTurnCard, not here: a new context value every second would re-render the graph too.
  const value = useMemo(() => ({ data, receivedAtMs, failing, halted }), [data, receivedAtMs, failing, halted]);
  return <LiveSessionContext.Provider value={value}>{children}</LiveSessionContext.Provider>;
}

/** The live state of the page's session; null outside a LiveSessionProvider (an ended session). */
export function useLiveSession(): LiveSessionValue | null {
  return useContext(LiveSessionContext);
}

const STATE_TONE = { working: 'info', idle: 'neutral', stale: 'warn', ended: 'neutral' } as const;

/** "Now": status, ticking elapsed time, the current turn and the totals so far. */
export function CurrentTurnCard() {
  const live = useLiveSession();
  const tick = useTick(live !== null && live.halted === null && live.data.status.state !== 'ended');
  if (!live) return null;
  const { data, receivedAtMs, failing, halted } = live;
  const { status } = data;
  const elapsed = tick === null ? status.elapsedMs : liveElapsedMs(status.sinceMs, data.nowMs, receivedAtMs, tick);
  const turn =
    status.state === 'working'
      ? `Turn ${data.turns + 1} started ${formatDateTime(data.currentTurnStartedMs ?? status.sinceMs)}`
      : status.state === 'idle'
        ? 'waiting for the next prompt'
        : status.state === 'stale'
          ? 'no signal: the harness may have closed without an end event'
          : 'session ended';
  return (
    <Card title="Now" description="Live: refreshes every 10 s while this tab is visible. Tokens of a running turn arrive when it ends.">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Status">
          <Badge tone={STATE_TONE[status.state]}>{status.state}</Badge>
        </Fact>
        <Fact label="Elapsed">
          <span className="tabular-nums">{formatDuration(elapsed)}</span>
        </Fact>
        <Fact label="Turn">{turn}</Fact>
        <Fact label="So far">{`${formatInt(data.turns)} turns · ${formatTokens(data.tokens)} · ${formatCost(data.cost)}`}</Fact>
      </dl>
      {halted && (
        <p role="note" className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          {HALT_MESSAGE[halted]}
        </p>
      )}
      {!halted && failing && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Couldn&apos;t refresh; retrying.</p>}
    </Card>
  );
}
