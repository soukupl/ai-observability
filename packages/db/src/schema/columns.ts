import { bigint, integer, jsonb, text, timestamp, uuid, boolean } from 'drizzle-orm/pg-core';
import { outcomeEnum } from './enums.js';

/** Shared column builders. Every builder returns fresh column objects (Drizzle columns are per-table). */
export const pk = () => uuid('id').primaryKey().defaultRandom();
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const createdAt = () => tstz('created_at').notNull().defaultNow();
export const updatedAt = () => tstz('updated_at').notNull().defaultNow();

const counter = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);

/**
 * Token counters (de-duplicated per API response by the collector, BRIEF §5.3). Conventions:
 * input_tokens excludes cache reads/writes; reasoning_tokens is the subset of output_tokens spent on
 * thinking (informational, never added to output for cost).
 */
export const tokenColumns = () => ({
  inputTokens: counter('input_tokens'),
  outputTokens: counter('output_tokens'),
  cacheReadTokens: counter('cache_read_tokens'),
  cacheWriteTokens: counter('cache_write_tokens'),
  reasoningTokens: counter('reasoning_tokens'),
  requests: counter('requests'),
});

export type PhasesMs = Partial<Record<string, number>>;
export type ToolCounts = Partial<Record<string, number>>;
/** Skill name → uses by source (plain or `sha256:` names, the deployment's project-naming mode). */
export type SkillCounts = Record<string, { model: number; user: number }>;
/** MCP server → tool → calls (plain or `sha256:` names). */
export type McpCounts = Record<string, Record<string, number>>;
/** MCP server → tool → errors / denied / latency (ms total and 5 histogram buckets). */
export type McpStats = Record<string, Record<string, { errors: number; denied: number; ms: number; buckets: number[] }>>;

/** Timing, phase, tool and outcome columns shared by turns and runs. No paths, prompts or code. */
export const workColumns = () => ({
  model: text('model'),
  effort: text('effort'),
  startedAt: tstz('started_at').notNull(),
  endedAt: tstz('ended_at').notNull(),
  durationMs: bigint('duration_ms', { mode: 'number' }).notNull().default(0),
  ...tokenColumns(),
  phasesMs: jsonb('phases_ms').$type<PhasesMs>().notNull().default({}),
  tools: jsonb('tools').$type<ToolCounts>().notNull().default({}),
  skills: jsonb('skills').$type<SkillCounts>().notNull().default({}),
  mcp: jsonb('mcp').$type<McpCounts>().notNull().default({}),
  mcpStats: jsonb('mcp_stats').$type<McpStats>().notNull().default({}),
  outcome: outcomeEnum('outcome').notNull().default('unknown'),
  outcomeSignals: jsonb('outcome_signals').$type<string[]>().notNull().default([]),
  outcomeProvisional: boolean('outcome_provisional').notNull().default(true),
  sourceEventId: text('source_event_id'),
});

export const count = (name: string) => integer(name).notNull().default(0);
