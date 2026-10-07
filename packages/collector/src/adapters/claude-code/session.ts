import { buildDigest } from '../../analysis/digest.js';
import { looksLikeCorrection } from '../../analysis/corrections.js';
import { detectRevert, finalOutcome, provisionalOutcome } from '../../analysis/outcome.js';
import { mergeUsage, primaryModel } from '../../analysis/tokens.js';
import { turnEvent, turnOutcomeEvent } from '../../events.js';
import type { IngestEvent, Outcome } from '../../protocol-types.js';
import { analyzeEntries, isWorkflowKey, mergeAgg } from './analyze.js';
import type { SessionState, StoredTurn } from './state.js';
import { agentsOfToolUses, buildRun, listAgents, workflowOver, type AgentMeta } from './subagents.js';
import { hasRevertCommand, readTranscript, type SlimEntry, type TranscriptLine } from './transcript.js';

/**
 * Turns the new part of a session transcript into events. Turn boundary: a real user prompt (not a
 * tool result, meta / compact entry, local-command output or interrupt marker) starts a turn; the
 * turn ends at the next prompt or at the Stop that follows it. Everything is derived from transcript
 * timestamps and ids, so re-reading after a crash yields the same events (same ids).
 */
export type ProcessMode =
  /** Stop / StopFailure: the turn whose prompt precedes the hook time ended */
  | 'stop'
  /** UserPromptSubmit: earlier turns that never got a Stop (interrupted) ended */
  | 'prompt'
  /** SessionEnd / crash sweep: everything ended */
  | 'end';

export interface ProcessOptions {
  mode: ProcessMode;
  /** hook time (epoch ms) */
  receivedAt: number;
  /** StopFailure: the turn ended with an API error */
  stopFailure?: boolean;
}

interface Segment {
  start: number;
  prompt: Extract<SlimEntry, { k: 'prompt' }>;
  entries: SlimEntry[];
}

/** Collects events for one hook; `flush()` returns them in emission order. */
export class Emitter {
  readonly events: IngestEvent[] = [];
  private agents: Map<string, AgentMeta> | null = null;
  constructor(
    readonly harness: string,
    readonly state: SessionState,
  ) {}

  /** Sub-agent metas, read once per hook. */
  agentMetas(): Map<string, AgentMeta> {
    this.agents ??= listAgents(this.state.transcriptPath);
    return this.agents;
  }

  private over = new Map<string, boolean>();

  /** Whether a Workflow run has finished (status file), read once per hook. */
  workflowOver(workflowId: string): boolean {
    let v = this.over.get(workflowId);
    if (v === undefined) {
      v = workflowOver(this.state.transcriptPath, workflowId);
      this.over.set(workflowId, v);
    }
    return v;
  }
}

export function processTranscript(em: Emitter, opts: ProcessOptions): void {
  const st = em.state;
  const read = readTranscript(st.transcriptPath, st.offset, st.sessionId);
  const pre: SlimEntry[] = [];
  const segments: Segment[] = [];
  for (const l of read.lines) addLine(l, pre, segments);

  const prev = st.turns.at(-1);
  if (prev && pre.length) continueTurn(em, prev, pre, opts);

  let done = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    const active = seg.entries.some((e) => e.k === 'assistant');
    if (isLast && !endsHere(seg, active, opts)) break;
    done = i + 1;
    if (active) finalizeTurn(em, seg, Boolean(opts.stopFailure) && isLast && opts.mode === 'stop', opts.mode === 'end');
  }
  st.offset = done < segments.length ? segments[done]!.start : read.end;
}

/**
 * A prompt starts a new segment, except a message Claude Code injects itself (task notification)
 * into a turn that is still running (no end-of-turn record since its prompt): that is part of the turn.
 */
function addLine(l: TranscriptLine, pre: SlimEntry[], segments: Segment[]): void {
  const cur = segments.at(-1);
  if (l.entry.k !== 'prompt') {
    (cur?.entries ?? pre).push(l.entry);
    return;
  }
  const running = cur && cur.entries.some((e) => e.k === 'assistant') && !cur.entries.some((e) => e.k === 'stop' || e.k === 'interrupt');
  if (!l.entry.human && running) return;
  segments.push({ start: l.start, prompt: l.entry, entries: [l.entry] });
}

