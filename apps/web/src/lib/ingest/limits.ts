import { createHash } from 'node:crypto';
import {
  OUTCOME_SIGNALS,
  type IngestEvent,
  type McpCounts,
  type McpStats,
  type Outcome,
  type ProjectNamingMode,
  type RunLink,
  type SkillCounts,
  type UsageEntry,
} from '@ai-obs/protocol';

/*
 * Server-side value limits and privacy normalisation, applied to every event after wire validation
 * (the wire schema in @ai-obs/protocol accepts any non-negative safe integer and free-form strings).
 *
 * Why here: the DB columns are int4 / bigint and the dashboard and rollups sum bigint columns, so an
 * unbounded count lets one token break every aggregate of the deployment ("bigint out of range") or make
 * valid-looking events fail at insert. And ADR-0008 (metadata only) is enforced by the official
 * collector alone; an older or third-party collector must not be able to store paths or internal
 * names in tool keys, agent types or outcome signals.
 *
 * Out-of-range numbers REJECT the event (clamping would silently falsify data). Free-text fields are
 * NORMALISED instead of rejected, so an older collector keeps working.
 */

export const INT4_MAX = 2_147_483_647;
/** Per usage entry and field. 64 entries × 1e10 stays far below 2^63, and so do sums over millions of events. */
export const MAX_TOKENS_PER_ENTRY = 10_000_000_000;
export const MAX_REQUESTS_PER_ENTRY = 10_000_000;
/** One phase of one turn: 24 hours. */
export const MAX_PHASE_MS = 86_400_000;
export const MAX_TOOL_CALLS = 1_000_000_000;
export const MAX_RUN_DEPTH = 1_000;
/** One skill or MCP tool in one turn / run. */
export const MAX_USAGE_CALLS = 1_000_000;
/** Total MCP latency of one tool in one turn / run: 1e12 ms (~31 years) keeps sums far below bigint. */
export const MAX_MCP_MS = 1_000_000_000_000;

export const TOOL_KEY_RE = /^[a-z0-9_]{1,64}$/;
export const AGENT_TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const KNOWN_SIGNALS: ReadonlySet<string> = new Set(OUTCOME_SIGNALS);

export type LimitResult = { ok: true; event: IngestEvent } | { ok: false; reason: string };

const tooBig = (field: string): LimitResult => ({ ok: false, reason: `${field} is out of range` });

function usageProblem(usage: readonly UsageEntry[]): string | null {
  for (const u of usage) {
    for (const f of ['input', 'output', 'cache_read', 'cache_write', 'reasoning'] as const) {
      if (u[f] > MAX_TOKENS_PER_ENTRY) return `usage.${f}`;
    }
    if (u.requests > MAX_REQUESTS_PER_ENTRY) return 'usage.requests';
  }
  return null;
}

function phasesProblem(phases: Record<string, number | undefined>): string | null {
  for (const [name, ms] of Object.entries(phases)) if (ms !== undefined && ms > MAX_PHASE_MS) return `phases_ms.${name}`;
  return null;
}

/** Tool category → count with keys restricted to `[a-z0-9_]{1,64}`; anything else is counted under `other`. Null when a count is out of range. */
export function normalizeTools(tools: Record<string, number>): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const [raw, n] of Object.entries(tools)) {
    const lower = raw.toLowerCase();
    // MCP tool names embed server and tool names: one category, like the collector's toolKey().
    const key = lower.startsWith('mcp__') ? 'mcp' : TOOL_KEY_RE.test(lower) ? lower : 'other';
    out[key] = (out[key] ?? 0) + n;
    if (out[key]! > MAX_TOOL_CALLS) return null;
  }
  return out;
}

