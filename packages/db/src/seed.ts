import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { createDb } from './client.js';
import { ensureDefaultModelPrices } from './prices.js';
import {
  agentSessions,
  budgets,
  dailyRollups,
  dailySkillMcpRollups,
  deployment,
  ingestTokens,
  memberships,
  projects,
  runs,
  teamMemberships,
  teams,
  turns,
  usage,
  users,
} from './schema/index.js';
import { generateTurns, type SeedTurn } from './seed-data.js';

/** The demo deployment (ADR-0028: one deployment = one company). */
export const DEMO_DEPLOYMENT = { name: 'SPECTADO', slug: 'spectado' } as const;
/** The first ADMIN_EMAILS address becomes an admin member (brief Q8); there are no super admins any more. */
const ADMIN_EMAIL =
  (process.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).find(Boolean) ?? 'admin@example.com';
/** The demo service user (brief Q9): no e-mail, a primary team, an admin-made token. */
export const DEMO_SERVICE_USER = 'Demo CI';

const TEAMS = ['Platform', 'Mobile'] as const;
const PEOPLE = [
  { key: 'alice', name: 'Alice Admin', role: 'admin' as const, team: 'Platform', teamRole: 'member' as const },
  { key: 'bob', name: 'Bob Lead', role: 'member' as const, team: 'Platform', teamRole: 'lead' as const },
  { key: 'carol', name: 'Carol Dev', role: 'member' as const, team: 'Platform', teamRole: 'member' as const },
  { key: 'dave', name: 'Dave Mobile', role: 'member' as const, team: 'Mobile', teamRole: 'member' as const },
];
const PROJECTS = [
  { key: 'github.com/acme/billing', name: 'billing', team: 'Platform' },
  { key: 'github.com/acme/mobile-app', name: 'mobile-app', team: 'Mobile' },
];
const demoEmail = (key: string) => `${key}@acme.example`;

const day = (d: Date) => d.toISOString().slice(0, 10);
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

/**
 * Development seed (`pnpm db:seed`): the deployment is named SPECTADO (slug `spectado`); teams Platform and Mobile;
 * four people (alice admin, bob lead of Platform, carol, dave in Mobile); the ADMIN_EMAILS admin; a service user
 * "Demo CI" in Platform; tokens with an expiry (manual and device, plus one for the service user; random secrets, so
 * none of them can be used); model prices, 2 projects, ~300 turns with runs + usage over 60 days, daily rollups and one
 * budget. Idempotent: the demo telemetry, tokens and memberships are deleted and rebuilt each run; the demo identities
 * and teams are kept and reused (by e-mail / name), and nothing else in the database is touched (the ADMIN_EMAILS
 * member is only added when missing). Runs as the schema owner with `SET LOCAL ROLE app_definer`, so it also works
 * where the owner is not a superuser and FORCE RLS applies.
 */