/** Whether the last (not yet followed by a prompt) segment is a finished turn. */
function endsHere(seg: Segment, active: boolean, opts: ProcessOptions): boolean {
  if (opts.mode === 'end') return true;
  // A prompt typed after the hook fired belongs to the next turn; an empty segment has not run yet.
  return active && seg.prompt.at < opts.receivedAt;
}

function finalizeTurn(em: Emitter, seg: Segment, stopFailure: boolean, sessionEnding: boolean): void {
  const st = em.state;
  const agg = analyzeEntries(seg.entries);
  const revertCommand = hasRevertCommand(seg.entries);
  followUpTurns(
    em,
    {
      human: seg.prompt.human,
      correction: seg.prompt.human && looksLikeCorrection(seg.prompt.text),
      revertOf: (t) => t.agg.linesAdded + t.agg.linesRemoved > 0 && (revertCommand || detectRevert(t.agg.fp, agg.fp)),
    },
    seg.prompt.at,
  );
  const turn: StoredTurn = {
    turnId: seg.prompt.uuid,
    sessionId: st.sessionId,
    agg,
    runUsage: [],
    rev: 0,
    provisional: provisionalOutcome({ stopFailure, interrupted: agg.interrupted, lastCheck: agg.lastCheck }),
    stopFailure,
    final: false,
    correction: false,
    reverted: false,
    human: seg.prompt.human,
    emitted: [],
  };
  const runs = collectRuns(em, turn, sessionEnding);
  emitTurn(em, turn);
  em.events.push(...runs);
  st.turns.push(turn);
  st.digests.push(
    buildDigest({ turnId: turn.turnId, sessionId: st.sessionId, prompt: seg.prompt.text, toolNames: agg.toolNames, lastAssistantMessage: agg.lastMessage }),
  );
}

/** Activity after a Stop without a new prompt (a Stop hook made Claude continue): extends that turn. */
function continueTurn(em: Emitter, turn: StoredTurn, entries: SlimEntry[], opts: ProcessOptions): void {
  const more = analyzeEntries(entries, { startAt: turn.agg.endedAt, skipResponseIds: new Set(turn.agg.responseIds) });
  if (!more.active) return;
  turn.agg = mergeAgg(turn.agg, more);
  if (opts.stopFailure && opts.mode === 'stop') turn.stopFailure = true;
  turn.provisional = provisionalOutcome({ stopFailure: turn.stopFailure, interrupted: turn.agg.interrupted, lastCheck: turn.agg.lastCheck });
  const runs = collectRuns(em, turn, opts.mode === 'end');
  turn.rev++;
  emitTurn(em, turn);
  em.events.push(...runs);
}

interface FollowUpSignal {
  human: boolean;
  correction: boolean;
  revert: boolean;
}

export interface TurnFollowUp {
  /** the next prompt was typed by the user (not a task notification Claude Code injected) */
  human: boolean;
  /** the next prompt looks like a correction */
  correction: boolean;
  /** whether the next turn reverted this turn's edits */
  revertOf: (t: StoredTurn) => boolean;
}

/** Index of the most recent human-initiated turn (turns from before the `human` flag count as human). */
function lastHumanTurn(turns: readonly StoredTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.human !== false) return i;
  return 0;
}

/**
 * Settles the stored turns once the next prompt is known. The follow-up is about the most recent
 * human-initiated turn AND the task-notification turns that came after it (they continue its work,
 * e.g. background agents or a Workflow reporting back): a correction or revert fails them, a plain
 * human prompt finalizes them. Older turns still waiting (none normally) are finalized without a
 * signal. A task-notification prompt only carries a revert signal; otherwise it settles nothing.
 */
