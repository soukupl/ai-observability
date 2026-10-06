/**
 * Minimal copy of the ingest schema v1 (`@ai-obs/protocol`) for the collector. The collector has ZERO
 * runtime dependencies, so it cannot import zod; test/protocol-conformance.test.ts type-checks these
 * types against @ai-obs/protocol and validates builder output with its validateBatch().
 */
export const SCHEMA_VERSION = 1 as const;
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 1_000_000;
export const MAX_SUMMARY_LENGTH = 140;
export const MAX_USAGE_NAME_LENGTH = 128;
export const MAX_SKILLS_PER_EVENT = 100;
export const MAX_MCP_SERVERS_PER_EVENT = 50;
export const MAX_MCP_TOOLS_PER_SERVER = 100;
export const USER_TOKEN_PREFIX = 'aiobs_u_' as const;
export const TEAM_TOKEN_PREFIX = 'aiobs_t_' as const;
/** Recursion guard for the collector's own summarizer child process (BRIEF §5.6). */
export const SUMMARIZING_ENV = 'AI_OBS_SUMMARIZING' as const;

/** Reported phases. `delegating` is never reported: it is counted in the child run instead. */
export const PHASES = ['thinking', 'exploring', 'coding', 'documenting', 'testing', 'validating', 'other'] as const;
export type Phase = (typeof PHASES)[number];

export type OutcomeStatus = 'success' | 'failed' | 'abandoned' | 'unknown';
export type OutcomeSignal =
  | 'tests_passed'
  | 'tests_failed'
  | 'validate_passed'
  | 'validate_failed'
  | 'stop_failure'
  | 'user_interrupt'
  | 'next_prompt_correction'
  | 'next_turn_revert'
  | 'no_failure_signal';

export type HarnessName = 'claude-code' | 'codex';
export type ProjectNamingMode = 'plain' | 'hashed';

export interface UsageEntry {
  model: string;
  effort: string | null;
  /** fresh input tokens; excludes cache reads and writes */
  input: number;
  /** output tokens; includes reasoning */
  output: number;
  cache_read: number;
  cache_write: number;
  /** reasoning / thinking tokens (already part of `output`) */
  reasoning: number;
  /** distinct API responses */
  requests: number;
}

export type PhasesMs = Partial<Record<Phase, number>>;

export interface Outcome {
  status: OutcomeStatus;
  signals: string[];
  provisional: boolean;
}

export interface ProjectRef {
  /** normalized git remote (`github.com/acme/billing`) or `sha256:<64 hex>` — never a local path */
  key: string;
  name?: string;
}

/** How a skill was started: by the model (Skill tool / reading its SKILL.md) or typed by the user (`/name`). */
export type SkillSource = 'model' | 'user';
/** Skill name → uses by source. Names are plain or `sha256:<64 hex>` (company project-naming mode). */
export type SkillCounts = Record<string, { model: number; user: number }>;
/** MCP server → tool → calls. Names are plain or `sha256:<64 hex>` (company project-naming mode). */
export type McpCounts = Record<string, Record<string, number>>;

interface EventBase {
  event_id: string;
  harness: string;
  /** harness-specific extras; must not carry prompts, code, diffs or file paths */
  ext?: Record<string, unknown>;
}

export interface SessionStartEvent extends EventBase {
  type: 'session_start';
  session_id: string;
  harness_version?: string;
  project?: ProjectRef;
  at: string;
}

export interface TurnEvent extends EventBase {
  type: 'turn';
  session_id: string;
  turn_id: string;
  started_at: string;
  ended_at: string;
  model: string;
  effort: string | null;
  usage: UsageEntry[];
  phases_ms: PhasesMs;
  tools: Record<string, number>;
  skills?: SkillCounts;
  mcp?: McpCounts;
  files_touched: number;
  lines_added: number;
  lines_removed: number;
  outcome: Outcome;
  phase_rules_version: number;
}

export interface RunEvent extends EventBase {
  type: 'run';
  turn_id: string;
  run_id: string;
  parent_run_id: string | null;
  agent_type: string;
  depth: number;
  started_at: string;
  ended_at: string;
  model?: string;
  effort?: string | null;
  usage: UsageEntry[];
  phases_ms: PhasesMs;
  tools?: Record<string, number>;
  skills?: SkillCounts;
  mcp?: McpCounts;
  outcome: Outcome;
}

export interface TurnOutcomeEvent extends EventBase {
  type: 'turn_outcome';
  turn_id: string;
  outcome: Outcome;
}

export interface TurnSummaryEvent extends EventBase {
  type: 'turn_summary';
  turn_id: string;
  summary: string;
}

export interface SessionEndEvent extends EventBase {
  type: 'session_end';
  session_id: string;
  reason: string;
  at: string;
}

export type IngestEvent =
  | SessionStartEvent
  | TurnEvent
  | RunEvent
  | TurnOutcomeEvent
  | TurnSummaryEvent
  | SessionEndEvent;

export interface IngestBatch {
  schema: typeof SCHEMA_VERSION;
  collector: { name: string; version: string };
  machine: { id: string; os: string };
  identity: { git_email?: string };
  events: IngestEvent[];
}

export interface IngestResponse {
  accepted: number;
  duplicates: number;
  rejected: Array<{ event_id: string | null; reason: string }>;
}

export interface CollectorConfigResponse {
  project_naming: ProjectNamingMode;
  min_collector_version: string;
  /**
   * Per-company secret for hashed project keys (HMAC-SHA256 key). Optional: servers that do not send
   * it get plain sha256 keys. Collector-side contract, not yet in packages/protocol.
   */
  project_salt?: string;
}