export async function seed(url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL) {
  const { db, close } = createDb({ url, max: 1 });
  try {
    await ensureDefaultModelPrices(db);
    const summary = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.update(deployment).set({ name: DEMO_DEPLOYMENT.name, slug: DEMO_DEPLOYMENT.slug, updatedAt: new Date() });

      const userIds: Record<string, string> = {};
      for (const p of PEOPLE) userIds[p.key] = await demoUser(tx, demoEmail(p.key), p.name);
      const demoIds = Object.values(userIds);
      // Old demo state: telemetry (turns cascade to runs, usage, runaway alerts), rollups, tokens, memberships (team
      // memberships and per-user budgets cascade), the service user.
      await tx.delete(turns).where(or(like(turns.externalId, 'seed-%'), inArray(turns.userId, demoIds)));
      await tx.delete(agentSessions).where(or(like(agentSessions.externalId, 'seed-%'), inArray(agentSessions.userId, demoIds)));
      await tx.delete(dailyRollups).where(inArray(dailyRollups.userId, demoIds));
      await tx.delete(dailySkillMcpRollups).where(inArray(dailySkillMcpRollups.userId, demoIds));
      await tx.delete(ingestTokens).where(inArray(ingestTokens.userId, demoIds));
      await tx.delete(memberships).where(inArray(memberships.userId, demoIds));
      await tx.delete(users).where(and(eq(users.kind, 'service'), eq(users.name, DEMO_SERVICE_USER)));

      const teamIds: Record<string, string> = {};
      for (const name of TEAMS) {
        const [found] = await tx.select({ id: teams.id }).from(teams).where(eq(teams.name, name));
        teamIds[name] = found?.id ?? (await tx.insert(teams).values({ name }).returning({ id: teams.id }))[0]!.id;
      }
      await tx.delete(budgets).where(inArray(budgets.teamId, Object.values(teamIds)));
      for (const p of PEOPLE) {
        const userId = userIds[p.key]!;
        await tx.insert(memberships).values({ userId, role: p.role, primaryTeamId: teamIds[p.team] });
        await tx.insert(teamMemberships).values({ teamId: teamIds[p.team]!, userId, role: p.teamRole });
      }
      const adminId = await demoUser(tx, ADMIN_EMAIL, null);
      await tx.insert(memberships).values({ userId: adminId, role: 'admin' }).onConflictDoNothing();

      const [svc] = await tx.insert(users).values({ name: DEMO_SERVICE_USER, kind: 'service' }).returning({ id: users.id });
      await tx.insert(memberships).values({ userId: svc!.id, role: 'member', primaryTeamId: teamIds.Platform });
      await tx.insert(teamMemberships).values({ teamId: teamIds.Platform!, userId: svc!.id, role: 'member' });
      await tx.insert(ingestTokens).values([
        demoToken(userIds.alice!, userIds.alice!, 'alice laptop', 'manual', null, days(90)),
        demoToken(userIds.bob!, userIds.bob!, 'bob-macbook', 'device', 'bob-macbook', days(83)),
        demoToken(userIds.carol!, userIds.carol!, 'carol desktop', 'manual', null, days(10)),
        demoToken(svc!.id, userIds.alice!, 'ci runner', 'manual', null, days(365)),
      ]);

      const projectIds: Record<string, string> = {};
      for (const p of PROJECTS) {
        const [row] = await tx
          .insert(projects)
          .values({ key: p.key, displayName: p.name, teamId: teamIds[p.team] })
          .onConflictDoUpdate({ target: projects.key, set: { displayName: p.name, teamId: teamIds[p.team] } })
          .returning({ id: projects.id });
        projectIds[p.key] = row!.id;
      }

      const generated = generateTurns({
        actors: PEOPLE.map((p) => ({ key: p.key, team: p.team })),
        projects: PROJECTS.map((p) => ({ key: p.key, team: p.team })),
        count: 300,
        days: 60,
        now: new Date(),
      });
      const ctx = { teamIds, userIds, projectIds };
      const sessionIds = await insertSessions(tx, ctx, generated);
      let runCount = 0;
      for (const t of generated) runCount += await insertTurn(tx, ctx, sessionIds, t);
      await insertRollups(tx, ctx, generated);
      await tx.insert(budgets).values({ teamId: teamIds.Platform, kind: 'cost', limitValue: '100' });
      return { turns: generated.length, runs: runCount };
    });
    console.log(
      `seed: ${DEMO_DEPLOYMENT.name} with ${summary.turns} turns, ${summary.runs} sub-agent runs; admin ${ADMIN_EMAIL}; service user ${DEMO_SERVICE_USER}`,
    );
  } finally {
    await close();
  }
}

type Tx = Parameters<Parameters<ReturnType<typeof createDb>['db']['transaction']>[0]>[0];

/** A token row with a random secret nobody knows (the demo tokens only show up in the token lists). */
function demoToken(
  userId: string,
  createdByUserId: string,
  name: string,
  source: 'manual' | 'device',
  label: string | null,
  expiresAt: Date | null,
): typeof ingestTokens.$inferInsert {
  const secret = 'aiobs_u_' + randomBytes(32).toString('base64url');
  return {
    userId,
    createdByUserId,
    name,
    source,
    label,
    expiresAt,
    prefix: secret.slice(0, 12),
    hash: createHash('sha256').update(secret).digest('hex'),
  };
}

/** The person with this e-mail, created when missing (its name reset to the demo name when one is given). */
async function demoUser(tx: Tx, email: string, name: string | null): Promise<string> {
  const [found] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (found) {
    if (name) await tx.update(users).set({ name }).where(eq(users.id, found.id));
    return found.id;
  }
  const [u] = await tx.insert(users).values({ email, name, kind: 'person' }).returning({ id: users.id });
  return u!.id;
}

interface Ctx {
  teamIds: Record<string, string>;
  userIds: Record<string, string>;
  projectIds: Record<string, string>;
}

async function insertSessions(tx: Tx, c: Ctx, all: SeedTurn[]) {
  const ids = new Map<string, string>();
  for (const t of all) {
    if (ids.has(t.sessionKey)) continue;
    const group = all.filter((x) => x.sessionKey === t.sessionKey);
    const [s] = await tx
      .insert(agentSessions)
      .values({
        teamId: c.teamIds[t.actor.team],
        userId: c.userIds[t.actor.key],
        projectId: c.projectIds[t.project.key],
        externalId: `seed-${t.sessionKey}`,
        harness: t.harness,
        harnessVersion: t.harness === 'claude-code' ? '2.9.0' : '0.60.0',
        startedAt: new Date(Math.min(...group.map((x) => x.startedAt.getTime()))),
        endedAt: new Date(Math.max(...group.map((x) => x.endedAt.getTime()))),
        endReason: 'exit',
      })
      .returning({ id: agentSessions.id });
    ids.set(t.sessionKey, s!.id);
  }
  return ids;
}

