import { describe, expect, it } from 'vitest';
import { IDLE_MAX_MS, liveElapsedMs, POLL_MS, sessionStatus, TICK_MS, WORKING_MAX_MS, type ActiveSession, type LiveSignals } from '../../src/lib/live/status';
import { liveGraph, toActiveNowRows } from '../../src/app/(dashboard)/sessions/_helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-10-05T18:00:00Z');

const sig = (over: Partial<LiveSignals> = {}): LiveSignals => ({
  startedMs: NOW - HOUR,
  lastSeenMs: NOW - HOUR,
  currentTurnStartedMs: null,
  lastTurnEndedMs: null,
  endedMs: null,
  ...over,
});

describe('sessionStatus (ADR-0027)', () => {
  it('the thresholds are the agreed literals (mirrored by packages/collector LIVE_IDLE_STALE_MS / LIVE_WORKING_STALE_MS)', () => {
    expect(IDLE_MAX_MS).toBe(1_800_000);
    expect(WORKING_MAX_MS).toBe(7_200_000);
    expect(POLL_MS).toBe(10_000);
    expect(TICK_MS).toBe(1_000);
  });

  it('ended wins over everything, since the end', () => {
    expect(sessionStatus(sig({ endedMs: NOW - 5 * MIN, currentTurnStartedMs: NOW - MIN }), NOW)).toEqual({ state: 'ended', sinceMs: NOW - 5 * MIN, elapsedMs: 5 * MIN });
  });

  it('working with no previous turn, since the prompt', () => {
    expect(sessionStatus(sig({ currentTurnStartedMs: NOW - 4 * MIN }), NOW)).toEqual({ state: 'working', sinceMs: NOW - 4 * MIN, elapsedMs: 4 * MIN });
  });

  it('working after an earlier turn', () => {
    expect(sessionStatus(sig({ currentTurnStartedMs: NOW - 4 * MIN, lastTurnEndedMs: NOW - 15 * MIN }), NOW)).toMatchObject({ state: 'working', sinceMs: NOW - 4 * MIN });
  });

  it('a turn that ended at or after the prompt makes it idle, since that turn end', () => {
    expect(sessionStatus(sig({ currentTurnStartedMs: NOW - 4 * MIN, lastTurnEndedMs: NOW - 4 * MIN }), NOW)).toEqual({ state: 'idle', sinceMs: NOW - 4 * MIN, elapsedMs: 4 * MIN });
    expect(sessionStatus(sig({ currentTurnStartedMs: NOW - 4 * MIN, lastTurnEndedMs: NOW - 2 * MIN }), NOW)).toMatchObject({ state: 'idle', sinceMs: NOW - 2 * MIN });
  });

  it('working for exactly 2 h is still working; 1 ms more is stale (same since)', () => {
    const c = NOW - WORKING_MAX_MS;
    expect(sessionStatus(sig({ currentTurnStartedMs: c, lastSeenMs: c }), NOW)).toEqual({ state: 'working', sinceMs: c, elapsedMs: WORKING_MAX_MS });
    expect(sessionStatus(sig({ currentTurnStartedMs: c - 1, lastSeenMs: c - 1 }), NOW)).toEqual({ state: 'stale', sinceMs: c - 1, elapsedMs: WORKING_MAX_MS + 1 });
  });

  it('a working session is never staled by the 30-minute rule (no heartbeat)', () => {
    expect(sessionStatus(sig({ currentTurnStartedMs: NOW - 90 * MIN, lastSeenMs: NOW - 90 * MIN }), NOW).state).toBe('working');
  });

  it('no turns, started 2 minutes ago: idle since the start', () => {
    expect(sessionStatus(sig({ startedMs: NOW - 2 * MIN, lastSeenMs: NOW - 2 * MIN }), NOW)).toEqual({ state: 'idle', sinceMs: NOW - 2 * MIN, elapsedMs: 2 * MIN });
  });

  it('idle at 30 min − 1 ms; stale at exactly 30 min, since the last signal', () => {
    const idle = sig({ startedMs: NOW - HOUR, lastTurnEndedMs: NOW - IDLE_MAX_MS + 1, lastSeenMs: NOW - IDLE_MAX_MS + 1 });
    expect(sessionStatus(idle, NOW)).toEqual({ state: 'idle', sinceMs: NOW - IDLE_MAX_MS + 1, elapsedMs: IDLE_MAX_MS - 1 });
    const stale = sig({ startedMs: NOW - HOUR, lastTurnEndedMs: NOW - IDLE_MAX_MS, lastSeenMs: NOW - IDLE_MAX_MS });
    expect(sessionStatus(stale, NOW)).toEqual({ state: 'stale', sinceMs: NOW - IDLE_MAX_MS, elapsedMs: IDLE_MAX_MS });
  });

  it('a recent signal keeps a session idle whose Stop is 45 minutes old (since stays the Stop)', () => {
    expect(sessionStatus(sig({ lastTurnEndedMs: NOW - 45 * MIN, lastSeenMs: NOW - 5 * MIN }), NOW)).toEqual({ state: 'idle', sinceMs: NOW - 45 * MIN, elapsedMs: 45 * MIN });
  });

  it('a prompt time in the future (clock skew) is working with elapsed 0', () => {
    expect(sessionStatus(sig({ currentTurnStartedMs: NOW + 5_000, lastSeenMs: NOW }), NOW)).toEqual({ state: 'working', sinceMs: NOW + 5_000, elapsedMs: 0 });
  });
});

