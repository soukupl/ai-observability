import { sql } from 'drizzle-orm';
import { bigint, check, date, foreignKey, index, jsonb, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { count, createdAt, pk, tokenColumns, tstz, updatedAt, type PhasesMs } from './columns.js';
import { budgetKindEnum } from './enums.js';
import { projects } from './ingest.js';
import { companies, teams, users } from './tenancy.js';

/**
 * API list prices in USD per million tokens, effective from a date (global, not tenant data).
 * Cost is computed at query time (SQL function estimate_cost_usd) with the row effective on the usage
 * date. Reasoning tokens are a subset of output tokens and are not billed separately.
 */
export const modelPrices = pgTable(
  'model_prices',
  {
    id: pk(),
    model: text('model').notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    inputPerMtok: numeric('input_per_mtok', { precision: 12, scale: 4 }).notNull(),
    outputPerMtok: numeric('output_per_mtok', { precision: 12, scale: 4 }).notNull(),
    cacheReadPerMtok: numeric('cache_read_per_mtok', { precision: 12, scale: 4 }).notNull(),
    cacheWritePerMtok: numeric('cache_write_per_mtok', { precision: 12, scale: 4 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('model_prices_model_from_uq').on(t.model, t.effectiveFrom)],
);

/**
 * Daily aggregates kept forever (ADR-0012); no summaries. user_id becomes null when a user is deleted.
 * No unique key on the dimensions (that would collide after anonymization): the worker recomputes a
 * whole (company_id, day) slice inside one transaction (delete + insert).
 */
export const dailyRollups = pgTable(
  'daily_rollups',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    harness: text('harness').notNull(),
    model: text('model').notNull(),
    effort: text('effort'),
    turns: count('turns'),
    runs: count('runs'),
    ...tokenColumns(),
    durationMs: bigint('duration_ms', { mode: 'number' }).notNull().default(0),
    phasesMs: jsonb('phases_ms').$type<PhasesMs>().notNull().default({}),
    success: count('success'),
    failed: count('failed'),
    abandoned: count('abandoned'),
    unknown: count('unknown'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('daily_rollups_company_day_idx').on(t.companyId, t.day),
    index('daily_rollups_company_team_day_idx').on(t.companyId, t.teamId, t.day),
    index('daily_rollups_user_idx').on(t.userId),
  ],
);

/**
 * Daily skill / MCP use (docs/briefs/skills-and-mcp-stats.md), written by the worker together with
 * daily_rollups in the same slice transaction and with the same rules (no unique key, anonymised rows
 * kept, ADR-0012). One row per company × UTC day of the turn's `started_at` × team × user × project ×
 * harness × primary model × kind × name × tool, counting the turn and its runs:
 *   kind 'skill': name = skill, tool = '' (calls = model_calls + user_calls);
 *   kind 'mcp':   name = server, tool = '' for the server total, or the tool name for one tool.
 * `turns` = distinct turns that used it, so server rows (tool '') are not the sum of their tool rows.
 */
export const dailySkillMcpRollups = pgTable(
  'daily_skill_mcp_rollups',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    harness: text('harness').notNull(),
    model: text('model').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    tool: text('tool').notNull().default(''),
    calls: bigint('calls', { mode: 'number' }).notNull().default(0),
    modelCalls: bigint('model_calls', { mode: 'number' }).notNull().default(0),
    userCalls: bigint('user_calls', { mode: 'number' }).notNull().default(0),
    turns: count('turns'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('daily_skill_mcp_rollups_company_day_idx').on(t.companyId, t.day),
    index('daily_skill_mcp_rollups_company_team_day_idx').on(t.companyId, t.teamId, t.day),
    index('daily_skill_mcp_rollups_user_idx').on(t.userId),
    check('daily_skill_mcp_rollups_kind', sql`${t.kind} in ('skill', 'mcp')`),
  ],
);

/** Monthly token or ≈cost limit for a team or a user; notifies at 80 % / 100 %, never blocks (BRIEF §9). */
export const budgets = pgTable(
  'budgets',
  {
    id: pk(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id'),
    userId: uuid('user_id'),
    kind: budgetKindEnum('kind').notNull(),
    period: text('period').notNull().default('month'),
    /** Tokens, or USD for kind = 'cost'. */
    limitValue: numeric('limit_value', { precision: 18, scale: 2 }).notNull(),
    /** First day of the month the notified_* marks belong to; the worker resets them each month. */
    notifiedPeriod: date('notified_period', { mode: 'string' }),
    notified80At: tstz('notified_80_at'),
    notified100At: tstz('notified_100_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('budgets_company_idx').on(t.companyId),
    check('budgets_has_scope', sql`${t.teamId} is not null or ${t.userId} is not null`),
    check('budgets_period', sql`${t.period} = 'month'`),
    check('budgets_limit_positive', sql`${t.limitValue} > 0`),
    foreignKey({ columns: [t.companyId, t.teamId], foreignColumns: [teams.companyId, teams.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.companyId, t.userId], foreignColumns: [users.companyId, users.id] }).onDelete('cascade'),
  ],
);
