import { z } from 'zod';
import {
  count,
  effort,
  ext,
  harness,
  mcp,
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
    files_touched: count.default(0),
    lines_added: count.default(0),
    lines_removed: count.default(0),
    outcome,
    phase_rules_version: z.int().positive(),
  })
  .refine(endsAfterStart, endsAfterStartMsg);

export const runEvent = z
  .object({
    ...base,
    type: z.literal('run'),
    turn_id: nonEmptyId,
    run_id: nonEmptyId,
    parent_run_id: nonEmptyId.nullable(),
    agent_type: z.string().min(1).max(128),
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
  sessionEndEvent,
]);
