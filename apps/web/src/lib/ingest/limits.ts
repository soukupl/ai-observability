import { OUTCOME_SIGNALS, type IngestEvent, type Outcome, type UsageEntry } from '@ai-obs/protocol';

/*
 * Server-side value limits and privacy normalisation, applied to every event after wire validation
 * (the wire schema in @ai-obs/protocol accepts any non-negative safe integer and free-form strings).
 *
 * Why here: the DB columns are int4 / bigint and the dashboard and rollups sum bigint columns, so an
 * unbounded count lets one token break every aggregate of its company ("bigint out of range") or make
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

export function normalizeAgentType(agentType: string): string {
  return AGENT_TYPE_RE.test(agentType) ? agentType : 'other';
}

/** Known outcome signals only; unknown strings (possibly free text) are dropped, duplicates collapsed. */
export function normalizeOutcome(o: Outcome): Outcome {
  return { ...o, signals: [...new Set(o.signals.filter((s) => KNOWN_SIGNALS.has(s)))] };
}

/** Pure. Returns the event to apply (normalised copy) or the reason it is rejected. */
export function enforceLimits(event: IngestEvent): LimitResult {
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
      return { ok: true, event: { ...event, tools, outcome: normalizeOutcome(event.outcome) } };
    }
    case 'run': {
      const bad = usageProblem(event.usage) ?? phasesProblem(event.phases_ms);
      if (bad) return tooBig(bad);
      if (event.depth > MAX_RUN_DEPTH) return tooBig('depth');
      const tools = event.tools ? normalizeTools(event.tools) : undefined;
      if (tools === null) return tooBig('tools');
      return {
        ok: true,
        event: {
          ...event,
          agent_type: normalizeAgentType(event.agent_type),
          ...(tools ? { tools } : {}),
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
 * The event time window (DP-05, DP-08): a turn or run that started before the company's retention cutoff
 * (00:00 UTC, `retentionDays` ago: the same cutoff the worker's retention pass deletes by) would be
 * stored just to be deleted again and would make already-folded rollup days wrong; one that starts or
 * ends more than a day in the future would be counted in month-to-date budgets. Rejected with a reason.
 * Null = inside the window (or not a timed event).
 */
export function timeWindowProblem(event: IngestEvent, retentionDays: number, now: number): string | null {
  if (event.type !== 'turn' && event.type !== 'run') return null;
  const started = Date.parse(event.started_at);
  const ended = Date.parse(event.ended_at);
  if (started < startOfUtcDayMs(now) - retentionDays * 86_400_000) return 'started_at is before the retention window';
  if (started > now + MAX_FUTURE_MS || ended > now + MAX_FUTURE_MS) return 'timestamp is more than a day in the future';
  return null;
}