const HASHED_NAME_RE = /^sha256:[0-9a-f]{64}$/;
const sha256Name = (input: string) => `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;

/**
 * Skill / MCP names in the deployment's project-naming mode. The collector hashes them on the machine; in
 * hashed mode a plain name (a collector with a stale config, or a third-party one) is hashed here the way
 * the collector does without a salt (`sha256:` + SHA-256 of `skill:<name>`, `mcp:<server>`,
 * `mcp:<server>/<tool>`), so the name is never stored.
 */
const usageKey = (name: string, input: string, naming: ProjectNamingMode) =>
  naming === 'hashed' && !HASHED_NAME_RE.test(name) ? sha256Name(input) : name;

/** Null when a count is out of range. */
export function normalizeSkills(skills: SkillCounts, naming: ProjectNamingMode): SkillCounts | null {
  const out: SkillCounts = {};
  for (const [name, c] of Object.entries(skills)) {
    if (c.model > MAX_USAGE_CALLS || c.user > MAX_USAGE_CALLS) return null;
    const key = usageKey(name, `skill:${name}`, naming);
    const cur = (out[key] ??= { model: 0, user: 0 });
    cur.model += c.model;
    cur.user += c.user;
  }
  return out;
}

/** Null when a count is out of range. */
export function normalizeMcp(mcp: McpCounts, naming: ProjectNamingMode): McpCounts | null {
  const out: McpCounts = {};
  for (const [server, tools] of Object.entries(mcp)) {
    const s = usageKey(server, `mcp:${server}`, naming);
    const dst = (out[s] ??= {});
    for (const [tool, n] of Object.entries(tools)) {
      if (n > MAX_USAGE_CALLS) return null;
      const t = usageKey(tool, `mcp:${server}/${tool}`, naming);
      dst[t] = (dst[t] ?? 0) + n;
    }
  }
  return out;
}

/** Null when a count is out of range. Names hashed like {@link normalizeMcp}. */
export function normalizeMcpStats(stats: McpStats, naming: ProjectNamingMode): McpStats | null {
  const out: McpStats = {};
  for (const [server, tools] of Object.entries(stats)) {
    const s = usageKey(server, `mcp:${server}`, naming);
    const dst = (out[s] ??= {});
    for (const [tool, x] of Object.entries(tools)) {
      if (x.errors > MAX_USAGE_CALLS || x.denied > MAX_USAGE_CALLS || x.ms > MAX_MCP_MS || x.buckets.some((b) => b > MAX_USAGE_CALLS)) return null;
      const t = usageKey(tool, `mcp:${server}/${tool}`, naming);
      const cur = (dst[t] ??= { errors: 0, denied: 0, ms: 0, buckets: [0, 0, 0, 0, 0] });
      cur.errors += x.errors;
      cur.denied += x.denied;
      cur.ms += x.ms;
      x.buckets.forEach((b, i) => (cur.buckets[i] = (cur.buckets[i] ?? 0) + b));
    }
  }
  return out;
}

/** `skills` / `mcp` / `mcp_stats` of a turn or run event, normalised; a string = the field that is out of range. */
function usageFields(
  e: { skills?: SkillCounts; mcp?: McpCounts; mcp_stats?: McpStats },
  naming: ProjectNamingMode,
): { skills?: SkillCounts; mcp?: McpCounts; mcp_stats?: McpStats } | string {
  const skills = e.skills ? normalizeSkills(e.skills, naming) : undefined;
  if (skills === null) return 'skills';
  const mcp = e.mcp ? normalizeMcp(e.mcp, naming) : undefined;
  if (mcp === null) return 'mcp';
  const stats = e.mcp_stats ? normalizeMcpStats(e.mcp_stats, naming) : undefined;
  if (stats === null) return 'mcp_stats';
  return { ...(skills ? { skills } : {}), ...(mcp ? { mcp } : {}), ...(stats ? { mcp_stats: stats } : {}) };
}

export function normalizeAgentType(agentType: string): string {
  return AGENT_TYPE_RE.test(agentType) ? agentType : 'other';
}

/** Longest stored `runs.agent_group` / `runs.orchestration_id` (the protocol cap, ADR-0019). */
export const MAX_AGENT_GROUP_LEN = 128;
const AGENT_GROUP_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * `agent_group` as stored: absent / blank → undefined (NULL); otherwise trimmed, clipped to 128 and, like
 * normalizeAgentType, anything path-like or free-text (characters outside `[A-Za-z0-9_.:-]`) → 'other'.
 * A group that is the run's agent type itself (Agent-tool sub-agents: group = type) goes through
 * normalizeAgentType, so both columns agree (a 65..128-character type is 'other' in both, not only in agent_type).
 */
export function normalizeAgentGroup(group: string | null | undefined, agentType?: string): string | undefined {
  const raw = group?.trim();
  if (!raw) return undefined;
  if (agentType !== undefined && raw === agentType.trim()) return normalizeAgentType(agentType);
  const g = raw.slice(0, MAX_AGENT_GROUP_LEN);
  return AGENT_GROUP_RE.test(g) ? g : 'other';
}

/**
 * `orchestration_id` as stored: an opaque id (`wf_…`, a UUID). Trimmed and clipped to 128; absent, blank or not
 * id-like (a path, free text) → undefined (NULL), since an id that is not an id carries no grouping value.
 */
export function normalizeOrchestrationId(id: string | null | undefined): string | undefined {
  const v = id?.trim().slice(0, MAX_AGENT_GROUP_LEN);
  return v && AGENT_GROUP_RE.test(v) ? v : undefined;
}

/**
 * `flow_key` as stored (ADR-0020): the slugged `<item>` of a `<stage>:<item>` label. Same rule as
 * normalizeOrchestrationId: trimmed, clipped to 128; absent, blank or path-like / free text → undefined (NULL).
 */
export function normalizeFlowKey(key: string | null | undefined): string | undefined {
  return normalizeOrchestrationId(key);
}

/**
 * Incoming `links` of a run as stored (ADR-0020): one edge per source × kind (first wins), and never a link from
 * the run to itself. Undefined when nothing is left.
 */
export function normalizeRunLinks(links: readonly RunLink[] | undefined, runId: string): RunLink[] | undefined {
  if (!links) return undefined;
  const seen = new Set<string>();
  const out: RunLink[] = [];
  for (const l of links) {
    if (l.from_run_id === runId) continue;
    const k = `${l.kind}:${l.from_run_id}`; // kind has no colon, so the key is unambiguous
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ from_run_id: l.from_run_id, kind: l.kind });
  }
  return out.length > 0 ? out : undefined;
}

/** Known outcome signals only; unknown strings (possibly free text) are dropped, duplicates collapsed. */
export function normalizeOutcome(o: Outcome): Outcome {
  return { ...o, signals: [...new Set(o.signals.filter((s) => KNOWN_SIGNALS.has(s)))] };
}

/**
 * Pure. Returns the event to apply (normalised copy) or the reason it is rejected. `naming` is the
 * deployment's project-naming mode (skill / MCP names are hashed in `hashed` mode).
 */
export function enforceLimits(event: IngestEvent, naming: ProjectNamingMode = 'plain'): LimitResult {
  switch (event.type) {
    case 'turn': {
      const bad =
        usageProblem(event.usage) ?? phasesProblem(event.phases_ms);
      if (bad) return tooBig(bad);
      if (event.files_touched > INT4_MAX) return tooBig('files_touched');
      if (event.lines_added > INT4_MAX) return tooBig('lines_added');
      if (event.lines_removed > INT4_MAX) return tooBig('lines_removed');
      if (event.phase_rules_version > INT4_MAX) return tooBig('phase_rules_version');
      const tools = normalizeTools(event.tools);
      if (!tools) return tooBig('tools');
      const used = usageFields(event, naming);
      if (typeof used === 'string') return tooBig(used);
      return { ok: true, event: { ...event, tools, ...used, outcome: normalizeOutcome(event.outcome) } };
    }
    case 'run': {
      const bad = usageProblem(event.usage) ?? phasesProblem(event.phases_ms);
      if (bad) return tooBig(bad);
      if (event.depth > MAX_RUN_DEPTH) return tooBig('depth');
      const tools = event.tools ? normalizeTools(event.tools) : undefined;
      if (tools === null) return tooBig('tools');
      const used = usageFields(event, naming);
      if (typeof used === 'string') return tooBig(used);
      const { agent_group: rawGroup, orchestration_id: rawOrch, flow_key: rawFlow, links: rawLinks, ...rest } = event;
      const agentGroup = normalizeAgentGroup(rawGroup, event.agent_type);
      const orchestrationId = normalizeOrchestrationId(rawOrch);
      const flowKey = normalizeFlowKey(rawFlow);
      const links = normalizeRunLinks(rawLinks, event.run_id);
      return {
        ok: true,
        event: {
          ...rest,
          agent_type: normalizeAgentType(event.agent_type),
          ...(agentGroup ? { agent_group: agentGroup } : {}),
          ...(orchestrationId ? { orchestration_id: orchestrationId } : {}),
          ...(flowKey ? { flow_key: flowKey } : {}),
          ...(links ? { links } : {}),
          ...(tools ? { tools } : {}),
          ...used,
          outcome: normalizeOutcome(event.outcome),
        },
      };
    }
    case 'turn_outcome':
      return { ok: true, event: { ...event, outcome: normalizeOutcome(event.outcome) } };
    default:
      return { ok: true, event };
  }
}

/** Events may be at most this far in the future (clock skew); further ones are rejected (DP-05/DP-08). */
export const MAX_FUTURE_MS = 86_400_000;

const startOfUtcDayMs = (ms: number) => ms - (((ms % 86_400_000) + 86_400_000) % 86_400_000);

/**
 * The event time window (DP-05, DP-08): a turn, run or turn_started that started before the deployment's retention cutoff
 * (00:00 UTC, `retentionDays` ago: the same cutoff the worker's retention pass deletes by) would be
 * stored just to be deleted again and would make already-folded rollup days wrong; one that starts or
 * ends more than a day in the future would be counted in month-to-date budgets. Rejected with a reason.
 * Null = inside the window (or not a timed event).
 */
export function timeWindowProblem(event: IngestEvent, retentionDays: number, now: number): string | null {
  if (event.type !== 'turn' && event.type !== 'run' && event.type !== 'turn_started') return null;
  const started = Date.parse(event.started_at);
  const ended = event.type === 'turn_started' ? started : Date.parse(event.ended_at);
  if (started < startOfUtcDayMs(now) - retentionDays * 86_400_000) return 'started_at is before the retention window';
  if (started > now + MAX_FUTURE_MS || ended > now + MAX_FUTURE_MS) return 'timestamp is more than a day in the future';
  return null;
}
