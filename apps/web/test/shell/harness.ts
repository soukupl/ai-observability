import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  budgets,
  companies,
  createDb,
  projects,
  runs,
  teamMemberships,
  teams,
  turns,
  usage,
  users,
  withRlsContext,
  type Database,
  type Tx,
} from '@ai-obs/db';
import { runMigrations } from '../../../../packages/db/src/migrate';
// The real worker fold, so the agreement tests compare raw reads with what production rollups hold.
import { recomputeDay } from '../../../worker/src/jobs/rollups';
import { createQueryContext, type QueryCtx, type Viewer } from '../../src/lib/queries/scope';

/**
 * Real-Postgres harness for the dashboard read layer. Creates its OWN database (ai_obs_shell_<pid>_test),
 * migrates it, seeds two identical companies (one per visibility mode) and drops it afterwards.
 * Skips cleanly when Postgres is unreachable.
 */
/**
 * One database per test process (ai_obs_shell_<pid>_test): test files run in parallel, and so do whole test
 * runs started from different shells, and each one drops and recreates its database. Override with
 * SHELL_TEST_DATABASE_URL (the name must end in _test).
 */
export const SHELL_URL = process.env.SHELL_TEST_DATABASE_URL || `postgres://ai_obs:ai_obs@localhost:5432/ai_obs_shell_${process.pid}_test`;

function adminUrl(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = '/postgres';
  return { name, url: u.toString() };
}

/** Runs admin statements (CREATE / DROP DATABASE) on the maintenance database. */
async function adminExec(statements: string[]): Promise<void> {
  const { name: _name, url } = adminUrl(SHELL_URL);
  const { db, close } = createDb({ url, max: 1 });
  try {
    for (const s of statements) await db.execute(sql.raw(s));
  } finally {
    await close().catch(() => {});
  }
}

export async function prepareShellDatabase(): Promise<string | null> {
  const { name } = adminUrl(SHELL_URL);
  if (!/_test$/.test(name)) return `refusing to reset database "${name}" (name must end in _test)`;
  try {
    await adminExec([`drop database if exists "${name}" with (force)`, `create database "${name}"`]);
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string }; message: string };
    return `Postgres not reachable (${e.code ?? e.cause?.code ?? e.message}); start it with \`docker compose up -d postgres\``;
  }
  await runMigrations(SHELL_URL);
  return null;
}

const closers: Array<() => Promise<void>> = [];
export function connect(role?: string): Database {
  const { db, close } = createDb({ url: SHELL_URL, role, max: 2 });
  closers.push(close);
  return db;
}

export async function dropShellDatabase() {
  await Promise.all(closers.splice(0).map((c) => c()));
  const { name } = adminUrl(SHELL_URL);
  await adminExec([`drop database if exists "${name}" with (force)`]).catch(() => {});
}

/** Fixed clock: fixture days are relative to it, so the tests never depend on the real date. */
export const NOW = new Date('2026-10-05T18:00:00Z');
export const FIXTURE_DAYS = 45;
const DAY = 86_400_000;

export interface Person extends Viewer {
  key: string;
  email: string;
}
export interface Fixture {
  id: string;
  mode: 'aggregates-only' | 'full';
  teams: Record<string, string>;
  projects: Record<string, string>;
  people: Record<string, Person>;
  /** every user id of the company (to prove none leaks in aggregates-only results) */
  userIds: string[];
  turnIds: { id: string; userKey: string | null; startedMs: number }[];
}

const USERS = [
  { key: 'admin', role: 'admin' as const, team: 't1', teamRole: 'member' as const },
  { key: 'lead', role: 'member' as const, team: 't1', teamRole: 'lead' as const },
  { key: 'm1', role: 'member' as const, team: 't1', teamRole: 'member' as const },
  { key: 'm2', role: 'member' as const, team: 't2', teamRole: 'member' as const },
];

/**
 * Identical data in every company of one `mixed` kind. Per day and user one turn (alternating model /
 * effort / outcome); each turn has one Explore run (depth 1) and, every third turn, a nested run
 * (depth 2). Turn totals = sum of its usage rows. With `mixed`, the runs use claude-haiku-4-5 (effort
 * null) instead of the turn's model, so turns are mixed-model. Three turns by m2 use a model with no
 * price. daily_rollups are then built by the worker's own recomputeDay (as app_worker).
 */
export const SUB_AGENT_MODEL = 'claude-haiku-4-5';

