import { editFingerprint, isRevertCommand } from '../../analysis/outcome.js';
import type { PhaseOrDelegating, TimelineEntry } from '../../analysis/phases.js';
import { addMcpResult, addSkill } from '../../analysis/usage.js';
import type { McpStats, SkillCounts, UsageEntry } from '../../protocol-types.js';
import type { RolloutItem, TokenTotals } from './records.js';
import { parseExecOutput, pathHash, spawnedAgentIds, toolFacts } from './tools.js';

/**
 * Everything ai-obs keeps about one agent execution while it runs: the open main-agent turn or a
 * sub-agent thread. Plain JSON (it is persisted in the session state). Text fields (prompt, last
 * message) are local-only digest input.
 */
export interface RunAcc {
  startedAt: number;
  lastAt: number;
  model: string | null;
  effort: string | null;
  usage: UsageEntry[];
  timeline: TimelineEntry[];
  /** raw tool name → calls (MCP tools as `mcp__<server>__<tool>`) */
  tools: Record<string, number>;
  /** skills the model opened (SKILL.md reads), by plain name. Absent in older state. */
  skills?: SkillCounts;
  /** MCP errors / latency by plain server → tool (from McpToolCall items). Absent in older state. */
  mcpStats?: McpStats;
  toolNames: string[];
  pending: Record<string, { check: 'testing' | 'validating' | null; phase: PhaseOrDelegating; name: string }>;
  procs: Record<string, { phase: PhaseOrDelegating; check: 'testing' | 'validating' | null }>;
  lastCheck: { kind: 'testing' | 'validating'; exitCode: number } | null;
  files: string[];
  linesAdded: number;
  linesRemoved: number;
  fpAdded: string[];
  fpRemoved: string[];
  revertCmd: boolean;
  interrupted: boolean;
  error: boolean;
  prompt: string | null;
  lastMessage: string | null;
  /** sub-agent thread ids spawned by this run */
  spawned: string[];
}

const MAX_TIMELINE = 20_000;
const MAX_FP = 5000;

export function newAcc(at: number, model: string | null, effort: string | null): RunAcc {
  return {
    startedAt: at, lastAt: at, model, effort, usage: [], timeline: [{ at, type: 'prompt' }], tools: {}, toolNames: [],
    pending: {}, procs: {}, lastCheck: null, files: [], linesAdded: 0, linesRemoved: 0, fpAdded: [], fpRemoved: [],
    revertCmd: false, interrupted: false, error: false, prompt: null, lastMessage: null, spawned: [],
  };
}

const push = (acc: RunAcc, e: TimelineEntry) => {
  if (acc.timeline.length < MAX_TIMELINE) acc.timeline.push(e);
};
const addUnique = (list: string[], values: Iterable<string>, max: number) => {
  const set = new Set(list);
  for (const v of values) if (set.size < max) set.add(v);
  return [...set];
};

/**
 * Token usage of one request = difference of two cumulative `total_token_usage` snapshots (or
 * `last_token_usage` when the totals went backwards, e.g. after a resume). Equal totals = a repeated
 * snapshot → null. Codex counts cached input INSIDE input_tokens and reasoning inside output_tokens;
 * the ai-obs convention wants input WITHOUT cache, so input = input − cached − cache_write.
 */
export function usageDelta(prev: TokenTotals | null, item: { total: TokenTotals | null; last: TokenTotals | null }): TokenTotals | null {
  const { total, last } = item;
  if (total && prev) {
    if (total.total === prev.total && total.input === prev.input && total.output === prev.output) return null;
    const d: TokenTotals = {
      input: total.input - prev.input,
      cached: total.cached - prev.cached,
      cacheWrite: total.cacheWrite - prev.cacheWrite,
      output: total.output - prev.output,
      reasoning: total.reasoning - prev.reasoning,
      total: total.total - prev.total,
    };
    if (Object.values(d).every((v) => v >= 0)) return d;
    return last;
  }
  if (total) return total.total > 0 || total.input > 0 ? total : null;
  return last && (last.input > 0 || last.output > 0) ? last : null;
}

export function addUsage(acc: RunAcc, d: TokenTotals, model: string | null, effort: string | null): void {
  const m = model ?? acc.model ?? 'unknown';
  const e = effort ?? acc.effort ?? null;
  let row = acc.usage.find((u) => u.model === m && u.effort === e);
  if (!row) {
    row = { model: m, effort: e, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, requests: 0 };
    acc.usage.push(row);
  }
  row.input += Math.max(0, d.input - d.cached - d.cacheWrite);
  row.cache_read += d.cached;
  row.cache_write += d.cacheWrite;
  row.output += d.output;
  row.reasoning += d.reasoning;
  row.requests += 1;
}

/** Applies one rollout item (inside this run) to the accumulator. Token counts are handled by the caller. */
export function applyItem(acc: RunAcc, item: RolloutItem): void {
  acc.lastAt = Math.max(acc.lastAt, item.at);
  switch (item.kind) {
    case 'turn_context':
      if (item.model) acc.model = item.model;
      if (item.effort) acc.effort = item.effort;
      return;
    case 'user_prompt':
      if (acc.prompt === null && item.text) acc.prompt = item.text.slice(0, 2000);
      return;
    case 'agent_message':
      if (item.text) acc.lastMessage = item.text.slice(-2000);
      push(acc, { at: item.at, type: 'output' });
      return;
    case 'output':
      push(acc, { at: item.at, type: 'output' });
      return;
    case 'error':
      acc.error = true;
      return;
    case 'tool_call': {
      const f = toolFacts(item.name, item.args, item.input, (id) => acc.procs[id], isRevertCommand);
      acc.tools[item.name] = (acc.tools[item.name] ?? 0) + 1;
      if (f.skill) addSkill((acc.skills ??= {}), f.skill, 'model');
      if (!acc.toolNames.includes(item.name) && acc.toolNames.length < 30) acc.toolNames.push(item.name);
      acc.pending[item.callId] = { check: f.processId ? (acc.procs[f.processId]?.check ?? null) : f.check, phase: f.phase, name: item.name };
      if (f.revert) acc.revertCmd = true;
      if (f.patch) {
        acc.files = addUnique(acc.files, f.patch.files.map(pathHash), 10_000);
        acc.linesAdded += f.patch.added;
        acc.linesRemoved += f.patch.removed;
        const fp = editFingerprint(f.patch.edits);
        acc.fpAdded = addUnique(acc.fpAdded, fp.added, MAX_FP);
        acc.fpRemoved = addUnique(acc.fpRemoved, fp.removed, MAX_FP);
      }
      push(acc, { at: item.at, type: 'tool_call', id: item.callId, phase: f.phase });
      return;
    }
    case 'mcp_result':
      // Codex has no denial marker for MCP calls; a refused call shows up as failed.
      addMcpResult((acc.mcpStats ??= {}), item.server, item.tool, { error: item.error, denied: false, ms: item.ms });
      return;
    case 'tool_output': {
      const call = acc.pending[item.callId];
      delete acc.pending[item.callId];
      push(acc, { at: item.at, type: 'tool_result', id: item.callId });
      if (!call) return;
      if (call.name === 'spawn_agent') acc.spawned = addUnique(acc.spawned, spawnedAgentIds(item.output), 200);
      const { exitCode, runningId } = parseExecOutput(item.output);
      if (runningId && call.name !== 'write_stdin') acc.procs[runningId] = { phase: call.phase, check: call.check };
      if (exitCode !== null && call.check) acc.lastCheck = { kind: call.check, exitCode };
      return;
    }
    default:
      return;
  }
}
