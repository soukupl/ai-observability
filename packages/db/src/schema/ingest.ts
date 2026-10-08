import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz } from './columns.js';
import { tokenKindEnum } from './enums.js';
import { companies, teams, users } from './tenancy.js';

/**
 * Collector tokens (ADR-0007, ADR-0022). Stored as a hash; `prefix` is the non-secret beginning shown in the UI.
 * Company tokens (`aiobs_c_`, user_id null; CI / bots / rollout, match users by git e-mail company-wide) and user
 * tokens (`aiobs_u_`, identify one member of one company; resolve only while the membership exists). No team
 * binding. Revocation is one-way (trigger).
 */
export const ingestTokens = pgTable(
  'ingest_tokens',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: tokenKindEnum('kind').notNull(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    hash: text('hash').notNull().unique(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
  },
  (t) => [
    index('ingest_tokens_company_idx').on(t.companyId),
    check('ingest_tokens_kind_user', sql`(${t.kind} = 'user') = (${t.userId} is not null)`),
  ],
);

/** A developer computer, identified by the random id generated at install. */
export const machines = pgTable(
  'machines',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    machineId: text('machine_id').notNull(),
    os: text('os'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    unique('machines_company_machine_uq').on(t.companyId, t.machineId),
    unique('machines_company_id_uq').on(t.companyId, t.id),
  ],
);

/** A codebase keyed by normalized git remote or `sha256:<hex>` (ADR-0008). Never a local path. */
export const projects = pgTable(
  'projects',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    displayName: text('display_name'),
    /** Admin mapping project → team; first rule of turn attribution (BRIEF §4). */
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    unique('projects_company_key_uq').on(t.companyId, t.key),
    unique('projects_company_id_uq').on(t.companyId, t.id),
    check('projects_key_not_path', sql`${t.key} !~ '^(/|~|[A-Za-z]:\\\\|\\.)'`),
  ],
);

/** De-duplication ledger of client event ids (ADR-0011); pruned after 30 days by the worker. */
export const ingestEvents = pgTable(
  'ingest_events',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
  },
  (t) => [
    unique('ingest_events_company_event_uq').on(t.companyId, t.eventId),
    index('ingest_events_received_idx').on(t.receivedAt),
  ],
);
