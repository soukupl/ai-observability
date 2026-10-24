'use client';

import { useEffect, useRef, useState } from 'react';
import { POLL_MS, TICK_MS } from '../lib/live/status';

/**
 * Client polling of the live JSON routes (ADR-0027): a setTimeout chain, one interval apart, paused while the tab is
 * hidden. A 401 / 403 / 404 halts polling for good (the page has to be reloaded); any other failure keeps the
 * last data, sets `failing` and retries at the next interval.
 */

export type PollHalt = 'unauthorized' | 'forbidden' | 'not_found';

export const HALT_MESSAGE: Record<PollHalt, string> = {
  unauthorized: 'Signed out. Reload the page to sign in again.',
  not_found: 'This session is no longer visible.',
  forbidden: 'Not available.',
};

const HALT_BY_STATUS: Record<number, PollHalt> = { 401: 'unauthorized', 403: 'forbidden', 404: 'not_found' };

export function useLivePoll<T extends { nowMs: number }>(
  url: string,
  initial: T,
  opts: { enabled?: boolean; intervalMs?: number } = {},
): { data: T; receivedAtMs: number; failing: boolean; halted: PollHalt | null } {
  const enabled = opts.enabled ?? true;
  const intervalMs = opts.intervalMs ?? POLL_MS;
  const [data, setData] = useState<T>(initial);
  // The server's own time until the client clock is known (the first effect): render output never depends on it.
  const [receivedAtMs, setReceivedAtMs] = useState<number>(initial.nowMs);
  const [failing, setFailing] = useState(false);
  const [halted, setHalted] = useState<PollHalt | null>(null);
  const lastFetchRef = useRef(0);

  // A fresh server payload (first render, or router.refresh()) replaces whatever the polls brought.
  useEffect(() => {
    setData(initial);
    setReceivedAtMs(Date.now());
    lastFetchRef.current = Date.now();
  }, [initial]);

  useEffect(() => {
    if (!enabled || halted) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let stopped = false;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(tick, Math.max(0, ms));
    };

    async function poll() {
      inflight = true;
      lastFetchRef.current = Date.now();
      try {
        const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' }, signal: ctrl.signal });
        if (stopped) return;
        const halt = HALT_BY_STATUS[res.status];
        if (halt) {
          stopped = true;
          setHalted(halt);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as T;
        if (stopped) return;
        setData(body);
        setReceivedAtMs(Date.now());
        setFailing(false);
      } catch {
        if (stopped) return;
        setFailing(true);
      } finally {
        inflight = false;
      }
      if (!stopped && document.visibilityState !== 'hidden') schedule(intervalMs);
    }

    function tick() {
      // Hidden: no fetch and no new timer; becoming visible restarts the chain.
      if (document.visibilityState === 'hidden' || inflight || stopped) return;
      void poll();
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden' || inflight || stopped) return;
      const age = Date.now() - lastFetchRef.current;
      if (age >= intervalMs) {
        clearTimeout(timer);
        void poll();
      } else schedule(intervalMs - age);
    }

    // The first fetch comes one interval after the last payload (mount or the previous chain).
    schedule(intervalMs - (Date.now() - lastFetchRef.current));
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [url, enabled, intervalMs, halted]);

  return { data, receivedAtMs, failing, halted };
}

/** The client clock, updated every `ms` while `enabled`; null until mounted (server render and hydration). */
export function useTick(enabled: boolean, ms: number = TICK_MS): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [enabled, ms]);
  return now;
}
