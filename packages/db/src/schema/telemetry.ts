import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { count, createdAt, pk, tokenColumns, tstz, updatedAt, workColumns } from './columns.js';
import { attributionEnum, outcomeEnum } from './enums.js';
import { machines, projects } from './ingest.js';
import { teams, users } from './tenancy.js';

/*
 * Raw telemetry (BRIEF §7). Metadata only: never prompts, responses, code, diffs or file paths.
 * team_id / user_id are denormalized onto every table so RLS can filter each row on its own.
 * `external_id` columns hold the collector's ids; unique external ids make ingest upserts idempotent.
 */

/** One harness session from start to exit. */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: pk(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    machineId: uuid('machine_id').references(() => machines.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    externalId: text('external_id').notNull(),
    harness: text('harness').notNull(),
    harnessVersion: text('harness_version'),
    startedAt: tstz('started_at').notNull(),
    endedAt: tstz('ended_at'),
    endReason: text('end_reason'),
    /**
     * The session's title as the harness shows it (ADR-0026), set only by `session_title` patches: Claude Code's
     * `/rename` title (`custom`) or its generated title (`ai`). Conversation-derived text, like a turn summary.
     */
    title: text('title'),
    titleSource: text('title_source'),
    /**
     * Live status (ADR-0027): start of the running turn (latest turn_started, collector clock); null while idle.
     * Cleared by a turn that ended at or after it and by session_end.
     */
    currentTurnStartedAt: tstz('current_turn_started_at'),
    /** Newest event time (session_start, turn_started, turn end, session_end), capped at the server clock (ADR-0027). */
    lastSeenAt: tstz('last_seen_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('agent_sessions_external_uq').on(t.externalId),
    index('agent_sessions_started_idx').on(t.startedAt),
    // The live query ("Active now"): open sessions seen recently (ADR-0027).
    index('agent_sessions_last_seen_idx').on(t.lastSeenAt).where(sql`${t.endedAt} is null`),
    check('agent_sessions_title_len', sql`char_length(${t.title}) <= 140`),
    check('agent_sessions_title_source', sql`${t.titleSource} in ('custom', 'ai')`),
  ],
);

/** Primary unit of work: one user prompt until the agent stops (ADR-0002). */
export const turns = pgTable(
  'turns',
  {
    id: pk(),
    teamId: uuid('team_id').references(() => teams.id),
    /** null only on old company-token turns that matched no member (attribution 'unverified'); new turns always have one. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    attribution: attributionEnum('attribution').notNull(),
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'cascade' }),
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
    unique('turns_external_uq').on(t.externalId),
    index('turns_started_idx').on(t.startedAt),
    index('turns_team_started_idx').on(t.teamId, t.startedAt),
    index('turns_user_started_idx').on(t.userId, t.startedAt),
    index('turns_project_started_idx').on(t.projectId, t.startedAt),
    index('turns_session_idx').on(t.sessionId),
    // The worker's rollup watermark selects turns changed since its last pass.
    index('turns_updated_idx').on(t.updatedAt),
    check('turns_summary_len', sql`char_length(${t.summary}) <= 140`),
    check('turns_user_attribution', sql`(${t.userId} is null) = (${t.attribution} = 'unverified')`),
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
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    turnId: uuid('turn_id').references((): AnyPgColumn => turns.id, { onDelete: 'cascade' }),
    turnExternalId: text('turn_external_id').notNull(),
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => runs.id, { onDelete: 'cascade' }),
    parentExternalId: text('parent_external_id'),
    externalId: text('external_id').notNull(),
    agentType: text('agent_type').notNull(),
    /** Logical kind of agent (`Explore`, `workflow:verify`); null = derive from agent_type on read (ADR-0019). */
    agentGroup: text('agent_group'),
    /** Batch / workflow run that launched the agent (`wf_…`); null when unknown (ADR-0019). */
    orchestrationId: text('orchestration_id'),
    /** 0-based ordinal of the agent's phase inside its orchestration; null when unknown (ADR-0020). */
    stageIndex: integer('stage_index'),
    /** The item named by the label convention `<stage>:<item>`, slugged; null when absent (ADR-0020). */
    flowKey: text('flow_key'),
    depth: integer('depth').notNull().default(0),
    ...workColumns(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('runs_turn_external_uq').on(t.turnExternalId, t.externalId),
    index('runs_started_idx').on(t.startedAt),
    index('runs_turn_idx').on(t.turnId),
    index('runs_parent_idx').on(t.parentRunId),
    // The worker's rollup watermark also selects runs created since its last pass.
    index('runs_created_idx').on(t.createdAt),
  ],
);

/**
 * A typed edge between two runs of one turn (ADR-0020): the source run's result fed the target run. Carried by the
 * target run's event (`links`), so ingest replaces a run's incoming edges on every event. `from_run_id` is resolved
 * late like `parent_run_id` (the source may arrive after the target); `turn_id` is linked when the turn arrives.
 * Visibility follows the target run (RLS policy via `runs`); deleted with either run or the turn.
 */
export const runLinks = pgTable(
  'run_links',
  {
    id: pk(),
    turnId: uuid('turn_id').references(() => turns.id, { onDelete: 'cascade' }),
    turnExternalId: text('turn_external_id').notNull(),
    fromRunId: uuid('from_run_id').references(() => runs.id, { onDelete: 'cascade' }),
    toRunId: uuid('to_run_id').references(() => runs.id, { onDelete: 'cascade' }),
    fromExternalId: text('from_external_id').notNull(),
    toExternalId: text('to_external_id').notNull(),
    /** 'item' (same workflow item, next stage) | 'sequence' (next sibling Agent-tool spawn). */
    kind: text('kind').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('run_links_edge_uq').on(t.turnExternalId, t.fromExternalId, t.toExternalId, t.kind),
    index('run_links_turn_idx').on(t.turnId),
    index('run_links_to_idx').on(t.toRunId),
    index('run_links_from_idx').on(t.fromRunId),
    check('run_links_kind', sql`${t.kind} in ('item', 'sequence')`),
  ],
);

/** Token counts per (turn | run) × model × effort — handles mixed-model turns. run_id null = turn-level usage. */
export const usage = pgTable(
  'usage',
  {
    id: pk(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    turnId: uuid('turn_id').references(() => turns.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    /** Start of the owning turn / run; selects the effective model_prices row. */
    startedAt: tstz('started_at').notNull(),
    model: text('model').notNull(),
    effort: text('effort'),
    ...tokenColumns(),
  },
  (t) => [
    unique('usage_owner_model_uq').on(t.turnId, t.runId, t.model, t.effort).nullsNotDistinct(),
    index('usage_started_idx').on(t.startedAt),
    index('usage_turn_idx').on(t.turnId),
    index('usage_run_idx').on(t.runId),
    check('usage_has_owner', sql`${t.turnId} is not null or ${t.runId} is not null`),
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
    /** turns.external_id of the turn the patch is for (`<harness>:<turn_id>`). */
    turnExternalId: text('turn_external_id').notNull(),
    outcome: outcomeEnum('outcome'),
    outcomeSignals: jsonb('outcome_signals').$type<string[]>(),
    outcomeProvisional: boolean('outcome_provisional'),
    summary: text('summary'),
    /**
     * The sender of the patch (null only on rows parked by old company tokens). ingest_apply_pending_patch() applies it
     * only when the turn has no owner or the same owner (SEC-3); deleting the user deletes the parked patch.
     */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    receivedAt: tstz('received_at').notNull().defaultNow(),
  },
  (t) => [
    unique('pending_turn_patches_turn_uq').on(t.turnExternalId),
    index('pending_turn_patches_received_idx').on(t.receivedAt),
    check('pending_turn_patches_summary_len', sql`char_length(${t.summary}) <= 140`),
  ],
);

/**
 * A session_title that arrived before its session (ADR-0026). Parked like pending_turn_patches; when the session
 * row is created, ingest_apply_pending_session_patch() copies it onto the session and deletes it. Never read by the
 * dashboard.
 */
export const pendingSessionPatches = pgTable(
  'pending_session_patches',
  {
    id: pk(),
    /** agent_sessions.external_id of the session the patch is for (`<harness>:<session_id>`). */
    sessionExternalId: text('session_external_id').notNull(),
    title: text('title').notNull(),
    titleSource: text('title_source').notNull(),
    /** The sender (null = unverified); applied only to an ownerless session or one of the same owner (SEC-3). */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    receivedAt: tstz('received_at').notNull().defaultNow(),
  },
  (t) => [
    unique('pending_session_patches_session_uq').on(t.sessionExternalId),
    index('pending_session_patches_received_idx').on(t.receivedAt),
    check('pending_session_patches_title_len', sql`char_length(${t.title}) <= 140`),
    check('pending_session_patches_title_source', sql`${t.titleSource} in ('custom', 'ai')`),
  ],
);

/**
 * A turn flagged as a runaway by the worker's `runaways` job (docs/briefs/runaway-alerts.md, ADR-0018): one row per
 * turn, written after the turn ended. `reasons`: 'tokens' (far above the user's own normal), 'cost' (≈ cost at or
 * above the deployment threshold), 'duration' (long and above-normal tokens). `notified_at` = mailed in a digest.
 * Deleted with its turn (retention) and with its user.
 */
export const runawayAlerts = pgTable(
  'runaway_alerts',
  {
    id: pk(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => turns.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id'),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    harness: text('harness').notNull(),
    model: text('model'),
    startedAt: tstz('started_at').notNull(),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    tokens: bigint('tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 14, scale: 4 }),
    durationMs: bigint('duration_ms', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    notifiedAt: tstz('notified_at'),
  },
  (t) => [
    unique('runaway_alerts_turn_uq').on(t.turnId),
    index('runaway_alerts_started_idx').on(t.startedAt),
  ],
);

/**
 * A flow a user flagged "for later" (docs/briefs/dashboard-followups-2026-10-10.md, ADR-0024): a personal bookmark of
 * one agent flow (`/flows/<turn>/<key>`), private to the user who set it (RLS: own rows only). `flow_name` is a
 * snapshot of the flow's name at flag time (flows are computed on read, never stored). Deleted with its turn
 * (retention) and with its user.
 */
export const flowFlags = pgTable(
  'flow_flags',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => turns.id, { onDelete: 'cascade' }),
    flowKey: text('flow_key').notNull(),
    flowName: text('flow_name').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('flow_flags_user_flow_uq').on(t.userId, t.turnId, t.flowKey),
    index('flow_flags_user_created_idx').on(t.userId, t.createdAt),
    check('flow_flags_key_format', sql`${t.flowKey} ~ '^[A-Za-z0-9_.:-]{1,128}$'`),
    check('flow_flags_name_len', sql`char_length(${t.flowName}) between 1 and 200`),
    check('flow_flags_note_len', sql`${t.note} is null or char_length(${t.note}) <= 500`),
  ],
);
