import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz, updatedAt } from './columns.js';
import { companyRoleEnum, companyStatusEnum, planEnum, teamRoleEnum } from './enums.js';
import { DEFAULT_COMPANY_SETTINGS, type CompanySettings } from './settings.js';

/** Tenant. */
export const companies = pgTable(
  'companies',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    plan: planEnum('plan').notNull().default('free'),
    status: companyStatusEnum('status').notNull().default('active'),
    settings: jsonb('settings').$type<CompanySettings>().notNull().default(DEFAULT_COMPANY_SETTINGS),
    /**
     * Stable per-company secret the collector HMACs hashed project keys with (SEC-11, ADR-0008). Served only
     * to the company's own tokens via collector-config; never shown in the dashboard.
     */
    projectSalt: text('project_salt')
      .notNull()
      .default(sql`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'companies_settings_valid',
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

export const teams = pgTable(
  'teams',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('teams_company_name_uq').on(t.companyId, t.name), unique('teams_company_id_uq').on(t.companyId, t.id)],
);

/**
 * A person (identity). Company access comes from company_memberships; super admins have none (BRIEF §4).
 * E-mails are stored lower-case.
 */
export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text('email').notNull(),
    name: text('name'),
    isSuperAdmin: boolean('is_super_admin').notNull().default(false),
    lastLoginAt: tstz('last_login_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
    check('users_email_lower', sql`${t.email} = lower(${t.email})`),
  ],
);

/** Membership of a user in a company: company role and primary team in that company (ADR-0022). */
export const companyMemberships = pgTable(
  'company_memberships',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyRole: companyRoleEnum('company_role').notNull().default('member'),
    /** Primary team in THIS company (composite FK; the SQL nulls only this column when the team goes). */
    primaryTeamId: uuid('primary_team_id'),
    /** Last time a dashboard session started in, or switched to, this company (trigger; D4). */
    lastActiveAt: tstz('last_active_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('company_memberships_company_user_uq').on(t.companyId, t.userId),
    index('company_memberships_user_idx').on(t.userId),
    foreignKey({
      name: 'company_memberships_primary_team_fk',
      columns: [t.companyId, t.primaryTeamId],
      foreignColumns: [teams.companyId, teams.id],
    }).onDelete('set null'),
  ],
);

export const teamMemberships = pgTable(
  'team_memberships',
  {
    id: pk(),
    companyId: uuid('company_id').notNull(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: teamRoleEnum('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('team_memberships_team_user_uq').on(t.teamId, t.userId),
    index('team_memberships_user_idx').on(t.userId),
    foreignKey({ columns: [t.companyId, t.teamId], foreignColumns: [teams.companyId, teams.id] }).onDelete('cascade'),
    foreignKey({
      name: 'team_memberships_membership_fk',
      columns: [t.companyId, t.userId],
      foreignColumns: [companyMemberships.companyId, companyMemberships.userId],
    }).onDelete('cascade'),
  ],
);

/** Pending invitation; accepted on first login with the invited e-mail (ADR-0013). */
export const invitations = pgTable(
  'invitations',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    teamId: uuid('team_id'),
    teamRole: teamRoleEnum('team_role').notNull().default('member'),
    companyRole: companyRoleEnum('company_role').notNull().default('member'),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitations_email_idx').on(t.email),
    index('invitations_company_idx').on(t.companyId),
    check('invitations_email_lower', sql`${t.email} = lower(${t.email})`),
    foreignKey({ columns: [t.companyId, t.teamId], foreignColumns: [teams.companyId, teams.id] }).onDelete('cascade'),
  ],
);