const tok = (x: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; requests: number }) => ({
  inputTokens: x.input,
  outputTokens: x.output,
  cacheReadTokens: x.cacheRead,
  cacheWriteTokens: x.cacheWrite,
  reasoningTokens: x.reasoning,
  requests: x.requests,
});

async function insertTurn(tx: Tx, c: Ctx, sessionIds: Map<string, string>, t: SeedTurn): Promise<number> {
  // Team attribution rule 1: every demo project is mapped to a team.
  const owner = { teamId: c.teamIds[t.project.team]!, userId: c.userIds[t.actor.key]! };
  const [turn] = await tx
    .insert(turns)
    .values({
      ...owner,
      attribution: 'verified',
      sessionId: sessionIds.get(t.sessionKey),
      projectId: c.projectIds[t.project.key],
      externalId: `seed-${t.externalId}`,
      harness: t.harness,
      model: t.model,
      effort: t.effort,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      durationMs: t.durationMs,
      ...tok(t),
      phasesMs: t.phasesMs,
      tools: t.tools,
      skills: t.skills,
      mcp: t.mcp,
      mcpStats: t.mcpStats,
      filesTouched: t.filesTouched,
      linesAdded: t.linesAdded,
      linesRemoved: t.linesRemoved,
      outcome: t.outcome,
      outcomeSignals: t.signals,
      outcomeProvisional: false,
      summary: t.summary,
    })
    .returning({ id: turns.id });
  const turnId = turn!.id;
  await tx.insert(usage).values(t.usage.map((u) => ({ ...owner, turnId, startedAt: t.startedAt, model: u.model, effort: u.effort, ...tok(u) })));
  const runIds: string[] = [];
  for (const r of t.runs) {
    const [row] = await tx
      .insert(runs)
      .values({
        ...owner,
        turnId,
        turnExternalId: `seed-${t.externalId}`,
        parentRunId: r.parentIndex === null ? null : runIds[r.parentIndex],
        parentExternalId: r.parentIndex === null ? null : t.runs[r.parentIndex]!.externalId,
        externalId: r.externalId,
        agentType: r.agentType,
        depth: r.depth,
        model: r.model,
        effort: r.effort,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationMs: r.durationMs,
        ...tok(r),
        phasesMs: r.phasesMs,
        mcp: r.mcp,
        mcpStats: r.mcpStats,
        outcome: r.outcome,
        outcomeProvisional: false,
      })
      .returning({ id: runs.id });
    runIds.push(row!.id);
    await tx.insert(usage).values({ ...owner, turnId, runId: row!.id, startedAt: r.startedAt, model: r.usage.model, effort: r.usage.effort, ...tok(r.usage) });
  }
  return t.runs.length;
}

/**
 * Same fold as the worker (apps/worker/src/rollups/aggregate.ts, ADR-0015): day × team ×
 * user × project × harness × model × effort. Turn count, runs, duration, phases and outcome go to the
 * turn's primary model × effort; tokens go to each usage row's model × effort (sub-agents included).
 */
async function insertRollups(tx: Tx, c: Ctx, all: SeedTurn[]) {
  const groups = new Map<string, typeof dailyRollups.$inferInsert>();
  const group = (t: SeedTurn, model: string, effort: string | null) => {
    const teamId = c.teamIds[t.project.team]!;
    const k = [day(t.startedAt), teamId, t.actor.key, t.project.key, t.harness, model, effort].join('|');
    let g = groups.get(k);
    if (!g) {
      g = {
        day: day(t.startedAt), teamId, userId: c.userIds[t.actor.key], projectId: c.projectIds[t.project.key],
        harness: t.harness, model, effort, turns: 0, runs: 0, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0, durationMs: 0, phasesMs: {},
        success: 0, failed: 0, abandoned: 0, unknown: 0,
        wastedInputTokens: 0, wastedOutputTokens: 0, wastedCacheReadTokens: 0, wastedCacheWriteTokens: 0,
        unknownInputTokens: 0, unknownOutputTokens: 0, unknownCacheReadTokens: 0, unknownCacheWriteTokens: 0, outcomeSplit: true,
      };
      groups.set(k, g);
    }
    return g;
  };
  for (const t of all) {
    const g = group(t, t.model, t.effort);
    g.turns! += 1;
    g.runs! += t.runs.length;
    g.durationMs! += t.durationMs;
    for (const [ph, ms] of Object.entries(t.phasesMs)) g.phasesMs![ph] = (g.phasesMs![ph] ?? 0) + (ms ?? 0);
    g[t.outcome]! += 1;
    for (const u of [...t.usage, ...t.runs.map((r) => r.usage)]) {
      const ug = group(t, u.model, u.effort);
      ug.inputTokens! += u.input;
      ug.outputTokens! += u.output;
      ug.cacheReadTokens! += u.cacheRead;
      ug.cacheWriteTokens! += u.cacheWrite;
      ug.reasoningTokens! += u.reasoning;
      ug.requests! += u.requests;
      if (t.outcome === 'failed' || t.outcome === 'abandoned') {
        ug.wastedInputTokens! += u.input;
        ug.wastedOutputTokens! += u.output;
        ug.wastedCacheReadTokens! += u.cacheRead;
        ug.wastedCacheWriteTokens! += u.cacheWrite;
      } else if (t.outcome === 'unknown') {
        ug.unknownInputTokens! += u.input;
        ug.unknownOutputTokens! += u.output;
        ug.unknownCacheReadTokens! += u.cacheRead;
        ug.unknownCacheWriteTokens! += u.cacheWrite;
      }
    }
  }
  await tx.insert(dailyRollups).values([...groups.values()]);
  await insertSkillMcpRollups(tx, c, all);
}

