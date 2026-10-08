import { buildDigest, type TurnDigest } from '../../analysis/digest.js';
import { looksLikeCorrection } from '../../analysis/corrections.js';
import { detectRevert, finalOutcome, outcomeChanged, provisionalOutcome } from '../../analysis/outcome.js';
import { attributeTime } from '../../analysis/phases.js';
import { mergeUsage, primaryModel } from '../../analysis/tokens.js';
import { mcpFromTools } from '../../analysis/usage.js';
import { sessionEndEvent, sessionStartEvent, turnEvent, turnOutcomeEvent, type TurnInput } from '../../events.js';
import type { IngestEvent, Outcome, ProjectRef, UsageEntry } from '../../protocol-types.js';
import type { StreamKey } from '../../queue.js';
import { addUsage, applyItem, newAcc, usageDelta, type RunAcc } from './accumulator.js';
import { isRealPrompt, type RolloutItem, type SessionMeta, type TokenTotals } from './records.js';
import type { ResolvedChildren } from './subagents.js';
import { toolCounts } from './subagents.js';

/**
 * Per-session state of a MAIN Codex thread (~/.ai-obs/state/codex/<session>.json). Local only.
 * Turn = task_started … task_complete | turn_aborted (or the Stop hook when the rollout lags).
 */
export interface CodexSessionState {
  v: 1;
  sessionId: string;
  rolloutPath: string | null;
  /** byte offset of the next unread rollout line */
  offset: number;
  meta: SessionMeta | null;
  /** a sub-agent thread: never processed as a main session */
  subagent: boolean;
  startedSent: boolean;
  ended: boolean;
  /** last cumulative total_token_usage seen (token deltas are taken against it) */
  lastTotal: TokenTotals | null;
  model: string | null;
  effort: string | null;
  open: (RunAcc & { turnId: string }) | null;
  /** usage seen outside a turn; added to the next turn */
  carry: UsageEntry[];
  prev: PrevTurn | null;
  /** recently closed turn ids (late records for them are ignored) */
  closed: string[];
  /** recently emitted turns, for re-sending with late sub-agent usage */
  emitted: EmittedTurn[];
  /** local-only summary input, flushed at session end */
  digests: TurnDigest[];
  lastActivityAt: number;
  /**
   * The cwd the session's project key is resolved from: session_meta's cwd, else the first hook's
   * cwd; null = unknown (state written by 0.1.x without session_meta: its events are dropped, C16).
   */
  pkCwd?: string | null;
  /** the session's stream, pinned at its first hook (C12, C15); sub-agent stops use it too */
  stream?: StreamKey;
}

export interface PrevTurn {
  turnId: string;
  endedAt: number;
  provisional: Outcome;
  final: Outcome | null;
  correction: boolean;
  revertChecked: boolean;
  fpAdded: string[];
}

export interface EmittedTurn {
  input: Omit<TurnInput, 'harness'>;
  /** main-agent usage (without sub-agents) */
  mainUsage: UsageEntry[];
  children: Record<string, UsageEntry[]>;
  spawned: string[];
  rev: number;
}

export function newSessionState(sessionId: string, at: number): CodexSessionState {
  return {
    v: 1, sessionId, rolloutPath: null, offset: 0, meta: null, subagent: false, startedSent: false, ended: false,
    lastTotal: null, model: null, effort: null, open: null, carry: [], prev: null, closed: [], emitted: [], digests: [], lastActivityAt: at,
  };
}

export interface SessionEnv {
  harness: string;
  emit(events: IngestEvent[]): void;
  project(cwd: string): Promise<ProjectRef | undefined>;
  /** resolves sub-agent threads spawned in a turn (file IO lives outside this module) */
  children(rootTurnId: string, ids: readonly string[]): ResolvedChildren;
}

const MAX_CLOSED = 50;
const MAX_EMITTED = 5;
const MAX_DIGESTS = 200;

// ---------------------------------------------------------------- outcome patches

