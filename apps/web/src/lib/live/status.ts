import type { Outcome } from '@ai-obs/db';
import type { CostValue } from '../cost';
import type { Outcomes } from '../queries/sqlutil';

/**
 * Live session status (ADR-0027): working / idle / stale / ended from a session's liveness columns and `now`. Pure and
 * type-imports only, so client components (the "Active now" strip, the session page) can import it.
 *
 * - working: a turn started (`current_turn_started_at`) and its `turn` has not arrived yet. There is no in-turn
 *   heartbeat, so a working session is only staled after WORKING_MAX_MS.
 * - idle: waiting for the next prompt; stale after IDLE_MAX_MS without any signal.
 *
 * The thresholds are mirrored by the collector (`packages/collector`, LIVE_IDLE_STALE_MS / LIVE_WORKING_STALE_MS);
 * a test on each side asserts the literal values.
 */

/** Idle → stale after this long without a signal (30 min). */
export const IDLE_MAX_MS = 1_800_000;
/** Working → stale after this long without the turn's end (2 h). */
export const WORKING_MAX_MS = 7_200_000;
/** The dashboard polls the live routes this often while the tab is visible. */
export const POLL_MS = 10_000;
/** The elapsed timers tick this often between polls. */
export const TICK_MS = 1_000;

export type LiveState = 'working' | 'idle' | 'stale' | 'ended';

/** The inputs of sessionStatus, all epoch ms. */
export interface LiveSignals {
  /** First activity (session start or first turn). */
  startedMs: number;
  /** The latest signal of the session: max(last activity, `last_seen_at`). */
  lastSeenMs: number;
  /** `current_turn_started_at`; non-null = a turn started and may still be running. */
  currentTurnStartedMs: number | null;
  /** End of the session's last finished turn; null when it has none. */
  lastTurnEndedMs: number | null;
  /** `ended_at` (session_end); null while the session is open. */
  endedMs: number | null;
}

export interface LiveStatus {
  state: LiveState;
  /** When the current state began (working: turn start; idle: last turn end or session start; stale: last signal). */
  sinceMs: number;
  /** now − sinceMs, never negative. */
  elapsedMs: number;
}

/** The session's live status at `nowMs` (rules of ADR-0027, applied in order). */
export function sessionStatus(s: LiveSignals, nowMs: number): LiveStatus {
  const out = (state: LiveState, sinceMs: number): LiveStatus => ({ state, sinceMs, elapsedMs: Math.max(0, nowMs - sinceMs) });
  if (s.endedMs !== null) return out('ended', s.endedMs);
  const c = s.currentTurnStartedMs;
  if (c !== null && (s.lastTurnEndedMs === null || c > s.lastTurnEndedMs)) return out(nowMs - c > WORKING_MAX_MS ? 'stale' : 'working', c);
  const lastSignal = Math.max(s.lastSeenMs, s.startedMs, s.lastTurnEndedMs ?? -Infinity);
  if (nowMs - lastSignal >= IDLE_MAX_MS) return out('stale', lastSignal);
  return out('idle', s.lastTurnEndedMs ?? s.startedMs);
}

/**
 * Elapsed time ticking on the client clock between polls: the server's `nowMs` plus the client time passed since the
 * payload arrived, so a skewed client clock does not shift the timer.
 */
export function liveElapsedMs(sinceMs: number, payloadNowMs: number, receivedAtMs: number, clientNowMs: number): number {
  return Math.max(0, payloadNowMs + (clientNowMs - receivedAtMs) - sinceMs);
}

/** One row of the "Active now" strip (`GET /api/live/sessions`). */
export interface ActiveSession {
  id: string;
  title: string;
  harness: string;
  projectId: string | null;
  projectName: string | null;
  state: 'working' | 'idle';
  sinceMs: number;
  elapsedMs: number;
  turns: number;
  runs: number;
  tokens: number;
  cost: CostValue;
  lastOutcome: Outcome | null;
  isMine: boolean;
  /** Present ONLY when the viewer may see individuals (full mode, lead / admin). */
  userId?: string | null;
  userName?: string | null;
}

export interface ActiveSessionsPayload {
  nowMs: number;
  /** Aggregates-only mode: only the viewer's own sessions are listed. */
  ownOnly: boolean;
  /** More running sessions than the strip holds (LIVE_MAX_SESSIONS). */
  truncated: boolean;
  rows: ActiveSession[];
}

/** One session's live state (`GET /api/live/sessions/<id>`). */
export interface LiveSessionPayload {
  nowMs: number;
  status: LiveStatus;
  currentTurnStartedMs: number | null;
  turns: number;
  runs: number;
  workflows: number;
  tokens: number;
  cost: CostValue;
  outcomes: Outcomes;
  lastActivityMs: number;
  endedMs: number | null;
  title: string;
  /** Changes when the server-rendered page is out of date (the page then refreshes); never covers flows or cost. */
  rev: string;
}
