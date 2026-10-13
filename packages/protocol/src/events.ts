import { z } from 'zod';
import { MAX_RUN_LINKS, MAX_STAGE_INDEX, RUN_LINK_KINDS, SESSION_TITLE_SOURCES } from './constants.js';
import {
  count,
  effort,
  ext,
  harness,
  mcp,
  mcpStats,
  model,
  nonEmptyId,
  outcome,
  phasesMs,
  project,
  shortText,
  skills,
  summary,
  timestamp,
  tools,
  ulid,
  usageEntry,
} from './primitives.js';

/** Fields every event carries (ADR-0005). */
const base = {
  event_id: ulid,
  harness,
  ext: ext.optional(),
};

const endsAfterStart = (e: { started_at: string; ended_at: string }) =>
  Date.parse(e.ended_at) >= Date.parse(e.started_at);
const endsAfterStartMsg = { message: 'ended_at must not be before started_at', path: ['ended_at'] };

export const sessionStartEvent = z.object({
  ...base,
  type: z.literal('session_start'),
  session_id: nonEmptyId,
  harness_version: shortText.optional(),
  project: project.optional(),
  at: timestamp,
});

export const turnEvent = z
  .object({
    ...base,
    type: z.literal('turn'),
    session_id: nonEmptyId,
    turn_id: nonEmptyId,
    started_at: timestamp,
    ended_at: timestamp,
    model,
    effort,
    usage: z.array(usageEntry).max(64),
    phases_ms: phasesMs,
    tools: tools.default({}),
    /** skills used by the main agent (optional: older collectors omit it) */
    skills: skills.optional(),
    /** MCP calls of the main agent (optional: older collectors omit it) */
    mcp: mcp.optional(),
    /** MCP errors and latency of the main agent (optional) */
    mcp_stats: mcpStats.optional(),
    files_touched: count.default(0),
    lines_added: count.default(0),
    lines_removed: count.default(0),
    outcome,
    phase_rules_version: z.int().positive(),
  })
  .refine(endsAfterStart, endsAfterStartMsg);

/** One incoming edge of a run (ADR-0020). */
export const runLink = z.object({ from_run_id: nonEmptyId, kind: z.enum(RUN_LINK_KINDS) });

export const runEvent = z
  .object({
    ...base,
    type: z.literal('run'),
    turn_id: nonEmptyId,
    run_id: nonEmptyId,
    parent_run_id: nonEmptyId.nullable(),
    agent_type: z.string().min(1).max(128),
    /** Logical kind of agent (`Explore`, `workflow:verify`); optional, additive to v1 (ADR-0019). */
    agent_group: z.string().min(1).max(128).optional(),
    /** Batch / workflow run that launched the agent (`wf_…`); optional, additive to v1 (ADR-0019). */
    orchestration_id: z.string().min(1).max(128).optional(),
    /** 0-based ordinal of the agent's phase inside its orchestration; optional, additive to v1 (ADR-0020). */
    stage_index: z.int().min(0).max(MAX_STAGE_INDEX).optional(),
    /** The item named by the label convention `<stage>:<item>`, slugged; optional, additive to v1 (ADR-0020). */
    flow_key: z.string().min(1).max(128).optional(),
    /**
     * Incoming edges: runs of the same turn whose result fed this run (`item`: same workflow item, earlier stage;
     * `sequence`: earlier sibling Agent-tool spawn). Carried by the target run; optional, additive to v1 (ADR-0020).
     */
    links: z.array(runLink).max(MAX_RUN_LINKS).optional(),
    depth: count,
    started_at: timestamp,
    ended_at: timestamp,
    model: model.optional(),
    effort: effort.optional(),
    usage: z.array(usageEntry).max(64),
    phases_ms: phasesMs,
    tools: tools.optional(),
    skills: skills.optional(),
    mcp: mcp.optional(),
    mcp_stats: mcpStats.optional(),
    outcome,
  })
  .refine(endsAfterStart, endsAfterStartMsg);

/** Patch: revises a turn's outcome (e.g. correction detected in the next prompt). */
export const turnOutcomeEvent = z.object({
  ...base,
  type: z.literal('turn_outcome'),
  turn_id: nonEmptyId,
  outcome,
});

/** Patch: attaches the locally generated ≤ 140-char summary to a turn. */
export const turnSummaryEvent = z.object({
  ...base,
  type: z.literal('turn_summary'),
  turn_id: nonEmptyId,
  summary,
});

/**
 * Patch: the session's title as the harness shows it (ADR-0026), e.g. Claude Code's `/rename` title (`custom`) or its
 * generated title (`ai`). Conversation-derived text like a turn summary, so it has the same limits.
 */
export const sessionTitleEvent = z.object({
  ...base,
  type: z.literal('session_title'),
  session_id: nonEmptyId,
  title: summary,
  source: z.enum(SESSION_TITLE_SOURCES),
});

export const sessionEndEvent = z.object({
  ...base,
  type: z.literal('session_end'),
  session_id: nonEmptyId,
  reason: z.string().min(1).max(64),
  at: timestamp,
});

export const ingestEvent = z.discriminatedUnion('type', [
  sessionStartEvent,
  turnEvent,
  runEvent,
  turnOutcomeEvent,
  turnSummaryEvent,
  sessionTitleEvent,
  sessionEndEvent,
]);