/** Final outcome of the previous turn once the next prompt is known (correction heuristic). */
export function finalizePrev(state: CodexSessionState, env: SessionEnv, follow: { prompt?: string | null; sessionEnded?: boolean }, at: number): void {
  const prev = state.prev;
  if (!prev || prev.final) return;
  const correction = follow.prompt ? looksLikeCorrection(follow.prompt) : false;
  prev.correction = correction;
  prev.final = finalOutcome(prev.provisional, follow.sessionEnded ? { sessionEnded: true } : { correction });
  env.emit([turnOutcomeEvent({ harness: env.harness, turnId: prev.turnId, outcome: prev.final, at: Math.max(at, prev.endedAt) })]);
}

/** The turn after `prev` reverted its edits (git checkout/restore/reset, or removed ≥ 80 % of its added lines). */
function checkRevert(state: CodexSessionState, env: SessionEnv, acc: RunAcc, at: number): void {
  const prev = state.prev;
  if (!prev || prev.revertChecked) return;
  prev.revertChecked = true;
  const revert = acc.revertCmd || detectRevert({ added: prev.fpAdded, removed: [] }, { added: [], removed: acc.fpRemoved });
  if (!revert) return;
  const base = prev.final ?? prev.provisional;
  const next = finalOutcome(prev.provisional, { correction: prev.correction, revert: true });
  if (outcomeChanged(base, next)) {
    prev.final = next;
    env.emit([turnOutcomeEvent({ harness: env.harness, turnId: prev.turnId, outcome: next, at })]);
  }
}

// ---------------------------------------------------------------- turns

function turnInputOf(state: CodexSessionState, acc: RunAcc & { turnId: string }, endAt: number): Omit<TurnInput, 'harness'> {
  const main = primaryModel(acc.usage);
  return {
    sessionId: state.sessionId,
    turnId: acc.turnId,
    startedAt: acc.startedAt,
    endedAt: endAt,
    model: main?.model ?? acc.model ?? 'unknown',
    effort: main ? main.effort : acc.effort,
    usage: acc.usage,
    phases: attributeTime(acc.timeline, endAt),
    tools: toolCounts(acc.tools),
    skills: acc.skills,
    mcp: mcpFromTools(acc.tools),
    mcpStats: acc.mcpStats,
    filesTouched: acc.files.length,
    linesAdded: acc.linesAdded,
    linesRemoved: acc.linesRemoved,
    outcome: provisionalOutcome({ stopFailure: acc.error, interrupted: acc.interrupted, lastCheck: acc.lastCheck }),
  };
}

/** Closes the open turn: emits `turn` (+ sub-agent `run`s), updates prev/outcome bookkeeping. */
export function closeOpenTurn(state: CodexSessionState, env: SessionEnv, endAt: number): void {
  const acc = state.open;
  if (!acc) return;
  state.open = null;
  const end = Math.max(endAt, acc.startedAt);
  if (state.prev && !state.prev.final) finalizePrev(state, env, { prompt: acc.prompt }, acc.startedAt);
  checkRevert(state, env, acc, end);

  const input = turnInputOf(state, acc, end);
  const kids = acc.spawned.length ? env.children(acc.turnId, acc.spawned) : { runs: [], usage: {}, missing: [] };
  const childUsage = Object.values(kids.usage);
  env.emit([turnEvent({ harness: env.harness, ...input, usage: mergeUsage(acc.usage, ...childUsage) }), ...kids.runs]);

  state.emitted = [...state.emitted, { input, mainUsage: acc.usage, children: kids.usage, spawned: acc.spawned, rev: 0 }].slice(-MAX_EMITTED);
  state.closed = [...state.closed, acc.turnId].slice(-MAX_CLOSED);
  state.prev = { turnId: acc.turnId, endedAt: end, provisional: input.outcome, final: null, correction: false, revertChecked: false, fpAdded: acc.fpAdded };
  if (acc.prompt) {
    state.digests = [
      ...state.digests,
      buildDigest({ turnId: acc.turnId, sessionId: state.sessionId, prompt: acc.prompt, toolNames: acc.toolNames, lastAssistantMessage: acc.lastMessage ?? '' }),
    ].slice(-MAX_DIGESTS);
  }
}

/**
 * Re-resolves the sub-agents of an already emitted turn (a SubagentStop that arrived after the
 * parent's Stop) and re-sends the turn with the merged usage when anything changed.
 */
