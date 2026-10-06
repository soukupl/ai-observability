import { createHash } from 'node:crypto';
import type { EditFingerprint } from '../../analysis/outcome.js';
import { addPhaseTotals, attributeTime, emptyPhaseTotals, type PhaseTotals, type TimelineEntry } from '../../analysis/phases.js';
import { mergeUsage, sumUsage, type UsageRecord } from '../../analysis/tokens.js';
import { toolKey } from '../../events.js';
import type { UsageEntry } from '../../protocol-types.js';
import type { SlimEntry, ToolResultInfo } from './transcript.js';

/** Stored caps: state files stay small even for very long sessions. */
const MAX_IDS = 400;
const MAX_FP = 1000;
const MAX_FILE_KEYS = 500;

export interface CheckResult {
  kind: 'testing' | 'validating';
  exitCode: number;
}

/** `agentCalls` key of a Workflow launch (its sub-agents are linked to the key, not to a tool_use id). */
export const workflowKey = (runId: string) => `wf:${runId}`;
export const isWorkflowKey = (key: string | null | undefined): key is string => typeof key === 'string' && key.startsWith('wf:');

export interface AgentCall {
  /** subagent_type from the Agent / Task tool input */
  type: string | null;
  background: boolean;
  /** the tool result arrived and was not an async launch (the sub-agent finished inside the turn) */
  completed: boolean;
}

/**
 * Aggregated facts about one stretch of agent activity (a turn, a continuation of a turn, or a whole
 * sub-agent transcript). JSON-serializable and free of paths / content: it is kept in session state.
 */
export interface Agg {
  startedAt: number;
  endedAt: number;
  usage: UsageEntry[];
  /** API response ids already counted (de-duplication across transcript reads) */
  responseIds: string[];
  /** phase totals including `delegating` */
  phases: PhaseTotals;
  tools: Record<string, number>;
  /** distinct raw tool names in first-use order (digest input) */
  toolNames: string[];
  /** hashed paths of successfully edited files */
  fileKeys: string[];
  linesAdded: number;
  linesRemoved: number;
  fp: EditFingerprint;
  interrupted: boolean;
  lastCheck: CheckResult | null;
  /** Agent / Task tool calls by tool_use id */
  agentCalls: Record<string, AgentCall>;
  /** last assistant text (truncated; local digest only) */
  lastMessage: string;
  /** any assistant entry at all (incl. API error placeholders) */
  active: boolean;
}

const pathKey = (p: string) => createHash('sha256').update(p).digest('base64url').slice(0, 16);
const uniqCap = (xs: Iterable<string>, cap: number) => [...new Set(xs)].slice(-cap);

export function emptyAgg(at: number): Agg {
  return {
    startedAt: at,
    endedAt: at,
    usage: [],
    responseIds: [],
    phases: emptyPhaseTotals(),
    tools: {},
    toolNames: [],
    fileKeys: [],
    linesAdded: 0,
    linesRemoved: 0,
    fp: { added: [], removed: [] },
    interrupted: false,
    lastCheck: null,
    agentCalls: {},
    lastMessage: '',
    active: false,
  };
}

export interface AnalyzeOptions {
  /** start of the stretch; default: the first entry (a prompt for turns and sub-agents) */
  startAt?: number;
  /** responses already counted elsewhere (continuations) */
  skipResponseIds?: ReadonlySet<string>;
}

/**
 * Analyzes entries of one stretch in transcript order. Tokens: usage per assistant entry, de-duplicated
 * per API response (Claude Code writes one entry per content block, each repeating the usage). Phases:
 * the shared time-attribution rules over prompt / output / tool_call / tool_result moments.
 */
