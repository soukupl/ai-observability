import { readFileSync } from 'node:fs';
import { provisionalOutcome } from '../../analysis/outcome.js';
import { attributeTime } from '../../analysis/phases.js';
import { primaryModel } from '../../analysis/tokens.js';
import { mcpFromTools } from '../../analysis/usage.js';
import { countTools, runEvent } from '../../events.js';
import type { RunEvent, UsageEntry } from '../../protocol-types.js';
import { addUsage, applyItem, newAcc, usageDelta, type RunAcc } from './accumulator.js';
import { locateRollout } from './locate.js';
import { parseRolloutLine, type RolloutItem, type SessionMeta, type TokenTotals } from './records.js';

/** Tool counts by protocol tool key (mcp__* → mcp). */
export function toolCounts(tools: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(tools)) {
    for (const [k, v] of Object.entries(countTools([name]))) out[k] = (out[k] ?? 0) + v * n;
  }
  return out;
}

export function readRolloutItems(path: string): RolloutItem[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: RolloutItem[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const item = parseRolloutLine(line);
    if (item) out.push(item);
  }
  return out;
}

export interface ChildThread {
  meta: SessionMeta | null;
  acc: RunAcc;
  endedAt: number;
}

/**
 * A sub-agent thread is its own rollout (session_meta.source = {subagent: {thread_spawn: {…}}}).
 * The WHOLE thread becomes one run: all its turns (a follow-up task included) are summed.
 */
export function buildChildThread(items: readonly RolloutItem[]): ChildThread | null {
  let meta: SessionMeta | null = null;
  let acc: RunAcc | null = null;
  let lastTotal: TokenTotals | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  for (const item of items) {
    if (item.kind === 'meta') {
      meta ??= item.meta;
      continue;
    }
    if (item.kind === 'turn_context') {
      model = item.model ?? model;
      effort = item.effort ?? effort;
    }
    if (!acc && (item.kind === 'turn_started' || item.kind === 'turn_context')) acc = newAcc(item.at, model, effort);
    if (!acc) continue;
    if (item.kind === 'token_count') {
      const d = usageDelta(lastTotal, item);
      if (item.total) lastTotal = item.total;
      if (d) addUsage(acc, d, model, effort);
      acc.lastAt = Math.max(acc.lastAt, item.at);
      continue;
    }
    if (item.kind === 'turn_aborted') acc.interrupted = true;
    if (item.kind === 'turn_complete') {
      acc.interrupted = false;
      if (item.lastMessage) acc.lastMessage = item.lastMessage;
      acc.lastAt = Math.max(acc.lastAt, item.at);
      acc.timeline.push({ at: item.at, type: 'output' });
      continue;
    }
    if (item.kind === 'turn_started') {
      acc.timeline.push({ at: item.at, type: 'prompt' });
      acc.lastAt = Math.max(acc.lastAt, item.at);
      continue;
    }
    applyItem(acc, item);
  }
  if (!acc) return null;
  return { meta, acc, endedAt: acc.lastAt };
}

export interface ResolvedChildren {
  runs: RunEvent[];
  /** own usage of every resolved descendant thread, by thread id */
  usage: Record<string, UsageEntry[]>;
  /** ids whose rollout was not found (yet) */
  missing: string[];
}

/**
 * Resolves sub-agent threads (and, recursively, their own sub-agents) into run events attached to
 * the main turn `rootTurnId`. Direct children of the main agent get parent_run_id = null, depth 1.
 */
export function resolveChildren(input: {
  harness: string;
  home: string;
  rootTurnId: string;
  ids: readonly string[];
  /** hook-supplied agent types / transcript paths by thread id */
  hints?: Record<string, { agentType?: string | null; path?: string | null }>;
  maxDepth?: number;
}): ResolvedChildren {
  const out: ResolvedChildren = { runs: [], usage: {}, missing: [] };
  const seen = new Set<string>();
  const visit = (id: string, parentRunId: string | null, depth: number) => {
    if (seen.has(id) || depth > (input.maxDepth ?? 5)) return;
    seen.add(id);
    const path = locateRollout(id, { home: input.home, hint: input.hints?.[id]?.path ?? null });
    const child = path ? buildChildThread(readRolloutItems(path)) : null;
    if (!child) {
      out.missing.push(id);
      return;
    }
    const { acc, meta } = child;
    const main = primaryModel(acc.usage);
    out.usage[id] = acc.usage;
    out.runs.push(
      runEvent({
        harness: input.harness,
        turnId: input.rootTurnId,
        runId: id,
        parentRunId,
        agentType: meta?.agentType ?? input.hints?.[id]?.agentType ?? 'default',
        depth,
        startedAt: acc.startedAt,
        endedAt: child.endedAt,
        ...(main?.model ?? acc.model ? { model: main?.model ?? acc.model ?? undefined } : {}),
        effort: main ? main.effort : acc.effort,
        usage: acc.usage,
        phases: attributeTime(acc.timeline, child.endedAt),
        tools: toolCounts(acc.tools),
        skills: acc.skills,
        mcp: mcpFromTools(acc.tools),
        mcpStats: acc.mcpStats,
        outcome: provisionalOutcome({ stopFailure: acc.error, interrupted: acc.interrupted, lastCheck: acc.lastCheck }),
      }),
    );
    for (const grandchild of acc.spawned) visit(grandchild, id, depth + 1);
  };
  for (const id of input.ids) visit(id.toLowerCase(), null, 1);
  return out;
}
