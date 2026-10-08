import { z } from 'zod';
import { MAX_BATCH_EVENTS, PROJECT_NAMING_MODES, SCHEMA_VERSION } from './constants.js';
import { shortText } from './primitives.js';

/**
 * Batch envelope. Events are validated one by one (see validateBatch) so that one bad event
 * is rejected individually instead of failing the whole batch.
 */
export const batchEnvelope = z.object({
  schema: z.literal(SCHEMA_VERSION),
  collector: z.object({ name: shortText, version: shortText }),
  machine: z.object({ id: z.uuid(), os: z.string().min(1).max(32) }),
  identity: z.object({ git_email: z.email().max(320).optional() }).default({}),
  events: z.array(z.unknown()).min(1).max(MAX_BATCH_EVENTS),
});

/** Response of POST /api/v1/ingest. */
export const ingestResponse = z.object({
  accepted: z.int().nonnegative(),
  duplicates: z.int().nonnegative(),
  rejected: z.array(z.object({ event_id: z.string().nullable(), reason: z.string() })),
});

/** Response of GET /api/v1/collector-config. */
export const collectorConfigResponse = z.object({
  project_naming: z.enum(PROJECT_NAMING_MODES),
  min_collector_version: z.string().min(1),
  /**
   * Stable per-company secret the collector HMACs project keys with (hashed remotes; SEC-11). Optional:
   * older servers do not send it and the collector falls back to plain SHA-256.
   */
  project_salt: z.string().min(16).max(256).optional(),
  /**
   * The company the token reports to (ADR-0022); the collector stores the token under `slug` by default.
   * Optional so a collector tolerates older servers; this server always sends it.
   */
  company: z.object({ name: z.string().min(1), slug: z.string().min(1) }).optional(),
  /** The member a user token identifies; null for a company token. Optional like `company`. */
  user: z.object({ email: z.string().min(3) }).nullable().optional(),
});
