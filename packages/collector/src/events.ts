import { PHASE_RULES_VERSION, toPhasesMs, type PhaseTotals } from './analysis/phases.js';
import { normalizeMcp, normalizeSkills } from './analysis/usage.js';
import {
  MAX_SUMMARY_LENGTH,
  type McpCounts,
  type Outcome,
  type PhasesMs,
  type ProjectRef,
  type RunEvent,
  type SessionEndEvent,
  type SessionStartEvent,
  type SkillCounts,
  type TurnEvent,
  type TurnOutcomeEvent,
  type TurnSummaryEvent,
  type UsageEntry,
} from './protocol-types.js';
import { ulidFrom } from './ulid.js';

/**
 * Builders for protocol-conformant ingest events (schema 1). They take camelCase input, emit the
 * snake_case wire shape, clamp numbers to non-negative integers, truncate strings to schema limits,
 * and derive a DETERMINISTIC `event_id` (ULID from a seed + the event time) so that re-processing a
 * transcript after a crash yields the same IDs and the server de-duplicates them (ADR-0011).
 * Pass `idSalt` when the same logical event is intentionally re-sent with new content, or `eventId`
 * to override completely.
 *
 * Never put prompts, responses, code, diffs or file paths into any field, including `ext`.
 */
export type TimeInput = Date | string | number;

interface Common {
  harness: string;
  ext?: Record<string, unknown>;
  eventId?: string;
  idSalt?: string;
}

const toMs = (t: TimeInput): number => {
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
  if (!Number.isFinite(ms)) throw new RangeError(`invalid time: ${String(t)}`);
  return ms;
};
const iso = (ms: number) => new Date(ms).toISOString();
const int = (v: number | undefined) => (Number.isFinite(v) && (v as number) > 0 ? Math.round(v as number) : 0);
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
const id = (c: Common, seed: string, timeMs: number) => c.eventId ?? ulidFrom(`${c.harness}|${seed}${c.idSalt ? `|${c.idSalt}` : ''}`, timeMs);
const extOf = (c: Common) => (c.ext && Object.keys(c.ext).length ? { ext: c.ext } : {});

export function normalizeUsage(usage: readonly UsageEntry[]): UsageEntry[] {
  return usage.slice(0, 64).map((u) => ({
    model: clip(u.model || 'unknown', 128),
    effort: u.effort ? clip(u.effort, 32) : null,
    input: int(u.input),
    output: int(u.output),
    cache_read: int(u.cache_read),
    cache_write: int(u.cache_write),
    reasoning: int(u.reasoning),
    requests: int(u.requests),
  }));
}

export function normalizeOutcome(o: Outcome): Outcome {
  return {
    status: o.status,
    signals: [...new Set(o.signals.map((s) => clip(String(s), 64)).filter(Boolean))].slice(0, 32),
    provisional: Boolean(o.provisional),
  };
}

/**
 * Tool-count key: lowercase `[a-z0-9_]`, max 64 chars; every MCP tool collapses to `mcp`
 * (server / tool names can be internal).
 */
export function toolKey(name: string): string {
  if (/^mcp__/i.test(name)) return 'mcp';
  return clip(name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''), 64) || 'unknown';
}

/** Counts tool calls by toolKey(). */
export function countTools(names: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) {
    const k = toolKey(n);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function normalizeTools(tools: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(tools ?? {}).slice(0, 200)) {
    const key = clip(k, 128);
    if (key) out[key] = (out[key] ?? 0) + int(v);
  }
  return out;
}

/** `skills` / `mcp` wire fields, omitted when empty (older servers and collectors never see them). */
function usageOf(i: { skills?: SkillCounts; mcp?: McpCounts }): { skills?: SkillCounts; mcp?: McpCounts } {
  const skills = normalizeSkills(i.skills);
  const mcp = normalizeMcp(i.mcp);
  return { ...(skills ? { skills } : {}), ...(mcp ? { mcp } : {}) };
}

const phasesOf = (p: Partial<PhaseTotals> | PhasesMs): PhasesMs => toPhasesMs(p);

const PLAIN_KEY_RE = /^[a-z0-9.-]+(:\d+)?\/[^\s\\]+$/i;
const HASHED_KEY_RE = /^sha256:[0-9a-f]{64}$/;

function normalizeProject(p: ProjectRef | undefined): ProjectRef | undefined {
  if (!p || p.key.length > 512 || !(HASHED_KEY_RE.test(p.key) || PLAIN_KEY_RE.test(p.key))) return undefined;
  return p.name ? { key: p.key, name: clip(p.name, 200) } : { key: p.key };
}

export function sessionStartEvent(i: Common & { sessionId: string; at: TimeInput; harnessVersion?: string | null; project?: ProjectRef }): SessionStartEvent {
  const at = toMs(i.at);
  const project = normalizeProject(i.project);
  return {
    event_id: id(i, `session_start|${i.sessionId}`, at),
    type: 'session_start',
    harness: i.harness,
    session_id: clip(i.sessionId, 256),
    ...(i.harnessVersion ? { harness_version: clip(i.harnessVersion, 128) } : {}),
    ...(project ? { project } : {}),
    at: iso(at),
    ...extOf(i),
  };
}