describe('liveElapsedMs', () => {
  it('ticks on the client clock from the payload time', () => {
    const since = NOW - 4 * MIN;
    const received = 1_000_000; // client clock when the payload arrived
    expect(liveElapsedMs(since, NOW, received, received)).toBe(4 * MIN);
    expect(liveElapsedMs(since, NOW, received, received + 7_000)).toBe(4 * MIN + 7_000);
  });

  it('ignores the offset between client and server clocks', () => {
    const since = NOW - MIN;
    expect(liveElapsedMs(since, NOW, NOW + HOUR, NOW + HOUR + 2_000)).toBe(MIN + 2_000);
    expect(liveElapsedMs(since, NOW, NOW - HOUR, NOW - HOUR + 2_000)).toBe(MIN + 2_000);
  });

  it('is clamped at 0', () => {
    expect(liveElapsedMs(NOW + 10_000, NOW, 5, 5)).toBe(0);
  });
});

describe('liveGraph', () => {
  const g = { lanes: [], turns: [], runs: [], fromMs: NOW - HOUR, toMs: NOW - 10 * MIN, projectLegend: [], ariaLabel: 'x' };

  it('not live: the graph unchanged', () => {
    expect(liveGraph(g, undefined)).toBe(g);
  });

  it('live: the axis reaches past now by 2% of the span and the now-line is set', () => {
    const out = liveGraph(g, NOW);
    expect(out.nowMs).toBe(NOW);
    expect(out.fromMs).toBe(g.fromMs);
    expect(out.toMs).toBe(NOW + Math.round(HOUR * 0.02));
  });

  it('keeps a later axis end, and pads at least a second', () => {
    const later = { ...g, toMs: NOW + HOUR };
    expect(liveGraph(later, NOW).toMs).toBe(NOW + HOUR);
    const short = { ...g, fromMs: NOW - 10_000, toMs: NOW - 5_000 };
    expect(liveGraph(short, NOW).toMs).toBe(NOW + 1_000);
  });
});

describe('toActiveNowRows', () => {
  const cost = { usd: 0.5, partial: false, unknownModels: [] };
  const base: ActiveSession = {
    id: 's1', title: 'Fix login', harness: 'claude-code', projectId: 'p1', projectName: 'alpha', state: 'working', sinceMs: NOW - MIN,
    elapsedMs: MIN, turns: 2, runs: 3, tokens: 2200, cost, lastOutcome: 'success', isMine: true,
  };

  it('links each row and uses the given elapsed time', () => {
    expect(toActiveNowRows([base], (r) => r.elapsedMs + 5_000)).toEqual([
      { id: 's1', href: '/sessions/s1', title: 'Fix login', state: 'working', elapsedMs: MIN + 5_000, user: null, project: 'alpha', harness: 'claude-code', turns: 2, runs: 3, tokens: 2200, cost, lastOutcome: 'success' },
    ]);
  });

  it('names a former member and an unknown project; no project is null', () => {
    const [a, b] = toActiveNowRows(
      [
        { ...base, userId: 'u1', userName: null, projectName: null },
        { ...base, id: 's2', userId: 'u2', userName: 'Ada', projectId: null, projectName: null, lastOutcome: null },
      ],
      (r) => r.elapsedMs,
    );
    expect([a!.user, a!.project]).toEqual(['former member', 'unknown project']);
    expect([b!.user, b!.project, b!.lastOutcome]).toEqual(['Ada', null, null]);
  });
});
