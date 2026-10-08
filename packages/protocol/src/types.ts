import type { z } from 'zod';
import type { batchEnvelope, collectorConfigResponse, ingestResponse } from './batch.js';
import type {
  ingestEvent,
  runEvent,
  runLink,
  sessionEndEvent,
  sessionStartEvent,
  turnEvent,
  turnOutcomeEvent,
  turnSummaryEvent,
} from './events.js';
import type { mcp, mcpStats, outcome, phasesMs, project, skills, usageEntry } from './primitives.js';

export type UsageEntry = z.infer<typeof usageEntry>;
export type PhasesMs = z.infer<typeof phasesMs>;
export type Outcome = z.infer<typeof outcome>;
export type ProjectRef = z.infer<typeof project>;
export type SkillCounts = z.infer<typeof skills>;
export type McpCounts = z.infer<typeof mcp>;
export type McpStats = z.infer<typeof mcpStats>;

export type SessionStartEvent = z.infer<typeof sessionStartEvent>;
export type TurnEvent = z.infer<typeof turnEvent>;
export type RunEvent = z.infer<typeof runEvent>;
/** One incoming edge of a run (ADR-0020). */
export type RunLink = z.infer<typeof runLink>;
export type TurnOutcomeEvent = z.infer<typeof turnOutcomeEvent>;
export type TurnSummaryEvent = z.infer<typeof turnSummaryEvent>;
export type SessionEndEvent = z.infer<typeof sessionEndEvent>;
export type IngestEvent = z.infer<typeof ingestEvent>;
/** What a collector sends (defaults not yet applied). */
export type IngestEventInput = z.input<typeof ingestEvent>;

export type BatchEnvelope = z.infer<typeof batchEnvelope>;
/** A full batch as sent on the wire. */
export type IngestBatchInput = Omit<z.input<typeof batchEnvelope>, 'events'> & {
  events: IngestEventInput[];
};
export type IngestResponse = z.infer<typeof ingestResponse>;
export type RejectedEvent = IngestResponse['rejected'][number];
export type CollectorConfigResponse = z.infer<typeof collectorConfigResponse>;
