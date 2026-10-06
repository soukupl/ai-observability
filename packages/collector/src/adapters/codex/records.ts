/**
 * Rollout line → normalized item. Only the fields ai-obs needs are kept; see FORMAT.md for the raw
 * format. Prompt / message text is kept ONLY for local use (correction check, summary digest) and is
 * never put into an event.
 */
export interface TokenTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface SessionMeta {
  sessionId: string;
  startedAt: number;
  cwd: string | null;
  cliVersion: string | null;
  /** spawned by another thread (multi-agent sub-agent / review / compact helper) */
  isSubagent: boolean;
  parentThreadId: string | null;
  depth: number | null;
  agentType: string | null;
}

export type RolloutItem =
  | { kind: 'meta'; at: number; meta: SessionMeta }
  | { kind: 'turn_started'; at: number; turnId: string }
  | { kind: 'turn_context'; at: number; turnId: string | null; model: string | null; effort: string | null }
  | { kind: 'user_prompt'; at: number; text: string }
  | { kind: 'agent_message'; at: number; text: string }
  | { kind: 'output'; at: number }
  | { kind: 'tool_call'; at: number; callId: string; name: string; args: Record<string, unknown> | null; input: string | null }
  | { kind: 'tool_output'; at: number; callId: string; output: string }
  | { kind: 'token_count'; at: number; total: TokenTotals | null; last: TokenTotals | null }
  | { kind: 'turn_complete'; at: number; turnId: string | null; lastMessage: string | null }
  | { kind: 'turn_aborted'; at: number; turnId: string | null; reason: string | null }
  | { kind: 'error'; at: number };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function totals(v: unknown): TokenTotals | null {
  const o = obj(v);
  if (!o) return null;
  return {
    input: num(o.input_tokens),
    cached: num(o.cached_input_tokens),
    cacheWrite: num(o.cache_write_input_tokens),
    output: num(o.output_tokens),
    reasoning: num(o.reasoning_output_tokens),
    total: num(o.total_tokens),
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : str(obj(c)?.text) ?? ''))
    .filter(Boolean)
    .join('\n');
}

