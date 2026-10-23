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
/** MCP latency bucket upper bounds (ms); the last of the 5 buckets is open. */
export const MCP_LATENCY_BUCKETS_MS = [1_000, 5_000, 30_000, 120_000] as const;
/** Incoming links a run event may carry (ADR-0020). */
export const MAX_RUN_LINKS = 32;
/** Upper bound of `stage_index`. */
export const MAX_STAGE_INDEX = 10_000;
export const USER_TOKEN_PREFIX = 'aiobs_u_' as const;
export const COMPANY_TOKEN_PREFIX = 'aiobs_c_' as const;
/** Removed prefix (ADR-0022), never accepted: kept only to recognise it in the "no longer exist" message and maskToken. */
export const LEGACY_TEAM_TOKEN_PREFIX = 'aiobs_t_' as const;
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
/** MCP errors / denials / latency per server × tool (`buckets`: 5 counts over MCP_LATENCY_BUCKETS_MS). */
export interface McpToolStats {
  errors: number;
  denied: number;
  ms: number;
  buckets: number[];
}
export type McpStats = Record<string, Record<string, McpToolStats>>;

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

/** Live status (ADR-0027): a main-agent prompt was submitted; the turn is working until its `turn` arrives. */
export interface TurnStartedEvent extends EventBase {
  type: 'turn_started';
  session_id: string;
  /** the turn's key when known at prompt time (Claude Code: prompt uuid; Codex: hook turn_id), else null */
  turn_id: string | null;
  /** ISO time the prompt-submit hook fired */
  started_at: string;
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
  mcp_stats?: McpStats;
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
  /** logical kind of agent (e.g. `Explore`, `workflow:build`) */
  agent_group?: string;
  /** batch / workflow run that launched the agent */
  orchestration_id?: string;
  /** 0-based ordinal of the agent's stage (workflow phase) inside its orchestration (ADR-0020) */
  stage_index?: number;
  /** the item the agent worked on (`<item>` of a `<stage>:<item>` label, slugged) */
  flow_key?: string;
  /** incoming edges: runs of the same turn whose result fed this run (≤ MAX_RUN_LINKS) */
  links?: RunLink[];
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
  mcp_stats?: McpStats;
  outcome: Outcome;
}

/** `item`: same orchestration and flow key, previous stage; `sequence`: previous sibling Agent-tool run. */
export type RunLinkKind = 'item' | 'sequence';
export interface RunLink {
  from_run_id: string;
  kind: RunLinkKind;
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

/** Where a session title comes from (ADR-0026): the user's `/rename` (`custom`) or the harness-generated one (`ai`). */
export type SessionTitleSource = 'custom' | 'ai';

export interface SessionTitleEvent extends EventBase {
  type: 'session_title';
  session_id: string;
  title: string;
  source: SessionTitleSource;
}

export interface SessionEndEvent extends EventBase {
  type: 'session_end';
  session_id: string;
  reason: string;
  at: string;
}

export type IngestEvent =
  | SessionStartEvent
  | TurnStartedEvent
  | TurnEvent
  | RunEvent
  | TurnOutcomeEvent
  | TurnSummaryEvent
  | SessionTitleEvent
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
   * it get plain sha256 keys.
   */
  project_salt?: string;
  /** The company the token reports to (ADR-0022); `slug` is the default token name. Optional: older servers omit it. */
  company?: { name: string; slug: string };
  /** The member a user token identifies; null for a company token. Optional like `company`. */
  user?: { email: string } | null;
}
