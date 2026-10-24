import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  budgets,
  createDb,
  deployment,
  memberships,
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
 * Real-Postgres harness for the dashboard read layer. One database holds one deployment (ADR-0028), so every
 * fixture gets its OWN database: prepareShellDatabase() creates and migrates a template database once per test
 * process, and seedDeployment() clones it (CREATE DATABASE … TEMPLATE, fast) and seeds one deployment in one
 * visibility mode. dropShellDatabase() drops them all. Skips cleanly when Postgres is unreachable.
 *
 * Names are per test process (test files run in parallel, and so do whole test runs started from different
 * shells): ai_obs_shell_<pid>_test for the template, ai_obs_shell_<pid>_<fixture>_test for each fixture. With
 * SHELL_TEST_DATABASE_URL (the name must end in _test) its name replaces `ai_obs_shell` and gets the same
 * per-pid suffixes.
 */
function templateUrl(): string {
  const u = new URL(process.env.SHELL_TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_shell_test');
  u.pathname = `/${u.pathname.slice(1).replace(/_test$/, '')}_${process.pid}_test`;
  return u.toString();
}
export const SHELL_URL = templateUrl();
const shellBaseName = (): string => new URL(SHELL_URL).pathname.slice(1).replace(/_test$/, '');
const fixtureNames: string[] = [];

/** The URL of one fixture database: <template base>_<slug>_test. */
function fixtureUrl(slug: string): { name: string; url: string } {
  const name = `${shellBaseName()}_${slug.replace(/[^a-z0-9]+/g, '_')}_test`;
  if (name.length > 63) throw new Error(`fixture database name too long: ${name}`);
  const u = new URL(SHELL_URL);
  u.pathname = `/${name}`;
  return { name, url: u.toString() };
}

function adminUrl(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = '/postgres';
  return { name, url: u.toString() };
}

/** Runs admin statements (CREATE / DROP DATABASE) on the maintenance database. */
async function adminExec(statements: string[]): Promise<void> {
  const { url } = adminUrl(SHELL_URL);
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
function open(url: string, role?: string): Database {
  const { db, close } = createDb({ url, role, max: 2 });
  closers.push(close);
  return db;
}

export async function dropShellDatabase() {
  await Promise.all(closers.splice(0).map((c) => c()));
  const names = [...fixtureNames.splice(0), adminUrl(SHELL_URL).name];
  await adminExec(names.map((n) => `drop database if exists "${n}" with (force)`)).catch(() => {});
}

/** Fixed clock: fixture days are relative to it, so the tests never depend on the real date. */
export const NOW = new Date('2026-10-05T18:00:00Z');
export const FIXTURE_DAYS = 45;
const DAY = 86_400_000;

export interface Person extends Viewer {
  key: string;
  email: string;
  /** app_web connection to the person's deployment database (asPerson uses it). */
  web: Database;
}
/** One seeded deployment in its own database. */
export interface Fixture {
  /** deployment.id */
  id: string;
  mode: 'aggregates-only' | 'full';
  /** Connections to this fixture's database: owner (migrations role), app_web, app_worker. */
  owner: Database;
  web: Database;
  worker: Database;
  teams: Record<string, string>;
  projects: Record<string, string>;
  people: Record<string, Person>;
  /** every user id of the deployment (to prove none leaks in aggregates-only results) */
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
 * Identical data in every fixture of one `mixed` kind. Per day and user one turn (alternating model /
 * effort / outcome); each turn has one Explore run (depth 1) and, every third turn, a nested run
 * (depth 2). Turn totals = sum of its usage rows. With `mixed`, the runs use claude-haiku-4-5 (effort
 * null) instead of the turn's model, so turns are mixed-model. Three turns by m2 use a model with no
 * price. daily_rollups are then built by the worker's own recomputeDay (as app_worker).
 */
export const SUB_AGENT_MODEL = 'claude-haiku-4-5';

export async function seedDeployment(slug: string, mode: Fixture['mode'], opts: { mixed?: boolean } = {}): Promise<Fixture> {
  const target = fixtureUrl(slug);
  await adminExec([`drop database if exists "${target.name}" with (force)`, `create database "${target.name}" template "${adminUrl(SHELL_URL).name}"`]);
  fixtureNames.push(target.name);
  const owner = open(target.url);
  const web = open(target.url, 'app_web');
  const worker = open(target.url, 'app_worker');
  const fx = await owner.transaction(async (tx) => {
    await tx.execute(sql`set local role app_definer`);
    const [d] = await tx
      .update(deployment)
      .set({ name: slug, slug, settings: { individualVisibility: mode, projectNaming: 'plain', retentionDays: 395 } })
      .returning({ id: deployment.id });
    const fx: Fixture = { id: d!.id, mode, owner, web, worker, teams: {}, projects: {}, people: {}, userIds: [], turnIds: [] };
    for (const t of ['t1', 't2']) {
      const [r] = await tx.insert(teams).values({ name: `Team ${t}` }).returning({ id: teams.id });
      fx.teams[t] = r!.id;
    }
    for (const [key, team, name] of [['github.com/x/alpha', 't1', 'alpha'], ['github.com/x/beta', 't2', 'beta']] as const) {
      const [r] = await tx.insert(projects).values({ key, displayName: name, teamId: fx.teams[team]! }).returning({ id: projects.id });
      fx.projects[name] = r!.id;
    }
    for (const u of USERS) {
      const [r] = await tx
        .insert(users)
        .values({ email: `${u.key}@${slug}.test`, name: u.key })
        .returning({ id: users.id });
      await tx.insert(memberships).values({ userId: r!.id, role: u.role, primaryTeamId: fx.teams[u.team]! });
      await tx.insert(teamMemberships).values({ teamId: fx.teams[u.team]!, userId: r!.id, role: u.teamRole });
      fx.userIds.push(r!.id);
      fx.people[u.key] = {
        key: u.key,
        email: `${u.key}@${slug}.test`,
        id: r!.id,
        role: u.role,
        teams: [{ id: fx.teams[u.team]!, role: u.teamRole }],
        deployment: { settings: { individualVisibility: mode } },
        web,
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
        const own_ = { teamId: fx.teams[teamKey]!, userId: person.id };
        turnRows.push({
          id: turnId, ...own_, attribution: 'verified', projectId: fx.projects[project]!, externalId: `t-${n}`,
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
            ...own_, ...ids, startedAt: started, model: ids.runId ? runModel : model, effort: ids.runId ? runEffort : effort,
            inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite,
            reasoningTokens: t.reasoning, requests: t.requests,
          });
        usageOf(own, { turnId, runId: null });
        runRows.push({
          id: runId, ...own_, turnId, turnExternalId: `t-${n}`, externalId: 'r1', agentType: 'Explore', depth: 1, model: runModel, effort: runEffort,
          startedAt: new Date(startedMs + 1000), endedAt: new Date(startedMs + 1000 + durationMs / 2), durationMs: durationMs / 2,
          inputTokens: sub.input, outputTokens: sub.output, cacheReadTokens: sub.cacheRead, reasoningTokens: sub.reasoning,
          phasesMs: { exploring: durationMs / 2 }, outcome: 'success',
          mcp: n % 2 === 0 ? { github: { get_file: 1 }, docs: { search: 1 } } : {},
          mcpStats: n % 2 === 0 ? { github: { get_file: { errors: 0, denied: 1, ms: 0, buckets: [0, 0, 0, 0, 0] } }, docs: { search: { errors: 0, denied: 0, ms: 40_000, buckets: [0, 0, 0, 1, 0] } } } : {},
        });
        usageOf(sub, { turnId, runId });
        if (deep) {
          runRows.push({
            id: nestedId, ...own_, turnId, turnExternalId: `t-${n}`, externalId: 'r2', parentRunId: runId, parentExternalId: 'r1',
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
    await tx.execute(sql`insert into runaway_alerts (turn_id, team_id, user_id, project_id, harness, model, started_at, reasons, tokens, cost_usd, duration_ms)
      select t.id, t.team_id, t.user_id, t.project_id, t.harness, t.model, t.started_at, '["tokens"]'::jsonb,
        t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens, 1.5, t.duration_ms
      from turns t where (substring(t.external_id from 3))::int % 5 = 0`);
    // Budgets: a team budget and a per-user budget for m1.
    await tx.insert(budgets).values([
      { teamId: fx.teams.t1!, kind: 'tokens', limitValue: '500000' },
      { teamId: fx.teams.t1!, kind: 'cost', limitValue: '5' },
      { teamId: fx.teams.t1!, userId: fx.people.m1!.id, kind: 'tokens', limitValue: '100000' },
    ]);
    return fx;
  });
  for (let d = 0; d < FIXTURE_DAYS; d++) await recomputeDay(worker, new Date(Date.UTC(2026, 9, 5) - d * DAY).toISOString().slice(0, 10));
  return fx;
}

/** Opens an RLS context as `person` (in the person's deployment database) and builds the query context (price book included). */
export function asPerson<T>(person: Person, fn: (ctx: QueryCtx, tx: Tx) => Promise<T>, now: Date = NOW): Promise<T> {
  return withRlsContext(person.web, { userId: person.id, role: person.role }, async (tx) =>
    fn(await createQueryContext(tx, person, now), tx),
  );
}