export function analyzeEntries(entries: readonly SlimEntry[], opts: AnalyzeOptions = {}): Agg {
  const first = entries[0];
  const start = opts.startAt ?? first?.at ?? 0;
  const agg = emptyAgg(start);
  const timeline: TimelineEntry[] = [{ at: start, type: 'prompt' }];
  const records: UsageRecord[] = [];
  const toolNames: string[] = [];
  const toolCalls: string[] = [];
  const pendingEdits = new Map<string, { filePath: string; estimate: Agg['fp'] | null; added: number; removed: number }>();
  const checks = new Map<string, CheckResult['kind']>();
  const files = new Set<string>();
  const fpAdded: string[] = [];
  const fpRemoved: string[] = [];
  let end = start;

  for (const e of entries) {
    if (e.k === 'stop') continue;
    end = Math.max(end, e.at);
    if (e.k === 'prompt') {
      if (e.at > start) timeline.push({ at: e.at, type: 'prompt' });
      continue;
    }
    if (e.k === 'interrupt') {
      agg.interrupted = true;
      timeline.push({ at: e.at, type: 'output' });
      continue;
    }
    if (e.k === 'assistant') {
      agg.active = true;
      if (e.usage && !(e.usage.responseId && opts.skipResponseIds?.has(e.usage.responseId))) records.push(e.usage);
      for (const b of e.blocks) {
        if (b.t === 'output') {
          timeline.push({ at: e.at, type: 'output' });
          if (b.text?.trim()) agg.lastMessage = b.text;
          continue;
        }
        timeline.push({ at: e.at, type: 'tool_call', id: b.id, phase: b.phase });
        toolCalls.push(b.name);
        toolNames.push(b.name);
        if (b.edit && b.filePath) pendingEdits.set(b.id, { filePath: b.filePath, estimate: b.edit.fp, added: b.edit.added, removed: b.edit.removed });
        if (b.phase === 'testing' || b.phase === 'validating') checks.set(b.id, b.phase);
        if (b.agent) agg.agentCalls[b.id] = { type: b.agent.type, background: b.agent.background, completed: false };
      }
      continue;
    }
    if (e.userInterrupt) agg.interrupted = true;
    for (const r of e.results) {
      timeline.push({ at: e.at, type: 'tool_result', id: r.id });
      applyResult(r);
    }
  }

  function applyResult(r: ToolResultInfo) {
    const edit = pendingEdits.get(r.id);
    if (edit && !r.isError) {
      const exact = r.edit;
      agg.linesAdded += exact ? exact.added : edit.added;
      agg.linesRemoved += exact ? exact.removed : edit.removed;
      const fp = exact?.fp ?? edit.estimate;
      if (fp) {
        fpAdded.push(...fp.added);
        fpRemoved.push(...fp.removed);
      }
      files.add(pathKey(edit.filePath));
    }
    pendingEdits.delete(r.id);
    const kind = checks.get(r.id);
    if (kind && r.exitCode !== null && !r.interrupted) agg.lastCheck = { kind, exitCode: r.exitCode };
    if (r.workflowRunId) agg.agentCalls[workflowKey(r.workflowRunId)] = { type: 'workflow', background: true, completed: false };
    const call = agg.agentCalls[r.id];
    if (call) call.completed = !r.isError && r.agentStatus !== 'async_launched' && !call.background;
  }

  agg.endedAt = end;
  agg.phases = attributeTime(timeline, end);
  agg.usage = sumUsage(records);
  agg.responseIds = uniqCap(records.flatMap((r) => (r.responseId ? [r.responseId] : [])), MAX_IDS);
  for (const n of toolCalls) agg.tools[toolKey(n)] = (agg.tools[toolKey(n)] ?? 0) + 1;
  agg.toolNames = [...new Set(toolNames)].slice(0, 30);
  agg.fileKeys = uniqCap(files, MAX_FILE_KEYS);
  agg.fp = { added: uniqCap(fpAdded, MAX_FP), removed: uniqCap(fpRemoved, MAX_FP) };
  return agg;
}

/** Adds a later stretch (continuation) to an earlier one. */
export function mergeAgg(a: Agg, b: Agg): Agg {
  const tools = { ...a.tools };
  for (const [k, v] of Object.entries(b.tools)) tools[k] = (tools[k] ?? 0) + v;
  const calls = { ...a.agentCalls, ...b.agentCalls };
  return {
    startedAt: Math.min(a.startedAt, b.startedAt),
    endedAt: Math.max(a.endedAt, b.endedAt),
    usage: mergeUsage(a.usage, b.usage),
    responseIds: uniqCap([...a.responseIds, ...b.responseIds], MAX_IDS),
    phases: addPhaseTotals(a.phases, b.phases),
    tools,
    toolNames: [...new Set([...a.toolNames, ...b.toolNames])].slice(0, 30),
    fileKeys: uniqCap([...a.fileKeys, ...b.fileKeys], MAX_FILE_KEYS),
    linesAdded: a.linesAdded + b.linesAdded,
    linesRemoved: a.linesRemoved + b.linesRemoved,
    fp: { added: uniqCap([...a.fp.added, ...b.fp.added], MAX_FP), removed: uniqCap([...a.fp.removed, ...b.fp.removed], MAX_FP) },
    interrupted: a.interrupted || b.interrupted,
    lastCheck: b.lastCheck ?? a.lastCheck,
    agentCalls: calls,
    lastMessage: b.lastMessage || a.lastMessage,
    active: a.active || b.active,
  };
}