export function followUpTurns(em: Emitter, f: TurnFollowUp, at: number): void {
  const turns = em.state.turns;
  const group = lastHumanTurn(turns);
  turns.forEach((t, i) => {
    if (i >= group) applyFollowUp(em, t, { human: f.human, correction: f.correction, revert: f.revertOf(t) }, at);
    else applyFollowUp(em, t, { human: f.human, correction: false, revert: false }, at);
  });
}

/**
 * Settles one turn once the next prompt is known: a human prompt finalizes it (correction or not); a
 * revert in the next turn fails it even after it was finalized. Prompts Claude Code starts on its own
 * (task notifications) say nothing about it. Callers go through `followUpTurns`.
 */
export function applyFollowUp(em: Emitter, prev: StoredTurn, f: FollowUpSignal, at: number): void {
  if (!prev.final) {
    if (!f.human && !f.revert) return;
    prev.correction = f.correction;
    prev.reverted = f.revert;
    prev.final = true;
    pushOutcome(em, prev, finalOutcome(prev.provisional, { correction: f.correction, revert: f.revert }), at);
  } else if (f.revert && !prev.reverted) {
    prev.reverted = true;
    pushOutcome(em, prev, finalOutcome(prev.provisional, { correction: prev.correction, revert: true }), at);
  }
}

/**
 * The session ended: every turn still waiting for a follow-up (the last one, and the human turn whose
 * task-notification turns came after it) becomes final (`unknown` stays `unknown`).
 */
export function settleLastTurn(em: Emitter, at: number): void {
  settleTurns(em, em.state.turns, at);
}

/** Final outcome for turns no follow-up will ever reach (session over, or dropped from state). */
export function settleTurns(em: Emitter, turns: readonly StoredTurn[], at: number): void {
  for (const t of turns) {
    if (t.final) continue;
    t.final = true;
    pushOutcome(em, t, finalOutcome(t.provisional, { sessionEnded: true }), at);
  }
}

function pushOutcome(em: Emitter, t: StoredTurn, outcome: Outcome, at: number): void {
  em.events.push(turnOutcomeEvent({ harness: em.harness, turnId: t.turnId, outcome, at }));
}

/** The turn event; the whole turn's usage (main agent + counted sub-agents). Re-sends get a new id. */
export function emitTurn(em: Emitter, t: StoredTurn): void {
  const main = primaryModel(t.agg.usage);
  const usage = mergeUsage(t.agg.usage, t.runUsage);
  const primary = main ?? primaryModel(usage);
  em.events.push(
    turnEvent({
      harness: em.harness,
      sessionId: t.sessionId,
      turnId: t.turnId,
      startedAt: t.agg.startedAt,
      endedAt: t.agg.endedAt,
      model: primary?.model ?? 'unknown',
      effort: primary?.effort ?? null,
      usage,
      phases: t.agg.phases,
      tools: t.agg.tools,
      skills: t.agg.skills,
      mcp: t.agg.mcp,
      mcpStats: t.agg.mcpStats,
      filesTouched: t.agg.fileKeys.length,
      linesAdded: t.agg.linesAdded,
      linesRemoved: t.agg.linesRemoved,
      outcome: t.provisional,
      ...(t.rev ? { idSalt: `rev${t.rev}` } : {}),
    }),
  );
}

/**
 * Run events for the turn's finished sub-agents (and their nested sub-agents) not sent yet; their
 * usage is added to the turn. Background sub-agents still running are picked up by SubagentStop.
 */
