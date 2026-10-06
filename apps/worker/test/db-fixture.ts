import { sql } from 'drizzle-orm';
import {
  agentSessions, authSessions, budgets, companies, ingestEvents, magicLinks, pendingTurnPatches, runs, teamMemberships, teams, turns, usage, users,
  type Database,
} from '@ai-obs/db';

/**
 * Own test database (ai_obs_worker_test) so the worker tests never touch ai_obs_test of the db package or
 * the dev database. Reuses the db package's harness (drop/create + migrations); it reads TEST_DATABASE_URL
 * at import time, hence the dynamic import after the env is set.
 */
function workerTestUrl(): string {
  const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test');
  base.pathname = '/ai_obs_worker_test';
  return base.toString();
}

export async function openWorkerTestDb() {
  process.env.TEST_DATABASE_URL = workerTestUrl();
  const h = await import('../../../packages/db/test/db-harness.js');
  const skip = await h.prepareTestDatabase();
  return { skip, h };
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export const ownerTx = <T>(db: Database, fn: (tx: Tx) => Promise<T>) =>
  db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_definer`);
    return fn(tx);
  });

export interface Seeded {
  companyId: string;
  teamA: string;
  teamB: string;
  alice: string; // company admin
  bob: string; // lead of team A
  carol: string; // member of team A
  dave: string; // member of team B
}

export async function seedCompany(db: Database, over: { slug?: string; plan?: 'free' | 'team' | 'business'; retentionDays?: number; visibility?: 'aggregates-only' | 'full' } = {}): Promise<Seeded> {
  return ownerTx(db, async (tx) => {
    const slug = over.slug ?? 'acme';
    const [c] = await tx
      .insert(companies)
      .values({
        name: `Co ${slug}`, slug, plan: over.plan ?? 'team',
        settings: { individualVisibility: over.visibility ?? 'aggregates-only', projectNaming: 'plain', retentionDays: over.retentionDays ?? 90 },
      })
      .returning({ id: companies.id });
    const companyId = c!.id;
    const [a, b] = await tx.insert(teams).values([{ companyId, name: 'A' }, { companyId, name: 'B' }]).returning({ id: teams.id });
    const mk = async (name: string, role: 'admin' | 'member', team: string) => {
      const [u] = await tx
        .insert(users)
        .values({ companyId, email: `${name}@${slug}.test`, name, companyRole: role, primaryTeamId: team })
        .returning({ id: users.id });
      return u!.id;
    };
    const alice = await mk('alice', 'admin', a!.id);
    const bob = await mk('bob', 'member', a!.id);
    const carol = await mk('carol', 'member', a!.id);
    const dave = await mk('dave', 'member', b!.id);
    await tx.insert(teamMemberships).values([
      { companyId, teamId: a!.id, userId: bob, role: 'lead' },
      { companyId, teamId: a!.id, userId: carol, role: 'member' },
      { companyId, teamId: b!.id, userId: dave, role: 'member' },
    ]);
    return { companyId, teamA: a!.id, teamB: b!.id, alice, bob, carol, dave };
  });
}

export interface TurnSpec {
  key: string;
  at: string; // ISO start
  user: string | null;
  team: string;
  model?: string;
  effort?: string | null;
  outcome?: 'success' | 'failed' | 'abandoned' | 'unknown';
  /** [model, effort, input, output, cacheRead, cacheWrite][] ; first entry is the main agent, the rest are sub-agent runs */
  usage: Array<[string, string | null, number, number, number, number]>;
  session?: string;
  /** createdAt/updatedAt stamp (default: the turn start) */
  stamp?: string;
  /** skill / MCP use of the turn (main agent) and of its first sub-agent run */
  skills?: Record<string, { model: number; user: number }>;
  mcp?: Record<string, Record<string, number>>;
  runMcp?: Record<string, Record<string, number>>;
}

/** Inserts a turn with one session, one run per extra usage entry and matching usage rows. */
export async function addTurn(db: Database, companyId: string, s: TurnSpec): Promise<string> {
  return ownerTx(db, async (tx) => {
    const started = new Date(s.at);
    const stamp = new Date(s.stamp ?? s.at);
    const sum = (i: number) => s.usage.reduce((a, u) => a + (u[i] as number), 0);
    let sessionId: string;
    const existing = s.session
      ? await tx.select({ id: agentSessions.id }).from(agentSessions).where(sql`${agentSessions.companyId} = ${companyId} and ${agentSessions.externalId} = ${s.session}`)
      : [];
    if (existing[0]) sessionId = existing[0].id;
    else {
      const [ses] = await tx
        .insert(agentSessions)
        .values({ companyId, teamId: s.team, userId: s.user, externalId: s.session ?? `s-${s.key}`, harness: 'claude-code', startedAt: started })
        .returning({ id: agentSessions.id });
      sessionId = ses!.id;
    }
    const [t] = await tx
      .insert(turns)
      .values({
        companyId, teamId: s.team, userId: s.user, attribution: s.user ? 'verified' : 'unverified', sessionId,
        externalId: `t-${s.key}`, harness: 'claude-code', model: s.model ?? s.usage[0]![0], effort: s.effort === undefined ? s.usage[0]![1] : s.effort,
        startedAt: started, endedAt: new Date(started.getTime() + 60_000), durationMs: 60_000,
        inputTokens: sum(2), outputTokens: sum(3), cacheReadTokens: sum(4), cacheWriteTokens: sum(5), requests: s.usage.length,
        phasesMs: { thinking: 40_000, coding: 20_000 }, outcome: s.outcome ?? 'success', createdAt: stamp, updatedAt: stamp,
        skills: s.skills ?? {}, mcp: s.mcp ?? {},
      })
      .returning({ id: turns.id });
    for (const [i, u] of s.usage.entries()) {
      let runId: string | null = null;
      if (i > 0) {
        const [r] = await tx
          .insert(runs)
          .values({
            companyId, teamId: s.team, userId: s.user, turnId: t!.id, turnExternalId: `t-${s.key}`, externalId: `r${i}`, agentType: 'Explore',
            depth: 1, startedAt: started, endedAt: started, createdAt: stamp, mcp: i === 1 ? (s.runMcp ?? {}) : {},
          })
          .returning({ id: runs.id });
        runId = r!.id;
      }
      await tx.insert(usage).values({
        companyId, teamId: s.team, userId: s.user, turnId: t!.id, runId, startedAt: started, model: u[0], effort: u[1],
        inputTokens: u[2], outputTokens: u[3], cacheReadTokens: u[4], cacheWriteTokens: u[5], requests: 1,
      });
    }
    return t!.id;
  });
}

export const addBudget = (db: Database, companyId: string, b: { teamId?: string; userId?: string; kind: 'tokens' | 'cost'; limit: number }) =>
  ownerTx(db, async (tx) => {
    const [r] = await tx.insert(budgets).values({ companyId, teamId: b.teamId, userId: b.userId, kind: b.kind, limitValue: String(b.limit) }).returning({ id: budgets.id });
    return r!.id;
  });

export const addNoise = (db: Database, companyId: string, userId: string, nowIso: string) =>
  ownerTx(db, async (tx) => {
    const ago = (days: number) => new Date(new Date(nowIso).getTime() - days * 86_400_000);
    await tx.insert(ingestEvents).values([
      { companyId, eventId: 'old', type: 'turn', receivedAt: ago(31) },
      { companyId, eventId: 'new', type: 'turn', receivedAt: ago(1) },
    ]);
    await tx.insert(magicLinks).values([
      { email: 'a@x.test', tokenHash: 'h1', expiresAt: ago(1) },
      { email: 'b@x.test', tokenHash: 'h2', expiresAt: new Date(new Date(nowIso).getTime() + 3_600_000) },
    ]);
    // a parked patch whose turn never came (and outlived its user), and a fresh one still waiting
    await tx.insert(pendingTurnPatches).values([
      { companyId, turnExternalId: 'claude-code:gone', summary: 'secret summary', receivedAt: ago(400) },
      { companyId, turnExternalId: 'claude-code:soon', summary: 'waiting', receivedAt: ago(1) },
    ]);
    await tx.insert(authSessions).values([
      { userId, tokenHash: 's1', expiresAt: ago(2) },
      { userId, tokenHash: 's2', expiresAt: new Date(new Date(nowIso).getTime() + 3_600_000) },
    ]);
  });
