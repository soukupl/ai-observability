import type { TurnDigest } from '../../analysis/digest.js';
import type { Outcome, UsageEntry } from '../../protocol-types.js';
import type { StreamKey } from '../../queue.js';
import type { SessionStateStore } from '../../state.js';
import type { Agg } from './analyze.js';

/**
 * Per-session state (~/.ai-obs/state/claude-code/<session>.json, local only). No paths are stored
 * except the transcript path itself (needed to resume reading) and the cwd (project lookup).
 */
export interface StoredTurn {
  turnId: string;
  sessionId: string;
  /** main agent only (sub-agents are in runUsage) */
  agg: Agg;
  /** usage of the sub-agent runs counted into this turn */
  runUsage: UsageEntry[];
  /** times the turn event was re-sent with more data (continuation, late sub-agent) */
  rev: number;
  provisional: Outcome;
  stopFailure: boolean;
  /** a final turn_outcome patch was sent */
  final: boolean;
  correction: boolean;
  reverted: boolean;
  /**
   * The turn was started by a prompt the user typed (false: a task notification Claude Code injected).
   * Absent in state written by older collectors (treated as human).
   */
  human?: boolean;
  /** sub-agents whose run event was sent for this turn (dropped with the turn; never capped) */
  emitted?: string[];
  /**
   * What run links need of the runs sent for this turn (ADR-0020), so runs sent in a later pass link to
   * them: [run id, parent run id, orchestration id, flow key, start ms, end ms, incoming links sent]. The
   * last element (`kind|from` pairs, sorted, comma-joined; '' = none) tells when a later run changes a sent
   * run's incoming links, so that run is re-sent. Absent in state written by older collectors (then no
   * links are computed for the turn).
   */
  runSpans?: RunSpan[];
}

export type RunSpan = [
  runId: string,
  parentRunId: string | null,
  orchestrationId: string | null,
  flowKey: string | null,
  startedMs: number,
  endedMs: number,
  linksSent?: string,
];

export interface SessionState {
  v: 1;
  sessionId: string;
  transcriptPath: string;
  /** cwd of the latest hook */
  cwd: string;
  /** the session's first cwd: its project key is resolved from it (C15). Absent in state written by 0.1.x. */
  pkCwd?: string;
  /** the session's stream, pinned at its first hook (C12, C15); every later event goes there */
  stream?: StreamKey;
  /** byte offset of the first transcript line not yet turned into events */
  offset: number;
  startedSent: boolean;
  ended: boolean;
  /** last hook time (epoch ms) */
  lastSeen: number;
  /**
   * recent turns: the last ones, every turn still waiting for its final outcome (the latest human
   * turn and the task-notification turns after it), and turns waiting for background sub-agents
   */
  turns: StoredTurn[];
  /** sub-agents that reported SubagentStop */
  doneAgents: string[];
  /** sub-agents whose run event was sent (capped; StoredTurn.emitted is the per-turn record) */
  emittedAgents: string[];
  /** sub-agents whose run ended with StopFailure (hook payload with `agent_id`) */
  failedAgents?: string[];
  /** turns waiting for a summary (sent at SessionEnd) */
  digests: TurnDigest[];
}

const KEEP_TURNS = 3;
export const MAX_TURNS = 50;
const MAX_AGENT_IDS = 500;
const MAX_DIGESTS = 200;

export function newSessionState(sessionId: string, transcriptPath: string, cwd: string, now: number): SessionState {
  return {
    v: 1,
    sessionId,
    transcriptPath,
    cwd,
    pkCwd: cwd,
    offset: 0,
    startedSent: false,
    ended: false,
    lastSeen: now,
    turns: [],
    doneAgents: [],
    emittedAgents: [],
    digests: [],
  };
}

export function loadSession(store: SessionStateStore, sessionId: string): SessionState | null {
  const s = store.get<SessionState>(sessionId);
  return s && s.v === 1 ? s : null;
}

/** Background sub-agents of a turn that have not been reported yet. */
export function openBackgroundAgents(t: StoredTurn): boolean {
  return Object.values(t.agg.agentCalls).some((c) => !c.completed);
}

/** The turns `saveSession` keeps: the last few, unsettled ones and those with open sub-agents (capped). */
function keptTurns(turns: readonly StoredTurn[]): StoredTurn[] {
  const last = turns.length - KEEP_TURNS;
  return turns.filter((t, i) => i >= last || !t.final || openBackgroundAgents(t)).slice(-MAX_TURNS);
}

/**
 * Turns the next `saveSession` would drop although they never got a final outcome (more than
 * MAX_TURNS unsettled turns). Callers settle them first so no turn stays provisional forever.
 */
export function evictedUnsettledTurns(s: SessionState): StoredTurn[] {
  const kept = new Set(keptTurns(s.turns));
  return s.turns.filter((t) => !t.final && !kept.has(t));
}

/** Trims lists so the state file stays small, then writes it. */
export function saveSession(store: SessionStateStore, s: SessionState): void {
  s.turns = keptTurns(s.turns);
  // Edit fingerprints are only compared against the next human turn: keep them for the latest human
  // turn, the task-notification turns after it, and anything still waiting for its follow-up.
  let group = 0;
  for (let i = s.turns.length - 1; i >= 0; i--) {
    if (s.turns[i]!.human !== false) {
      group = i;
      break;
    }
  }
  s.turns.forEach((t, i) => {
    if (i < group && t.final) t.agg.fp = { added: [], removed: [] };
  });
  s.doneAgents = s.doneAgents.slice(-MAX_AGENT_IDS);
  s.emittedAgents = s.emittedAgents.slice(-MAX_AGENT_IDS);
  if (s.failedAgents) s.failedAgents = s.failedAgents.slice(-MAX_AGENT_IDS);
  s.digests = s.digests.slice(-MAX_DIGESTS);
  store.set(s.sessionId, s);
}
