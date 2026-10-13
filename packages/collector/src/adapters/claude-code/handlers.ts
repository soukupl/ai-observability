import { statSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeCorrection } from '../../analysis/corrections.js';
import { summariesDue } from '../../analysis/summaries.js';
import { sessionEndEvent, sessionStartEvent } from '../../events.js';
import type { CollectorContext, HookInvocation } from '../types.js';
import { cachedVersion, type VersionProbe } from './detect.js';
import {
  collectWorkflowRuns,
  emitSessionTitle,
  Emitter,
  flushOpenRuns,
  followUpTurns,
  processTranscript,
  settleLastTurn,
  settleTurns,
  subagentFailed,
  subagentFinished,
} from './session.js';
import { evictedUnsettledTurns, loadSession, newSessionState, saveSession, type SessionState } from './state.js';

/** A session silent for this long without SessionEnd is considered crashed. */
export const CRASH_AFTER_MS = 24 * 3600_000;
/** Ended sessions' state is kept this long (a resumed session continues from its cursor). */
export const KEEP_ENDED_MS = 30 * 24 * 3600_000;

export interface HandlerDeps {
  claudeDir: string;
  probe: VersionProbe;
}

interface Payload {
  session_id?: unknown;
  transcript_path?: unknown;
  source?: unknown;
  reason?: unknown;
  prompt?: unknown;
  agent_id?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Where Claude Code keeps a session transcript when the payload does not say. */
export function defaultTranscriptPath(claudeDir: string, cwd: string, sessionId: string): string {
  return join(claudeDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export async function handleHook(event: HookInvocation, ctx: CollectorContext, deps: HandlerDeps): Promise<void> {
  const p = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Payload;
  const sessionId = str(p.session_id);
  if (!sessionId) {
    ctx.log.warn('claude-code: hook without session_id', { hook: event.hook });
    return;
  }
  const receivedAt = Number.isFinite(Date.parse(event.receivedAt)) ? Date.parse(event.receivedAt) : ctx.now().getTime();
  const transcriptPath = str(p.transcript_path) ?? defaultTranscriptPath(deps.claudeDir, event.cwd, sessionId);

  let st = loadSession(ctx.state, sessionId);
  if (!st) {
    st = newSessionState(sessionId, transcriptPath, event.cwd, receivedAt);
    // A resumed / compacted / forked session we never saw: do not back-fill its history. A fork's
    // transcript starts with a copy of the parent conversation, already counted under the parent.
    if (event.hook === 'SessionStart' && (p.source === 'resume' || p.source === 'compact' || p.source === 'fork')) {
      st.offset = fileSize(transcriptPath);
    }
  } else {
    st.transcriptPath = transcriptPath;
    st.pkCwd ??= st.cwd; // state written by 0.1.x: pin the session's own cwd before it is overwritten
    st.cwd = event.cwd;
  }
  if (st.ended && event.hook !== 'SessionEnd') st.ended = false; // resumed
  st.lastSeen = Math.max(st.lastSeen, receivedAt);
  const em = new Emitter(ctx.harness, st);
  // Turn-scoped hooks fired inside a sub-agent carry `agent_id`: they are not about the main turn.
  const subagent = str(p.agent_id);

  switch (event.hook) {
    case 'UserPromptSubmit': {
      if (subagent) break;
      processTranscript(em, { mode: 'prompt', receivedAt });
      const prompt = typeof p.prompt === 'string' ? p.prompt : null;
      if (prompt !== null) {
        const human = !/^\s*<task-notification>/.test(prompt);
        followUpTurns(em, { human, correction: human && looksLikeCorrection(prompt), revertOf: () => false }, receivedAt);
      }
      break;
    }
    case 'Stop':
      if (subagent) break;
      processTranscript(em, { mode: 'stop', receivedAt });
      break;
    case 'StopFailure':
      // An API error inside a sub-agent fails that run only; the main turn keeps running.
      if (subagent) subagentFailed(em, subagent);
      else processTranscript(em, { mode: 'stop', receivedAt, stopFailure: true });
      break;
    case 'SubagentStop': {
      const agentId = str(p.agent_id);
      if (agentId) subagentFinished(em, agentId);
      break;
    }
    case 'SessionEnd':
      endSession(em, str(p.reason) ?? 'other', receivedAt);
      break;
    default:
      break; // SessionStart: only session_start below
  }
  if (event.hook !== 'SessionEnd') collectWorkflowRuns(em);

  if (!st.startedSent) {
    const firstTurn = st.turns[0]?.agg.startedAt;
    const at = firstTurn !== undefined ? Math.min(firstTurn, receivedAt) : receivedAt;
    const harnessVersion = await cachedVersion(ctx.paths.state, deps.probe, ctx.now().getTime());
    const project = await ctx.projectKey(st.pkCwd ?? st.cwd);
    em.events.unshift(sessionStartEvent({ harness: ctx.harness, sessionId, at, harnessVersion, project }));
    st.startedSent = true;
  }
  await finish(em, ctx, receivedAt);
}

/** Ends a session: remaining turns, open sub-agents, final outcome of every unsettled turn, session_end. */
function endSession(em: Emitter, reason: string, at: number): void {
  processTranscript(em, { mode: 'end', receivedAt: at });
  flushOpenRuns(em);
  const lastActivity = em.state.turns.at(-1)?.agg.endedAt ?? 0;
  const endAt = Math.max(at, lastActivity);
  settleLastTurn(em, endAt);
  em.events.push(sessionEndEvent({ harness: em.harness, sessionId: em.state.sessionId, reason, at: endAt }));
  em.state.ended = true;
}

/**
 * Enqueue into the session's stream (pinned at its first hook, which always carries `session_start`;
 * `capturedAt` = that job's received_at; C12, C15), save the cursor and the pin, then summarize the waiting
 * turns when they are due (session over, 10 waiting, or the first has waited 10 minutes; ADR-0023).
 */
async function finish(em: Emitter, ctx: CollectorContext, capturedAt: number): Promise<void> {
  const st = em.state;
  // Turns about to fall out of the state file never see a follow-up: settle them now.
  settleTurns(em, evictedUnsettledTurns(st), st.lastSeen);
  emitSessionTitle(em);
  if (st.digests.length > 0 && st.digestsSince === undefined) st.digestsSince = capturedAt;
  const summarize = summariesDue({ ended: st.ended, pending: st.digests.length, since: st.digestsSince, now: capturedAt });
  const key = em.events.length || summarize ? await ctx.streamFor(st, capturedAt) : null;
  if (em.events.length) ctx.queue.enqueue(em.events, key);
  saveSession(ctx.state, st);
  if (summarize) {
    const digests = st.digests;
    st.digests = [];
    delete st.digestsSince;
    saveSession(ctx.state, st);
    await ctx.summarizeTurns(digests, key); // retries failures itself
  }
}

/** SessionStart sweep: sessions silent for 24 h without SessionEnd get session_end "crashed". */
export async function sweepCrashedSessions(ctx: CollectorContext): Promise<void> {
  const now = ctx.now().getTime();
  for (const { sessionId, updatedAt } of ctx.state.list()) {
    if (now - updatedAt < CRASH_AFTER_MS) continue;
    let st: SessionState | null;
    try {
      st = loadSession(ctx.state, sessionId);
    } catch {
      st = null;
    }
    if (!st) continue;
    if (st.ended) {
      if (now - updatedAt > KEEP_ENDED_MS) ctx.state.delete(sessionId);
      continue;
    }
    try {
      st.pkCwd ??= st.cwd;
      const em = new Emitter(ctx.harness, st);
      endSession(em, 'crashed', st.lastSeen);
      await finish(em, ctx, now);
    } catch (err) {
      ctx.log.warn('claude-code: sweep failed for a session', { error: String(err).slice(0, 200) });
    }
  }
}
