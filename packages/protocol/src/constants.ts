/** Current ingest schema version. Changes must be additive or bump this (ADR-0005). */
export const SCHEMA_VERSION = 1 as const;

/** Batch limits (BRIEF §6, ADR-0011). */
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 1_000_000;
export const MAX_SUMMARY_LENGTH = 140;

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
