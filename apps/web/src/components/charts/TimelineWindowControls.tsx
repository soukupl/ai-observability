'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { formatDay } from '../format';
import { AgentGraph, type AgentGraphProps } from './AgentGraph';
import { minutesToClock, TIMELINE_WINDOW_PARAMS, zoomWindow, type TimelineParamNames } from './agent-graph-layout';

export { TIMELINE_WINDOW_PARAMS, type TimelineParamNames } from './agent-graph-layout';

const linkCls =
  'inline-flex h-8 items-center rounded-md border border-zinc-300 bg-white px-2.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800';
const disabledCls =
  'inline-flex h-8 cursor-not-allowed items-center rounded-md border border-zinc-200 px-2.5 text-sm text-zinc-400 dark:border-zinc-800 dark:text-zinc-600';

function NavLink({ href, children, label }: { href: string | null; children: string; label: string }) {
  if (!href)
    return (
      <span className={disabledCls} aria-disabled="true" title={label}>
        {children}
      </span>
    );
  return (
    <Link href={href} className={linkCls} title={label} scroll={false}>
      {children}
    </Link>
  );
}

/**
 * Prev / next day, "Whole day" and the current window of the agent timeline. Links are built by the page (they keep
 * the filters); null disables prev / next, and hides "Whole day" when the whole day is already shown.
 */
export function TimelineWindowControls({
  day,
  fromMin,
  toMin,
  prevHref,
  nextHref,
  wholeDayHref,
}: {
  day: string;
  /** 0..1439 */
  fromMin: number;
  /** 1..1440, exclusive */
  toMin: number;
  prevHref: string | null;
  nextHref: string | null;
  wholeDayHref: string | null;
}) {
  const whole = fromMin <= 0 && toMin >= 1440;
  const year = day.slice(0, 4);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <NavLink href={prevHref} label="Previous day with turns">
        ← Prev
      </NavLink>
      <div className="px-1 text-sm text-zinc-700 dark:text-zinc-300">
        <span className="font-semibold">
          {formatDay(day)}, {year}
        </span>{' '}
        <span className="text-zinc-500 dark:text-zinc-400">
          {whole ? 'whole day' : `${minutesToClock(fromMin)}–${minutesToClock(toMin)}`} UTC
        </span>
      </div>
      <NavLink href={nextHref} label="Next day with turns">
        Next →
      </NavLink>
      {!whole && wholeDayHref && (
        <Link href={wholeDayHref} className={linkCls} scroll={false}>
          Whole day
        </Link>
      )}
      <span className="text-xs text-zinc-500 dark:text-zinc-400">Drag on the time axis to zoom.</span>
    </div>
  );
}

/**
 * AgentGraph whose drag-to-zoom rewrites the URL: `fromH` / `toH` become the selected HH:MM (UTC, within `day`), every
 * other search param is kept, and the server page re-renders the narrower window.
 */
export function AgentGraphWithZoom({
  graph,
  day,
  paramNames = TIMELINE_WINDOW_PARAMS,
}: {
  graph: Omit<AgentGraphProps, 'onZoom'>;
  day: string;
  paramNames?: TimelineParamNames;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const current = useSearchParams();
  const [, start] = useTransition();

  function onZoom(fromMs: number, toMs: number) {
    const w = zoomWindow(fromMs, toMs, day);
    if (!w) return;
    const params = new URLSearchParams(current.toString());
    params.set('day', day);
    params.set(paramNames.from, w.from);
    params.set(paramNames.to, w.to);
    start(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
  }

  return <AgentGraph {...graph} onZoom={onZoom} />;
}