export function refreshEmittedTurn(state: CodexSessionState, env: SessionEnv, turnId: string, extraIds: readonly string[]): boolean {
  const t = state.emitted.find((e) => e.input.turnId === turnId);
  if (!t) return false;
  t.spawned = [...new Set([...t.spawned, ...extraIds])];
  const kids = env.children(turnId, t.spawned);
  const sig = (u: Record<string, UsageEntry[]>) => JSON.stringify(Object.entries(u).sort(([a], [b]) => a.localeCompare(b)));
  if (sig(kids.usage) === sig(t.children)) return true;
  t.children = kids.usage;
  t.rev += 1;
  env.emit([
    ...kids.runs,
    turnEvent({ harness: env.harness, ...t.input, usage: mergeUsage(t.mainUsage, ...Object.values(kids.usage)), idSalt: `rev${t.rev}` }),
  ]);
  return true;
}

// ---------------------------------------------------------------- rollout items

/** Feeds rollout items (in file order) into the session. */
export async function applyItems(state: CodexSessionState, env: SessionEnv, items: readonly RolloutItem[]): Promise<void> {
  for (const item of items) {
    if (state.subagent) return;
    state.lastActivityAt = Math.max(state.lastActivityAt, item.at);
    switch (item.kind) {
      case 'meta': {
        if (state.meta) break;
        state.meta = item.meta;
        if (item.meta.isSubagent) {
          state.subagent = true;
          return;
        }
        if (!state.startedSent) {
          const project = item.meta.cwd ? await env.project(item.meta.cwd) : undefined;
          env.emit([
            sessionStartEvent({ harness: env.harness, sessionId: state.sessionId, at: item.meta.startedAt, harnessVersion: item.meta.cliVersion, ...(project ? { project } : {}) }),
          ]);
          state.startedSent = true;
        }
        break;
      }
      case 'turn_started': {
        if (state.closed.includes(item.turnId) || state.open?.turnId === item.turnId) break;
        if (state.open) {
          state.open.interrupted = true;
          closeOpenTurn(state, env, item.at);
        }
        state.ended = false;
        const acc = newAcc(item.at, state.model, state.effort);
        state.open = { ...acc, turnId: item.turnId, usage: state.carry };
        state.carry = [];
        break;
      }
      case 'turn_context':
        state.model = item.model ?? state.model;
        state.effort = item.effort ?? state.effort;
        if (state.open) applyItem(state.open, item);
        break;
      case 'user_prompt':
        if (state.open && state.open.prompt === null && isRealPrompt(item.text)) {
          applyItem(state.open, item);
          finalizePrev(state, env, { prompt: item.text }, item.at);
        }
        break;
      case 'token_count': {
        const d = usageDelta(state.lastTotal, item);
        if (item.total) state.lastTotal = item.total;
        if (!d) break;
        if (state.open) addUsage(state.open, d, state.open.model, state.open.effort);
        else {
          const tmp = newAcc(item.at, state.model, state.effort);
          tmp.usage = state.carry;
          addUsage(tmp, d, state.model, state.effort);
          state.carry = tmp.usage;
        }
        break;
      }
      case 'turn_complete':
      case 'turn_aborted': {
        const open = state.open;
        if (!open || (item.turnId && item.turnId !== open.turnId)) break;
        if (item.kind === 'turn_aborted') open.interrupted = true;
        else if (item.lastMessage) open.lastMessage = item.lastMessage;
        open.lastAt = Math.max(open.lastAt, item.at);
        closeOpenTurn(state, env, item.at);
        break;
      }
      default:
        if (state.open) applyItem(state.open, item);
    }
  }
}

/** Ends the session: an unfinished turn is closed as abandoned, the last turn gets its final outcome. */
export function endSession(state: CodexSessionState, env: SessionEnv, reason: string, at: number): void {
  if (state.ended || state.subagent) return;
  if (state.open) {
    state.open.interrupted = true;
    closeOpenTurn(state, env, Math.max(state.open.lastAt, state.open.startedAt));
  }
  finalizePrev(state, env, { sessionEnded: true }, at);
  if (state.startedSent) env.emit([sessionEndEvent({ harness: env.harness, sessionId: state.sessionId, reason, at: Math.max(at, state.lastActivityAt) })]);
  state.ended = true;
}