/** Injected context Codex records as "user" messages (AGENTS.md, environment, skills, …). */
const INJECTED_RE = /^\s*(<[a-z_]+[\s>]|# AGENTS\.md instructions)/i;

function parseArgs(raw: unknown): Obj | null {
  if (obj(raw)) return raw as Obj;
  if (typeof raw !== 'string') return null;
  try {
    return obj(JSON.parse(raw));
  } catch {
    return null;
  }
}

function outputText(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = obj(v);
  if (o && typeof o.content === 'string') return o.content;
  if (o) return JSON.stringify(o);
  return Array.isArray(v) ? textOf(v) : '';
}

/**
 * Sub-agent source. Codex serializes SessionSource as a string ("cli", "vscode", "exec", …) or, for
 * spawned threads, {"subagent": {"thread_spawn": {"parent_thread_id", "depth", "agent_nickname",
 * "agent_role"}}} / {"subagent": "review" | "compact" | …}.
 */
function subagentOf(p: Obj): Pick<SessionMeta, 'isSubagent' | 'parentThreadId' | 'depth' | 'agentType'> {
  const source = obj(p.source);
  const sub = source ? (source.subagent ?? source.sub_agent ?? source.SubAgent) : undefined;
  const spawn = obj(obj(sub)?.thread_spawn ?? obj(sub)?.ThreadSpawn);
  const threadSource = str(p.thread_source);
  const parent = str(spawn?.parent_thread_id) ?? str(p.parent_thread_id) ?? null;
  const isSubagent = sub !== undefined || parent !== null || (threadSource !== null && /sub.?agent|spawn/i.test(threadSource));
  const depth = typeof spawn?.depth === 'number' ? spawn.depth : null;
  const agentType = str(spawn?.agent_role) ?? str(p.agent_role) ?? (typeof sub === 'string' ? sub : null);
  return { isSubagent, parentThreadId: parent, depth, agentType };
}

/** Parses one rollout line. Unknown / irrelevant lines → null. Never throws. */
export function parseRolloutLine(line: string): RolloutItem | null {
  let r: Obj | null;
  try {
    r = obj(JSON.parse(line));
  } catch {
    return null;
  }
  if (!r) return null;
  const at = Date.parse(String(r.timestamp ?? ''));
  if (!Number.isFinite(at)) return null;
  const p = obj(r.payload) ?? {};
  const ptype = str(p.type);

  switch (r.type) {
    case 'session_meta': {
      const sessionId = str(p.id) ?? str(p.session_id);
      if (!sessionId) return null;
      const started = Date.parse(String(p.timestamp ?? ''));
      return {
        kind: 'meta',
        at,
        meta: { sessionId, startedAt: Number.isFinite(started) ? started : at, cwd: str(p.cwd), cliVersion: str(p.cli_version), ...subagentOf(p) },
      };
    }
    case 'turn_context': {
      const settings = obj(obj(p.collaboration_mode)?.settings);
      return {
        kind: 'turn_context',
        at,
        turnId: str(p.turn_id),
        model: str(p.model) ?? str(settings?.model),
        effort: str(p.effort) ?? str(p.reasoning_effort) ?? str(settings?.reasoning_effort),
      };
    }
    case 'event_msg':
      return eventMsg(p, ptype, at);
    case 'response_item':
      return responseItem(p, ptype, at);
    default:
      return null;
  }
}

function eventMsg(p: Obj, type: string | null, at: number): RolloutItem | null {
  switch (type) {
    case 'task_started':
    case 'turn_started': {
      const turnId = str(p.turn_id);
      return turnId ? { kind: 'turn_started', at, turnId } : null;
    }
    case 'task_complete':
    case 'turn_complete':
      return { kind: 'turn_complete', at, turnId: str(p.turn_id), lastMessage: str(p.last_agent_message) };
    case 'turn_aborted':
      return { kind: 'turn_aborted', at, turnId: str(p.turn_id), reason: str(p.reason) };
    case 'token_count': {
      const info = obj(p.info);
      return info ? { kind: 'token_count', at, total: totals(info.total_token_usage), last: totals(info.last_token_usage) } : null;
    }
    case 'error':
      return { kind: 'error', at };
    // legacy (un-migrated) rollouts
    case 'user_message':
      return { kind: 'user_prompt', at, text: str(p.message) ?? '' };
    case 'agent_message':
      return { kind: 'agent_message', at, text: str(p.message) ?? '' };
    case 'item_completed': {
      const item = obj(p.item);
      if (item?.type === 'UserMessage') return { kind: 'user_prompt', at, text: textOf(item.content) };
      if (item?.type === 'AgentMessage') return { kind: 'agent_message', at, text: textOf(item.content) };
      return null;
    }
    default:
      return null;
  }
}

function responseItem(p: Obj, type: string | null, at: number): RolloutItem | null {
  switch (type) {
    case 'reasoning':
      return { kind: 'output', at };
    case 'message':
      return p.role === 'assistant' ? { kind: 'output', at } : null;
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call':
    case 'tool_search_call':
    case 'web_search_call': {
      const callId = str(p.call_id) ?? str(p.id) ?? `${type}@${at}`;
      const ns = str(p.namespace);
      let name = str(p.name) ?? (type === 'local_shell_call' ? 'local_shell' : type === 'tool_search_call' ? 'tool_search' : type === 'web_search_call' ? 'web_search' : 'unknown');
      if (ns && /^mcp/i.test(ns)) name = `mcp__${ns.replace(/^mcp_*/i, '')}__${name}`;
      const args = type === 'local_shell_call' ? obj(p.action) : parseArgs(p.arguments);
      return { kind: 'tool_call', at, callId, name, args, input: str(p.input) };
    }
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output': {
      const callId = str(p.call_id);
      return callId ? { kind: 'tool_output', at, callId, output: outputText(p.output) } : null;
    }
    default:
      return null;
  }
}

/** Real user prompt (not injected context). */
export const isRealPrompt = (text: string) => Boolean(text.trim()) && !INJECTED_RE.test(text);
