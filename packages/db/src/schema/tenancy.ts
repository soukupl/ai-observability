import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './columns.js';
import { memberRoleEnum, teamRoleEnum, userKindEnum } from './enums.js';
import { DEFAULT_DEPLOYMENT_SETTINGS, type DeploymentSettings } from './settings.js';

/**
 * The deployment itself (ADR-0028: one deployment = one company). Exactly one row, guarded by the unique index on
 * the constant `(true)`; migration 0018 creates it (from the remaining company, or with defaults on a fresh database).
 */
export const deployment = pgTable(
  'deployment',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    settings: jsonb('settings').$type<DeploymentSettings>().notNull().default(DEFAULT_DEPLOYMENT_SETTINGS),
    /**
     * Stable secret the collector HMACs hashed project keys with (SEC-11, ADR-0008). Served only to token holders
     * through lookup_ingest_token / collector-config; never shown in the dashboard.
     */
    projectSalt: text('project_salt')
      .notNull()
      .default(sql`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('deployment_singleton').on(sql`(true)`),
    check(
      'deployment_settings_valid',
      sql`${t.settings}->>'individualVisibility' in ('aggregates-only', 'full')
        and ${t.settings}->>'projectNaming' in ('plain', 'hashed')
        and jsonb_typeof(${t.settings}->'retentionDays') = 'number'
        and (${t.settings}->>'retentionDays')::numeric between 30 and 730
        and (${t.settings}->'runawayCostUsd' is null or (jsonb_typeof(${t.settings}->'runawayCostUsd') = 'number'
          and (${t.settings}->>'runawayCostUsd')::numeric between 1 and 100000))
        and (${t.settings}->'runawayHours' is null or (jsonb_typeof(${t.settings}->'runawayHours') = 'number'
          and (${t.settings}->>'runawayHours')::numeric between 0.5 and 72))`,
    ),
  ],
);

/**
 * A team. `slug` (ADR-0030) is what `.ai-obs.json` names: unique, 1–63 of a-z0-9-. Omit it on insert and the
 * database derives one from the name (trigger teams_fill_slug, '-2' … on a clash); it can be changed only until a
 * turn references the team (trigger teams_slug_immutable).
 */
export const teams = pgTable(
  'teams',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: text('slug')
      .notNull()
      .$defaultFn(() => ''),
    createdAt: createdAt(),
  },
  (t) => [
    unique('teams_name_uq').on(t.name),
    unique('teams_slug_uq').on(t.slug),
    check('teams_slug_format', sql`${t.slug} ~ '^[a-z0-9-]{1,63}$'`),
  ],
);

/**
 * An identity: a person (logs in; e-mail stored lower-case, unique) or a service user (Q9: CI, bots, shared machines;
 * no e-mail, never logs in, holds admin-made tokens). Access comes from `memberships`.
 */
export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text('email'),
    name: text('name'),
    kind: userKindEnum('kind').notNull().default('person'),
    lastLoginAt: tstz('last_login_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
    check('users_email_lower', sql`${t.email} = lower(${t.email})`),
    check('users_email_kind', sql`${t.kind} = 'service' or ${t.email} is not null`),
  ],
);

/**
 * Membership of a user in the deployment (ADR-0028): role and primary team. One per user; deleting it (admin_remove_member)
 * ends access but keeps the user's telemetry (ADR-0022 D1).
 */
export const memberships = pgTable(
  'memberships',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').notNull().default('member'),
    primaryTeamId: uuid('primary_team_id').references(() => teams.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [unique('memberships_user_uq').on(t.userId)],
);

export const teamMemberships = pgTable(
  'team_memberships',
  {
    id: pk(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** A team member must be a member of the deployment; goes with the membership. */
    userId: uuid('user_id')
      .notNull()
      .references(() => memberships.userId, { onDelete: 'cascade' }),
    role: teamRoleEnum('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [unique('team_memberships_team_user_uq').on(t.teamId, t.userId), index('team_memberships_user_idx').on(t.userId)],
);

/** Pending invitation; auto-accepted at the first login with the invited e-mail (ADR-0013, ADR-0028). */
export const invitations = pgTable(
  'invitations',
  {
    id: pk(),
    email: text('email').notNull(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    teamRole: teamRoleEnum('team_role').notNull().default('member'),
    /** The membership role the invitee gets (memberships.role). */
    role: memberRoleEnum('role').notNull().default('member'),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    createdAt: createdAt(),
  },
  (t) => [index('invitations_email_idx').on(t.email), check('invitations_email_lower', sql`${t.email} = lower(${t.email})`)],
);