export function collectRuns(em: Emitter, turn: StoredTurn, all: boolean): IngestEvent[] {
  const calls = turn.agg.agentCalls;
  const ids = Object.keys(calls);
  if (!ids.length) return [];
  const st = em.state;
  const metas = em.agentMetas();
  const done = new Set(st.doneAgents);
  const failed = new Set(st.failedAgents ?? []);
  // The turn's own list is authoritative (never trimmed while the turn is kept); the session-wide
  // list is capped and only covers turns saved before per-turn lists existed.
  const emitted = new Set([...st.emittedAgents, ...(turn.emitted ?? [])]);
  const out: IngestEvent[] = [];
  for (const meta of agentsOfToolUses(metas, ids)) {
    if (emitted.has(meta.agentId)) continue;
    const a = failed.has(meta.agentId) && !meta.failed ? { ...meta, failed: true } : meta;
    const root = rootOf(a, metas);
    const call = root.toolUseId ? calls[root.toolUseId] : undefined;
    const wfDone = isWorkflowKey(root.toolUseId) && root.workflowId !== null && em.workflowOver(root.workflowId);
    if (!(all || done.has(a.agentId) || call?.completed || a.finished || wfDone)) continue;
    const run = buildRun(a, metas, { harness: em.harness, turnId: turn.turnId, agentTypeHint: a.parentAgentId ? null : (call?.type ?? null) });
    if (!run) continue;
    out.push(run.event);
    turn.runUsage = mergeUsage(turn.runUsage, run.usage);
    st.emittedAgents.push(a.agentId);
    (turn.emitted ??= []).push(a.agentId);
    emitted.add(a.agentId);
    if (a.agentId === root.agentId && call && !isWorkflowKey(root.toolUseId)) call.completed = true;
  }
  // A Workflow call covers many agents: it is complete once the whole workflow is over.
  for (const [key, call] of Object.entries(calls)) {
    if (isWorkflowKey(key) && !call.completed && em.workflowOver(key.slice(3))) call.completed = true;
  }
  if (all) for (const c of Object.values(calls)) c.completed = true;
  return out;
}

function rootOf(a: AgentMeta, metas: ReadonlyMap<string, AgentMeta>): AgentMeta {
  let cur = a;
  const seen = new Set<string>();
  while (cur.parentAgentId && !seen.has(cur.agentId)) {
    seen.add(cur.agentId);
    const p = metas.get(cur.parentAgentId);
    if (!p) break;
    cur = p;
  }
  return cur;
}

/** SubagentStop: a sub-agent finished. If its turn was already sent, send the run and re-send the turn. */
export function subagentFinished(em: Emitter, agentId: string): void {
  const st = em.state;
  if (!st.doneAgents.includes(agentId)) st.doneAgents.push(agentId);
  if (st.emittedAgents.includes(agentId)) return;
  const metas = em.agentMetas();
  const a = metas.get(agentId);
  if (!a) return;
  const root = rootOf(a, metas);
  const turn = st.turns.find((t) => root.toolUseId && t.agg.agentCalls[root.toolUseId]);
  if (!turn) return; // turn not finalized yet: included at its Stop
  const runs = collectRuns(em, turn, false);
  if (!runs.length) return;
  turn.rev++;
  emitTurn(em, turn);
  em.events.push(...runs);
}

/**
 * StopFailure fired inside a sub-agent (payload has `agent_id`): that agent's run ended with an API
 * error. It is not the main turn's end: the run is marked `failed` (stop_failure) and sent like a
 * finished sub-agent.
 */
export function subagentFailed(em: Emitter, agentId: string): void {
  const st = em.state;
  st.failedAgents ??= [];
  if (!st.failedAgents.includes(agentId)) st.failedAgents.push(agentId);
  subagentFinished(em, agentId);
}

/**
 * Workflow runs outlive the turn that launched them (they run in the background). After every hook,
 * send the runs of agents that finished since, and re-send their turn with the added usage.
 */
export function collectWorkflowRuns(em: Emitter): void {
  for (const turn of em.state.turns) {
    if (!Object.entries(turn.agg.agentCalls).some(([k, c]) => isWorkflowKey(k) && !c.completed)) continue;
    const runs = collectRuns(em, turn, false);
    if (!runs.length) continue;
    turn.rev++;
    emitTurn(em, turn);
    em.events.push(...runs);
  }
}

/** Session over: send runs of sub-agents that never reported, as far as their transcripts go. */
export function flushOpenRuns(em: Emitter): void {
  for (const turn of em.state.turns) {
    if (!Object.values(turn.agg.agentCalls).some((c) => !c.completed)) continue;
    const runs = collectRuns(em, turn, true);
    if (!runs.length) continue;
    turn.rev++;
    emitTurn(em, turn);
    em.events.push(...runs);
  }
}

