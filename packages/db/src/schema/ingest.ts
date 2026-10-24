import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz } from './columns.js';
import { deviceCodeStatusEnum, tokenSourceEnum } from './enums.js';
import { teams, users } from './tenancy.js';

/**
 * Collector tokens (ADR-0029). Every token belongs to one user — a person or a service user — and resolves only while
 * that user has a membership, is not revoked and has not expired (lookup_ingest_token). Stored as a hash; `prefix`
 * (`aiobs_u_…`) is the non-secret beginning shown in the UI. `source` = `device` (minted by device_exchange for an
 * approved `ai-obs login`, expires after 90 days, `label` = the client name) or `manual` (made in the dashboard with a
 * lifetime of 30 / 90 / 365 days or none). Revocation is one-way (trigger).
 */
export const ingestTokens = pgTable(
  'ingest_tokens',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    source: tokenSourceEnum('source').notNull().default('manual'),
    /** The client name of a device login (the machine's hostname); null for most manual tokens. */
    label: text('label'),
    prefix: text('prefix').notNull(),
    hash: text('hash').notNull().unique(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    /** null = no expiry (manual tokens only). */
    expiresAt: tstz('expires_at'),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [index('ingest_tokens_user_idx').on(t.userId)],
);

/**
 * Device-login codes (ADR-0029, brief Appendix B). Created by an unauthenticated `POST /api/v1/device/code`
 * (device_create_code), approved or denied by a signed-in person on `/device`, exchanged once for a token by the
 * polling CLI (device_exchange). Only the sha256 of the device code is stored; `user_code` is the 8 letters the user
 * types (stored without the dash). Accessed only through the device_* SECURITY DEFINER functions.
 */
export const deviceCodes = pgTable(
  'device_codes',
  {
    id: pk(),
    deviceCodeHash: text('device_code_hash').notNull().unique(),
    userCode: text('user_code').notNull(),
    clientName: text('client_name').notNull(),
    clientVersion: text('client_version'),
    requesterIp: text('requester_ip'),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
    status: deviceCodeStatusEnum('status').notNull().default('pending'),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    tokenId: uuid('token_id').references(() => ingestTokens.id, { onDelete: 'set null' }),
    lastPolledAt: tstz('last_polled_at'),
  },
  (t) => [
    uniqueIndex('device_codes_open_user_code_uq').on(t.userCode).where(sql`${t.status} in ('pending', 'approved')`),
    index('device_codes_expires_idx').on(t.expiresAt),
    check('device_codes_user_code_format', sql`${t.userCode} ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$'`),
    check('device_codes_client_name_len', sql`char_length(${t.clientName}) between 1 and 200`),
  ],
);

/** A developer computer, identified by the random id generated at install. */
export const machines = pgTable(
  'machines',
  {
    id: pk(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    machineId: text('machine_id').notNull(),
    os: text('os'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [unique('machines_machine_uq').on(t.machineId)],
);

/** A codebase keyed by normalized git remote or `sha256:<hex>` (ADR-0008). Never a local path. */
export const projects = pgTable(
  'projects',
  {
    id: pk(),
    key: text('key').notNull(),
    displayName: text('display_name'),
    /** Admin mapping project → team; first rule of team resolution, overrides the repository's dot file (ADR-0030). */
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [unique('projects_key_uq').on(t.key), check('projects_key_not_path', sql`${t.key} !~ '^(/|~|[A-Za-z]:\\\\|\\.)'`)],
);

/** De-duplication ledger of client event ids (ADR-0011); pruned after 30 days by the worker. */
export const ingestEvents = pgTable(
  'ingest_events',
  {
    id: pk(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
  },
  (t) => [unique('ingest_events_event_uq').on(t.eventId), index('ingest_events_received_idx').on(t.receivedAt)],
);