/** Same fold as the worker's aggregateSkillMcp: per turn (main agent + runs) one row per skill, MCP server and tool. */
async function insertSkillMcpRollups(tx: Tx, c: Ctx, all: SeedTurn[]) {
  const groups = new Map<string, typeof dailySkillMcpRollups.$inferInsert>();
  type Rel = { errors: number; denied: number; ms: number; buckets: number[] };
  const add = (t: SeedTurn, kind: 'skill' | 'mcp', name: string, tool: string, model: number, user: number, rel: Rel | null = null) => {
    const teamId = c.teamIds[t.project.team]!;
    const k = [day(t.startedAt), teamId, t.actor.key, t.project.key, t.harness, t.model, kind, name, tool].join('|');
    let g = groups.get(k);
    if (!g) {
      g = {
        day: day(t.startedAt), teamId, userId: c.userIds[t.actor.key], projectId: c.projectIds[t.project.key],
        harness: t.harness, model: t.model, kind, name, tool, calls: 0, modelCalls: 0, userCalls: 0, turns: 0,
        success: 0, failed: 0, abandoned: 0, unknown: 0, outcomeSplit: true,
        errors: 0, denied: 0, latencyMs: 0, lat0: 0, lat1: 0, lat2: 0, lat3: 0, lat4: 0,
      };
      groups.set(k, g);
    }
    if (rel) {
      g.errors! += rel.errors;
      g.denied! += rel.denied;
      g.latencyMs! += rel.ms;
      g.lat0! += rel.buckets[0]!;
      g.lat1! += rel.buckets[1]!;
      g.lat2! += rel.buckets[2]!;
      g.lat3! += rel.buckets[3]!;
      g.lat4! += rel.buckets[4]!;
    }
    g.calls! += model + user;
    g.modelCalls! += model;
    g.userCalls! += user;
    g.turns! += 1;
    g[t.outcome]! += 1;
  };
  for (const t of all) {
    for (const [name, s] of Object.entries(t.skills)) add(t, 'skill', name, '', s.model, s.user);
    const mcp = new Map<string, Map<string, number>>();
    const rels = new Map<string, Rel>();
    const relOf = (key: string) => rels.get(key) ?? (rels.set(key, { errors: 0, denied: 0, ms: 0, buckets: [0, 0, 0, 0, 0] }), rels.get(key)!);
    for (const [calls, stats] of [[t.mcp, t.mcpStats], ...t.runs.map((r) => [r.mcp, r.mcpStats] as const)] as const) {
      for (const [server, tools] of Object.entries(calls)) {
        const m = mcp.get(server) ?? new Map<string, number>();
        for (const [tool, n] of Object.entries(tools)) m.set(tool, (m.get(tool) ?? 0) + n);
        mcp.set(server, m);
      }
      for (const [server, tools] of Object.entries(stats)) {
        for (const [tool, x] of Object.entries(tools)) {
          for (const key of [`${server}\u0000${tool}`, `${server}\u0000`]) {
            const r = relOf(key);
            r.errors += x.errors;
            r.denied += x.denied;
            r.ms += x.ms;
            x.buckets.forEach((b, i) => (r.buckets[i]! += b));
          }
        }
      }
    }
    for (const [server, tools] of mcp) {
      let total = 0;
      for (const [tool, n] of tools) {
        add(t, 'mcp', server, tool, n, 0, rels.get(`${server}\u0000${tool}`) ?? null);
        total += n;
      }
      add(t, 'mcp', server, '', total, 0, rels.get(`${server}\u0000`) ?? null);
    }
  }
  if (groups.size) await tx.insert(dailySkillMcpRollups).values([...groups.values()]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