export async function seedCompany(owner: Database, slug: string, mode: Fixture['mode'], opts: { mixed?: boolean } = {}): Promise<Fixture> {
  const fx = await owner.transaction(async (tx) => {
    await tx.execute(sql`set local role app_definer`);
    const [c] = await tx
      .insert(companies)
      .values({ name: slug, slug, settings: { individualVisibility: mode, projectNaming: 'plain', retentionDays: 395 } })
      .returning({ id: companies.id });
    const companyId = c!.id;
    const fx: Fixture = { id: companyId, mode, teams: {}, projects: {}, people: {}, userIds: [], turnIds: [] };
    for (const t of ['t1', 't2']) {
      const [r] = await tx.insert(teams).values({ companyId, name: `Team ${t}` }).returning({ id: teams.id });
      fx.teams[t] = r!.id;
    }
    for (const [key, team, name] of [['github.com/x/alpha', 't1', 'alpha'], ['github.com/x/beta', 't2', 'beta']] as const) {
      const [r] = await tx.insert(projects).values({ companyId, key, displayName: name, teamId: fx.teams[team]! }).returning({ id: projects.id });
      fx.projects[name] = r!.id;
    }
    for (const u of USERS) {
      const [r] = await tx
        .insert(users)
        .values({ companyId, email: `${u.key}@${slug}.test`, name: u.key, companyRole: u.role, primaryTeamId: fx.teams[u.team]! })
        .returning({ id: users.id });
      await tx.insert(teamMemberships).values({ companyId, teamId: fx.teams[u.team]!, userId: r!.id, role: u.teamRole });
      fx.userIds.push(r!.id);
      fx.people[u.key] = {
        key: u.key,
        email: `${u.key}@${slug}.test`,
        id: r!.id,
        companyId,
        companyRole: u.role,
        teams: [{ id: fx.teams[u.team]!, role: u.teamRole }],
        company: { settings: { individualVisibility: mode } },
      };
    }

    const turnRows: (typeof turns.$inferInsert)[] = [];
    const runRows: (typeof runs.$inferInsert)[] = [];
    const usageRows: (typeof usage.$inferInsert)[] = [];
    const outcomes = ['success', 'success', 'failed', 'unknown', 'abandoned', 'success'] as const;
    const todayMs = Date.UTC(2026, 9, 5);
    let n = 0;
    for (let d = 0; d < FIXTURE_DAYS; d++) {
      USERS.forEach((u, ui) => {
        n += 1;
        const person = fx.people[u.key]!;
        const teamKey = u.team;
        const project = ui % 2 === 0 ? 'alpha' : 'beta';
        const mystery = u.key === 'm2' && d === 2 && ui === 3;
        const model = mystery ? 'mystery-1' : n % 2 === 0 ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
        const effort = n % 3 === 0 ? 'low' : 'high';
        const startedMs = todayMs - d * DAY + (9 + ui) * 3_600_000;
        const durationMs = 20_000 * (1 + (n % 7));
        const outcome = outcomes[n % outcomes.length]!;
        const turnId = randomUUID();
        const runId = randomUUID();
        const nested = n % 3 === 0;
        const nestedId = randomUUID();
        const own = { input: 1000 + ui * 10, output: 200, cacheRead: 5000, cacheWrite: 100, reasoning: 50, requests: 3 };
        const sub = { input: 100, output: 20, cacheRead: 400, cacheWrite: 0, reasoning: 5, requests: 1 };
        const deep = nested ? { input: 10, output: 2, cacheRead: 40, cacheWrite: 0, reasoning: 0, requests: 1 } : null;
        const sum = (k: keyof typeof own) => own[k] + sub[k] + (deep ? deep[k] : 0);
        const started = new Date(startedMs);
        const ended = new Date(startedMs + durationMs);
        const owner = { companyId, teamId: fx.teams[teamKey]!, userId: person.id };
        turnRows.push({
          id: turnId, ...owner, attribution: 'verified', projectId: fx.projects[project]!, externalId: `t-${n}`,
          harness: n % 5 === 0 ? 'codex' : 'claude-code', model, effort, startedAt: started, endedAt: ended, durationMs,
          inputTokens: sum('input'), outputTokens: sum('output'), cacheReadTokens: sum('cacheRead'),
          cacheWriteTokens: sum('cacheWrite'), reasoningTokens: sum('reasoning'), phasesMs: { thinking: durationMs / 2, coding: durationMs / 4, testing: durationMs / 4 },
          outcome, summary: `Turn ${n} summary`, filesTouched: 2, linesAdded: 10, linesRemoved: 3,
          // skill / MCP use: code-review every 4th turn (typed every 8th), github MCP every 3rd
          skills: n % 4 === 0 ? { 'code-review': { model: 1, user: n % 8 === 0 ? 1 : 0 } } : {},
          mcp: n % 3 === 0 ? { github: { search_code: 2 } } : {},
          // one of the two search_code calls fails every 6th turn; both timed (0.5 s and 2 s)
          mcpStats: n % 3 === 0 ? { github: { search_code: { errors: n % 6 === 0 ? 1 : 0, denied: 0, ms: 2500, buckets: [1, 1, 0, 0, 0] } } } : {},
        });
        const runModel = opts.mixed ? SUB_AGENT_MODEL : model;
        const runEffort = opts.mixed ? null : effort;
        const usageOf = (t: typeof own, ids: { turnId: string; runId: string | null }) =>
          usageRows.push({
            ...owner, ...ids, startedAt: started, model: ids.runId ? runModel : model, effort: ids.runId ? runEffort : effort,
            inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite,
            reasoningTokens: t.reasoning, requests: t.requests,
          });
        usageOf(own, { turnId, runId: null });
        runRows.push({
          id: runId, ...owner, turnId, turnExternalId: `t-${n}`, externalId: 'r1', agentType: 'Explore', depth: 1, model: runModel, effort: runEffort,
          startedAt: new Date(startedMs + 1000), endedAt: new Date(startedMs + 1000 + durationMs / 2), durationMs: durationMs / 2,
          inputTokens: sub.input, outputTokens: sub.output, cacheReadTokens: sub.cacheRead, reasoningTokens: sub.reasoning,
          phasesMs: { exploring: durationMs / 2 }, outcome: 'success',
          mcp: n % 2 === 0 ? { github: { get_file: 1 }, docs: { search: 1 } } : {},
          mcpStats: n % 2 === 0 ? { github: { get_file: { errors: 0, denied: 1, ms: 0, buckets: [0, 0, 0, 0, 0] } }, docs: { search: { errors: 0, denied: 0, ms: 40_000, buckets: [0, 0, 0, 1, 0] } } } : {},
        });
        usageOf(sub, { turnId, runId });
        if (deep) {
          runRows.push({
            id: nestedId, ...owner, turnId, turnExternalId: `t-${n}`, externalId: 'r2', parentRunId: runId, parentExternalId: 'r1',
            agentType: 'general-purpose', depth: 2, model: runModel, effort: runEffort, startedAt: new Date(startedMs + 2000),
            endedAt: new Date(startedMs + 2000 + durationMs / 4), durationMs: durationMs / 4, inputTokens: deep.input,
            outputTokens: deep.output, cacheReadTokens: deep.cacheRead, outcome: 'failed',
          });
          usageOf(deep, { turnId, runId: nestedId });
        }
        fx.turnIds.push({ id: turnId, userKey: u.key, startedMs });
      });
    }
    for (let i = 0; i < turnRows.length; i += 200) await tx.insert(turns).values(turnRows.slice(i, i + 200));
    for (let i = 0; i < runRows.length; i += 200) {
      // parents first: the nested rows reference an earlier run of the same batch order
      await tx.insert(runs).values(runRows.slice(i, i + 200));
    }
    for (let i = 0; i < usageRows.length; i += 200) await tx.insert(usage).values(usageRows.slice(i, i + 200));
    // every 5th turn was flagged as a runaway (written by the worker in real life)
    await tx.execute(sql`insert into runaway_alerts (company_id, turn_id, team_id, user_id, project_id, harness, model, started_at, reasons, tokens, cost_usd, duration_ms)
      select t.company_id, t.id, t.team_id, t.user_id, t.project_id, t.harness, t.model, t.started_at, '["tokens"]'::jsonb,
        t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens, 1.5, t.duration_ms
      from turns t where t.company_id = ${companyId}::uuid and (substring(t.external_id from 3))::int % 5 = 0`);
    // Budgets: a team token budget and a per-user budget for m1.
    await tx.insert(budgets).values([
      { companyId, teamId: fx.teams.t1!, kind: 'tokens', limitValue: '500000' },
      { companyId, teamId: fx.teams.t1!, kind: 'cost', limitValue: '5' },
      { companyId, teamId: fx.teams.t1!, userId: fx.people.m1!.id, kind: 'tokens', limitValue: '100000' },
    ]);
    return fx;
  });
  const worker = connect('app_worker');
  for (let d = 0; d < FIXTURE_DAYS; d++) await recomputeDay(worker, fx.id, new Date(Date.UTC(2026, 9, 5) - d * DAY).toISOString().slice(0, 10));
  return fx;
}

/** Opens an RLS context as `person` and builds the query context (price book included). */
export function asPerson<T>(db: Database, person: Person, fn: (ctx: QueryCtx, tx: Tx) => Promise<T>, now: Date = NOW): Promise<T> {
  return withRlsContext(db, { companyId: person.companyId, userId: person.id, role: person.companyRole }, async (tx) =>
    fn(await createQueryContext(tx, person, now), tx),
  );
}
