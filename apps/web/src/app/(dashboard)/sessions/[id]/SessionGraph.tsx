'use client';

import { useState } from 'react';
import { AgentGraph, type AgentGraphProps } from '@/components/charts/AgentGraph';
import { liveGraph } from '../_helpers';
import { useLiveSession } from './LiveSession';

/**
 * The session's agent graph with drag-to-zoom kept in the page (the whole session is loaded, so zooming only narrows
 * the axis); "Whole session" restores it. While the session is live (ADR-0027) the axis reaches the server's "now" of
 * the last poll and a now-line marks it.
 */
export function SessionGraph({ graph }: { graph: Omit<AgentGraphProps, 'onZoom'> }) {
  const [zoom, setZoom] = useState<{ fromMs: number; toMs: number } | null>(null);
  const live = useLiveSession();
  const nowMs = live?.data.nowMs;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span>Drag on the time axis to zoom.</span>
        {zoom && (
          <button
            type="button"
            onClick={() => setZoom(null)}
            className="inline-flex h-7 items-center rounded-md border border-zinc-300 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Whole session
          </button>
        )}
      </div>
      <AgentGraph {...liveGraph(graph, nowMs)} {...(zoom ?? {})} onZoom={(fromMs, toMs) => setZoom({ fromMs, toMs })} />
    </div>
  );
}
