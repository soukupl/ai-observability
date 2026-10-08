/** Current ingest schema version. Changes must be additive or bump this (ADR-0005). */
export const SCHEMA_VERSION = 1 as const;

/** Batch limits (BRIEF §6, ADR-0011). */
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 1_000_000;
export const MAX_SUMMARY_LENGTH = 140;

/** Skill / MCP usage limits per turn or run event (docs/briefs/skills-and-mcp-stats.md). */
export const MAX_USAGE_NAME_LENGTH = 128;
export const MAX_SKILLS_PER_EVENT = 100;
export const MAX_MCP_SERVERS_PER_EVENT = 50;
export const MAX_MCP_TOOLS_PER_SERVER = 100;

/**
 * MCP call latency buckets (upper bounds in ms; the last bucket is open): < 1 s, 1–5 s, 5–30 s, 30–120 s, > 120 s
 * (docs/briefs/mcp-reliability.md).
 */
export const MCP_LATENCY_BUCKETS_MS = [1_000, 5_000, 30_000, 120_000] as const;

/** How a skill was started: picked up by the model (Skill tool) or typed by the user (`/name`). */
export const SKILL_SOURCES = ['model', 'user'] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

/** Agent flow (ADR-0020): kinds of edges between runs of one turn, and the incoming edges one run event may carry. */
export const RUN_LINK_KINDS = ['item', 'sequence'] as const;
export type RunLinkKind = (typeof RUN_LINK_KINDS)[number];
export const MAX_RUN_LINKS = 32;
/** Highest `stage_index` of a run (a phase ordinal inside one orchestration). */
export const MAX_STAGE_INDEX = 10_000;

/**
 * Reported phases (BRIEF §5.4). `delegating` time is deliberately absent: waiting for
 * sub-agents is excluded from the parent run and counted in the child run instead.
 */
export const PHASES = [
  'thinking',
  'exploring',
  'coding',
  'documenting',
  'testing',
  'validating',
  'other',
] as const;
export type Phase = (typeof PHASES)[number];

export const OUTCOME_STATUSES = ['success', 'failed', 'abandoned', 'unknown'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** Known outcome signals (BRIEF §5.5). The wire format accepts any short string for forward compatibility. */
export const OUTCOME_SIGNALS = [
  'tests_passed',
  'tests_failed',
  'validate_passed',
  'validate_failed',
  'stop_failure',
  'user_interrupt',
  'next_prompt_correction',
  'next_turn_revert',
  'no_failure_signal',
] as const;
export type OutcomeSignal = (typeof OUTCOME_SIGNALS)[number];

/** Harnesses with a v1 collector adapter. Unknown harness values are still accepted (BRIEF §6). */
export const HARNESSES = ['claude-code', 'codex'] as const;
export type KnownHarness = (typeof HARNESSES)[number];

export const EVENT_TYPES = [
  'session_start',
  'turn',
  'run',
  'turn_outcome',
  'turn_summary',
  'session_end',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const PROJECT_NAMING_MODES = ['plain', 'hashed'] as const;
export type ProjectNamingMode = (typeof PROJECT_NAMING_MODES)[number];

/** Ingest token prefixes (ADR-0007). */
export const USER_TOKEN_PREFIX = 'aiobs_u_' as const;
export const TEAM_TOKEN_PREFIX = 'aiobs_t_' as const;
export const TOKEN_PREFIXES = { user: USER_TOKEN_PREFIX, team: TEAM_TOKEN_PREFIX } as const;
export type TokenKind = keyof typeof TOKEN_PREFIXES;

/** Environment variable that marks the collector's own summarizer child process (recursion guard, BRIEF §5.6). */
export const SUMMARIZING_ENV = 'AI_OBS_SUMMARIZING' as const;