export interface TurnInput extends Common {
  sessionId: string;
  turnId: string;
  startedAt: TimeInput;
  endedAt: TimeInput;
  /** primary model of the turn (see analysis/tokens primaryModel) */
  model: string;
  effort: string | null;
  usage: readonly UsageEntry[];
  /** phase totals of the main run (delegating is dropped automatically) */
  phases: Partial<PhaseTotals> | PhasesMs;
  tools?: Record<string, number>;
  /** plain names; the context's queue hashes them in hashed mode */
  skills?: SkillCounts;
  mcp?: McpCounts;
  filesTouched?: number;
  linesAdded?: number;
  linesRemoved?: number;
  outcome: Outcome;
  phaseRulesVersion?: number;
}

export function turnEvent(i: TurnInput): TurnEvent {
  const start = toMs(i.startedAt);
  const end = Math.max(start, toMs(i.endedAt));
  return {
    event_id: id(i, `turn|${i.sessionId}|${i.turnId}`, end),
    type: 'turn',
    harness: i.harness,
    session_id: clip(i.sessionId, 256),
    turn_id: clip(i.turnId, 256),
    started_at: iso(start),
    ended_at: iso(end),
    model: clip(i.model || 'unknown', 128),
    effort: i.effort ? clip(i.effort, 32) : null,
    usage: normalizeUsage(i.usage),
    phases_ms: phasesOf(i.phases),
    tools: normalizeTools(i.tools),
    ...usageOf(i),
    files_touched: int(i.filesTouched),
    lines_added: int(i.linesAdded),
    lines_removed: int(i.linesRemoved),
    outcome: normalizeOutcome(i.outcome),
    phase_rules_version: i.phaseRulesVersion ?? PHASE_RULES_VERSION,
    ...extOf(i),
  };
}

export interface RunInput extends Common {
  turnId: string;
  runId: string;
  /** null for a sub-agent spawned directly by the main agent */
  parentRunId: string | null;
  /** e.g. `Explore`, `general-purpose`; `main` for the main agent */
  agentType: string;
  /** 1 = spawned by the main agent */
  depth: number;
  startedAt: TimeInput;
  endedAt: TimeInput;
  model?: string;
  effort?: string | null;
  usage: readonly UsageEntry[];
  phases: Partial<PhaseTotals> | PhasesMs;
  tools?: Record<string, number>;
  skills?: SkillCounts;
  mcp?: McpCounts;
  outcome: Outcome;
}

export function runEvent(i: RunInput): RunEvent {
  const start = toMs(i.startedAt);
  const end = Math.max(start, toMs(i.endedAt));
  return {
    event_id: id(i, `run|${i.turnId}|${i.runId}`, end),
    type: 'run',
    harness: i.harness,
    turn_id: clip(i.turnId, 256),
    run_id: clip(i.runId, 256),
    parent_run_id: i.parentRunId ? clip(i.parentRunId, 256) : null,
    agent_type: clip(i.agentType || 'unknown', 128),
    depth: int(i.depth),
    started_at: iso(start),
    ended_at: iso(end),
    ...(i.model ? { model: clip(i.model, 128) } : {}),
    ...(i.effort !== undefined ? { effort: i.effort ? clip(i.effort, 32) : null } : {}),
    usage: normalizeUsage(i.usage),
    phases_ms: phasesOf(i.phases),
    ...(i.tools ? { tools: normalizeTools(i.tools) } : {}),
    ...usageOf(i),
    outcome: normalizeOutcome(i.outcome),
    ...extOf(i),
  };
}

/** Patch revising a turn's outcome. `at` = time of the deciding signal (next prompt, session end). */
export function turnOutcomeEvent(i: Common & { turnId: string; outcome: Outcome; at: TimeInput }): TurnOutcomeEvent {
  const o = normalizeOutcome(i.outcome);
  return {
    event_id: id(i, `turn_outcome|${i.turnId}|${o.status}|${o.signals.join(',')}|${o.provisional}`, toMs(i.at)),
    type: 'turn_outcome',
    harness: i.harness,
    turn_id: clip(i.turnId, 256),
    outcome: o,
    ...extOf(i),
  };
}

/** Collapses whitespace and truncates to 140 chars (with an ellipsis). Empty → null. */
export function cleanSummaryText(s: string): string | null {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length <= MAX_SUMMARY_LENGTH ? t : `${t.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

/** Patch attaching the locally generated summary. Returns null when the summary is empty. */
export function turnSummaryEvent(i: Common & { turnId: string; summary: string; at?: TimeInput }): TurnSummaryEvent | null {
  const summary = cleanSummaryText(i.summary);
  if (!summary) return null;
  return {
    event_id: id(i, `turn_summary|${i.turnId}`, toMs(i.at ?? Date.now())),
    type: 'turn_summary',
    harness: i.harness,
    turn_id: clip(i.turnId, 256),
    summary,
    ...extOf(i),
  };
}

/** `reason`: e.g. `exit`, `clear`, `logout`, `crashed` (swept), `other`. */
export function sessionEndEvent(i: Common & { sessionId: string; reason: string; at: TimeInput }): SessionEndEvent {
  const at = toMs(i.at);
  return {
    event_id: id(i, `session_end|${i.sessionId}`, at),
    type: 'session_end',
    harness: i.harness,
    session_id: clip(i.sessionId, 256),
    reason: clip(i.reason || 'other', 64),
    at: iso(at),
    ...extOf(i),
  };
}
