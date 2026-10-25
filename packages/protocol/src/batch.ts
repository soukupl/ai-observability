import { z } from 'zod';
import {
  INGEST_WARNING_CODES,
  MAX_BATCH_EVENTS,
  PROJECT_NAMING_MODES,
  SCHEMA_VERSION,
  MAX_TEAM_REF_LENGTH,
  TOKEN_SOURCES,
  USER_KINDS,
} from './constants.js';
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
  /**
   * Retired (ADR-0035): servers no longer send it; kept so responses of older servers still validate. It was at most
   * one per session per batch, `team` echoing the session_start's `project.team` (ADR-0030 R2).
   */
  warnings: z
    .array(
      z.object({
        code: z.enum(INGEST_WARNING_CODES),
        team: z.string().min(1).max(MAX_TEAM_REF_LENGTH),
        session_id: z.string(),
      }),
    )
    .optional(),
});

/** Response of GET /api/v1/collector-config. */
export const collectorConfigResponse = z.object({
  project_naming: z.enum(PROJECT_NAMING_MODES),
  min_collector_version: z.string().min(1),
  /**
   * Stable per-deployment secret the collector HMACs project keys with (hashed remotes; SEC-11). Optional:
   * older servers do not send it and the collector falls back to plain SHA-256.
   */
  project_salt: z.string().min(16).max(256).optional(),
  /** The single deployment the token reports to. */
  deployment: z.object({ name: z.string().min(1), slug: z.string().min(1) }),
  /** The user the token identifies; `email` is null for a service user. */
  user: z.object({ email: z.string().min(3).nullable(), name: z.string(), kind: z.enum(USER_KINDS) }),
  /** Teams the user is a member of, in slug order. */
  teams: z.array(z.object({ slug: z.string().min(1), name: z.string().min(1) })),
  primary_team: z.string().nullable(),
  token: z.object({
    expires_at: z.iso.datetime({ offset: true }).nullable(),
    label: z.string().nullable(),
    source: z.enum(TOKEN_SOURCES),
  }),
});
