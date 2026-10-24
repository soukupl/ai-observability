import { sql } from 'drizzle-orm';
import { bigint, boolean, check, date, index, jsonb, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { count, createdAt, pk, tokenColumns, tstz, updatedAt, type PhasesMs } from './columns.js';
import { budgetKindEnum } from './enums.js';
import { projects } from './ingest.js';
import { memberships, teams, users } from './tenancy.js';

const big = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);

/**
 * API list prices in USD per million tokens, effective from a date. Admins edit them in the console (audited, RLS:
 * admin-only writes); `ensureDefaultModelPrices` adds missing defaults.
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
 * whole day slice inside one transaction (delete + insert).
 */
export const dailyRollups = pgTable(
  'daily_rollups',
  {
    id: pk(),
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
    /**
     * Tokens of turns whose outcome is failed or abandoned ("wasted", docs/briefs/wasted-spend.md) and of turns
     * with an unknown outcome, by the usage row's model × effort like the token columns above. Meaningful only
     * when outcome_split is true: rows written before migration 0007 have no split.
     */
    wastedInputTokens: big('wasted_input_tokens'),
    wastedOutputTokens: big('wasted_output_tokens'),
    wastedCacheReadTokens: big('wasted_cache_read_tokens'),
    wastedCacheWriteTokens: big('wasted_cache_write_tokens'),
    unknownInputTokens: big('unknown_input_tokens'),
    unknownOutputTokens: big('unknown_output_tokens'),
    unknownCacheReadTokens: big('unknown_cache_read_tokens'),
    unknownCacheWriteTokens: big('unknown_cache_write_tokens'),
    outcomeSplit: boolean('outcome_split').notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('daily_rollups_day_idx').on(t.day),
    index('daily_rollups_team_day_idx').on(t.teamId, t.day),
    index('daily_rollups_user_idx').on(t.userId),
  ],
);

/**
 * Daily skill / MCP use (docs/briefs/skills-and-mcp-stats.md), written by the worker together with
 * daily_rollups in the same slice transaction and with the same rules (no unique key, anonymised rows
 * kept, ADR-0012). One row per UTC day of the turn's `started_at` × team × user × project ×
 * harness × primary model × kind × name × tool, counting the turn and its runs:
 *   kind 'skill': name = skill, tool = '' (calls = model_calls + user_calls);
 *   kind 'mcp':   name = server, tool = '' for the server total, or the tool name for one tool.
 * `turns` = distinct turns that used it, so server rows (tool '') are not the sum of their tool rows.
 */
export const dailySkillMcpRollups = pgTable(
  'daily_skill_mcp_rollups',
  {
    id: pk(),
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
    /** outcome counts of those turns (skill impact, docs/briefs/skill-impact.md); valid when outcome_split */
    success: count('success'),
    failed: count('failed'),
    abandoned: count('abandoned'),
    unknown: count('unknown'),
    outcomeSplit: boolean('outcome_split').notNull().default(false),
    /**
     * MCP reliability (docs/briefs/mcp-reliability.md): errors, denied calls, and for calls with a timed result
     * their total ms and a histogram over < 1 s, 1–5 s, 5–30 s, 30–120 s, > 120 s (lat0 … lat4). 0 for skills.
     */
    errors: big('errors'),
    denied: big('denied'),
    latencyMs: big('latency_ms'),
    lat0: big('lat0'),
    lat1: big('lat1'),
    lat2: big('lat2'),
    lat3: big('lat3'),
    lat4: big('lat4'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('daily_skill_mcp_rollups_day_idx').on(t.day),
    index('daily_skill_mcp_rollups_team_day_idx').on(t.teamId, t.day),
    index('daily_skill_mcp_rollups_user_idx').on(t.userId),
    check('daily_skill_mcp_rollups_kind', sql`${t.kind} in ('skill', 'mcp')`),
  ],
);

/** Monthly token or ≈cost limit for a team or a user; notifies at 80 % / 100 %, never blocks (BRIEF §9). */
export const budgets = pgTable(
  'budgets',
  {
    id: pk(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    /** A per-user budget goes with the membership. */
    userId: uuid('user_id').references(() => memberships.userId, { onDelete: 'cascade' }),
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
    check('budgets_has_scope', sql`${t.teamId} is not null or ${t.userId} is not null`),
    check('budgets_period', sql`${t.period} = 'month'`),
    check('budgets_limit_positive', sql`${t.limitValue} > 0`),
  ],
);
