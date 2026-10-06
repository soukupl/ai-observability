import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { count, createdAt, pk, tokenColumns, tstz, updatedAt, workColumns } from './columns.js';
import { attributionEnum, outcomeEnum } from './enums.js';
import { machines, projects } from './ingest.js';
import { companies, teams, users } from './tenancy.js';

/*
 * Raw telemetry (BRIEF §7). Metadata only: never prompts, responses, code, diffs or file paths.
 * team_id / user_id are denormalized onto every table so RLS can filter each row on its own.
 * `external_id` columns hold the collector's ids; the unique (company_id, external_id) pairs make
 * ingest upserts idempotent.
 */

const companyRef = () =>
  uuid('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' });

/** One harness session from start to exit. */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: pk(),
    companyId: companyRef(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    userId: uuid('user_id'),
    machineId: uuid('machine_id').references(() => machines.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    externalId: text('external_id').notNull(),
    harness: text('harness').notNull(),
    harnessVersion: text('harness_version'),
    startedAt: tstz('started_at').notNull(),
    endedAt: tstz('ended_at'),
    endReason: text('end_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('agent_sessions_company_external_uq').on(t.companyId, t.externalId),
    unique('agent_sessions_company_id_uq').on(t.companyId, t.id),
    index('agent_sessions_company_started_idx').on(t.companyId, t.startedAt),
    foreignKey({ columns: [t.companyId, t.userId], foreignColumns: [users.companyId, users.id] }).onDelete('cascade'),
  ],
);

/** Primary unit of work: one user prompt until the agent stops (ADR-0002). */
export const turns = pgTable(
  'turns',
  {
    id: pk(),
    companyId: companyRef(),
    teamId: uuid('team_id').notNull(),
    /** null = team-token event that matched no user (attribution 'unverified'). */
    userId: uuid('user_id'),
    attribution: attributionEnum('attribution').notNull(),
    sessionId: uuid('session_id'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    externalId: text('external_id').notNull(),
    harness: text('harness').notNull(),
    ...workColumns(),
    filesTouched: count('files_touched'),
    linesAdded: count('lines_added'),
    linesRemoved: count('lines_removed'),
    summary: text('summary'),
    phaseRulesVersion: integer('phase_rules_version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('turns_company_external_uq').on(t.companyId, t.externalId),
    unique('turns_company_id_uq').on(t.companyId, t.id),
    index('turns_company_started_idx').on(t.companyId, t.startedAt),
    index('turns_company_team_started_idx').on(t.companyId, t.teamId, t.startedAt),
    index('turns_company_user_started_idx').on(t.companyId, t.userId, t.startedAt),
    index('turns_company_project_started_idx').on(t.companyId, t.projectId, t.startedAt),
    index('turns_session_idx').on(t.sessionId),
    // The worker's rollup watermark selects turns changed since its last pass.
    index('turns_updated_idx').on(t.updatedAt),
    check('turns_summary_len', sql`char_length(${t.summary}) <= 140`),
    check('turns_user_attribution', sql`(${t.userId} is null) = (${t.attribution} = 'unverified')`),
    foreignKey({ columns: [t.companyId, t.teamId], foreignColumns: [teams.companyId, teams.id] }),
    foreignKey({ columns: [t.companyId, t.userId], foreignColumns: [users.companyId, users.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.companyId, t.sessionId], foreignColumns: [agentSessions.companyId, agentSessions.id] }).onDelete(
      'cascade',
    ),
  ],
);

/**
 * One agent execution inside a turn: the main agent or a sub-agent (parent_run_id). A run may arrive
 * before its turn; then turn_id is null and turn_external_id is used to link it later.
 */
export const runs = pgTable(
  'runs',
  {
    id: pk(),
    companyId: companyRef(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    userId: uuid('user_id'),
    turnId: uuid('turn_id'),
    turnExternalId: text('turn_external_id').notNull(),
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => runs.id, { onDelete: 'cascade' }),
    parentExternalId: text('parent_external_id'),
    externalId: text('external_id').notNull(),
    agentType: text('agent_type').notNull(),
    depth: integer('depth').notNull().default(0),
    ...workColumns(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('runs_company_turn_external_uq').on(t.companyId, t.turnExternalId, t.externalId),
    unique('runs_company_id_uq').on(t.companyId, t.id),
    index('runs_company_started_idx').on(t.companyId, t.startedAt),
    index('runs_turn_idx').on(t.turnId),
    index('runs_parent_idx').on(t.parentRunId),
    // The worker's rollup watermark also selects runs created since its last pass.
    index('runs_created_idx').on(t.createdAt),
    foreignKey({ columns: [t.companyId, t.userId], foreignColumns: [users.companyId, users.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.companyId, t.turnId], foreignColumns: [turns.companyId, turns.id] }).onDelete('cascade'),
  ],
);

/** Token counts per (turn | run) × model × effort — handles mixed-model turns. run_id null = turn-level usage. */
export const usage = pgTable(
  'usage',
  {
    id: pk(),
    companyId: companyRef(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    userId: uuid('user_id'),
    turnId: uuid('turn_id'),
    runId: uuid('run_id'),
    /** Start of the owning turn / run; selects the effective model_prices row. */
    startedAt: tstz('started_at').notNull(),
    model: text('model').notNull(),
    effort: text('effort'),
    ...tokenColumns(),
  },
  (t) => [
    unique('usage_owner_model_uq').on(t.companyId, t.turnId, t.runId, t.model, t.effort).nullsNotDistinct(),
    index('usage_company_started_idx').on(t.companyId, t.startedAt),
    index('usage_turn_idx').on(t.turnId),
    index('usage_run_idx').on(t.runId),
    check('usage_has_owner', sql`${t.turnId} is not null or ${t.runId} is not null`),
    foreignKey({ columns: [t.companyId, t.userId], foreignColumns: [users.companyId, users.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.companyId, t.turnId], foreignColumns: [turns.companyId, turns.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.companyId, t.runId], foreignColumns: [runs.companyId, runs.id] }).onDelete('cascade'),
  ],
);

/**
 * A turn_outcome / turn_summary that arrived before its turn (ADR-0015). Ingest parks it here instead
 * of creating a placeholder turn; when the turn arrives, ingest_apply_pending_patch() copies it onto the
 * turn and deletes it. A null column means "not patched". Never read by the dashboard.
 */
export const pendingTurnPatches = pgTable(
  'pending_turn_patches',
  {
    id: pk(),
    companyId: companyRef(),
    /** turns.external_id of the turn the patch is for (`<harness>:<turn_id>`). */
    turnExternalId: text('turn_external_id').notNull(),
    outcome: outcomeEnum('outcome'),
    outcomeSignals: jsonb('outcome_signals').$type<string[]>(),
    outcomeProvisional: boolean('outcome_provisional'),
    summary: text('summary'),
    /**
     * The verified/matched sender of the patch (null = unverified). ingest_apply_pending_patch() applies it
     * only when the turn has no owner or the same owner (SEC-3); deleting the user deletes the parked patch.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    receivedAt: tstz('received_at').notNull().defaultNow(),
  },
  (t) => [
    unique('pending_turn_patches_company_turn_uq').on(t.companyId, t.turnExternalId),
    index('pending_turn_patches_received_idx').on(t.receivedAt),
    check('pending_turn_patches_summary_len', sql`char_length(${t.summary}) <= 140`),
  ],
);
