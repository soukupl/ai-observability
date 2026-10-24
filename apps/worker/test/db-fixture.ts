import { sql } from 'drizzle-orm';
import {
  agentSessions, authSessions, budgets, deviceCodes, ingestEvents, magicLinks, memberships, pendingSessionPatches, pendingTurnPatches, runs, teamMemberships, teams,
  turns, usage, users, type Database, type DeploymentSettings,
} from '@ai-obs/db';

/**
 * Own test database so the worker tests never touch the db package's databases or the dev database. Its name is
 * derived from TEST_DATABASE_URL (`<name>_worker` before the `_test` suffix, or the given name when it already names a
 * worker database). Reuses the db package's harness (drop/create + migrations); it reads TEST_DATABASE_URL at import
 * time, hence the dynamic import after the env is set.
 */
function workerTestUrl(): string {
  const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test');
  const name = base.pathname.slice(1) || 'ai_obs_test';
  base.pathname = `/${/worker/.test(name) ? name : `${name.replace(/_test$/, '')}_worker_test`}`;
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
  teamA: string;
  teamB: string;
  alice: string; // admin
  bob: string; // lead of team A
  carol: string; // member of team A
  dave: string; // member of team B
}

/**
 * Starts a test from a clean deployment (ADR-0028: one deployment, so tests cannot isolate by company any more):
 * empties every tenancy, telemetry and reporting table, sets the one deployment row's name and settings, and adds
 * teams A and B with alice (admin), bob (lead of A), carol (member of A) and dave (member of B), e-mails `<name>@<slug>.test`.
 */
export async function seedDeployment(
  db: Database,
  over: { slug?: string; retentionDays?: number; visibility?: 'aggregates-only' | 'full'; runawayCostUsd?: number; runawayHours?: number } = {},
): Promise<Seeded> {
  const slug = over.slug ?? 'acme';
  await db.execute(sql`truncate users, teams, projects, machines, agent_sessions, turns, runs, usage, runaway_alerts,
    pending_turn_patches, pending_session_patches, daily_rollups, daily_skill_mcp_rollups, budgets, ingest_events,
    magic_links, auth_sessions, device_codes, ingest_tokens, invitations, audit_log cascade`);
  const settings: DeploymentSettings = {
    individualVisibility: over.visibility ?? 'aggregates-only', projectNaming: 'plain', retentionDays: over.retentionDays ?? 90,
    ...(over.runawayCostUsd === undefined ? {} : { runawayCostUsd: over.runawayCostUsd }),
    ...(over.runawayHours === undefined ? {} : { runawayHours: over.runawayHours }),
  };
  await db.execute(sql`update deployment set name = ${`Co ${slug}`}, slug = ${slug}, settings = ${JSON.stringify(settings)}::jsonb`);
  return ownerTx(db, async (tx) => {
    const [a, b] = await tx.insert(teams).values([{ name: 'A' }, { name: 'B' }]).returning({ id: teams.id });
    const mk = async (name: string, role: 'admin' | 'member', team: string) => {
      const [u] = await tx.insert(users).values({ email: `${name}@${slug}.test`, name }).returning({ id: users.id });
      await tx.insert(memberships).values({ userId: u!.id, role, primaryTeamId: team });
      return u!.id;
    };
    const alice = await mk('alice', 'admin', a!.id);
    const bob = await mk('bob', 'member', a!.id);
    const carol = await mk('carol', 'member', a!.id);
    const dave = await mk('dave', 'member', b!.id);
    await tx.insert(teamMemberships).values([
      { teamId: a!.id, userId: bob, role: 'lead' },
      { teamId: a!.id, userId: carol, role: 'member' },
      { teamId: b!.id, userId: dave, role: 'member' },
    ]);
    return { teamA: a!.id, teamB: b!.id, alice, bob, carol, dave };
  });
}

/** Changes the deployment settings in place (keeps the data). */
export const updateSettings = (db: Database, patch: Partial<DeploymentSettings>) =>
  db.execute(sql`update deployment set settings = settings || ${JSON.stringify(patch)}::jsonb`);

/** A service user (no e-mail, ADR-0029) with a membership in `team`. */
export async function addServiceUser(db: Database, name: string, team: string): Promise<string> {
  return ownerTx(db, async (tx) => {
    const [u] = await tx.insert(users).values({ name, kind: 'service' }).returning({ id: users.id });
    await tx.insert(memberships).values({ userId: u!.id, role: 'member', primaryTeamId: team });
    await tx.insert(teamMemberships).values({ teamId: team, userId: u!.id, role: 'member' });
    return u!.id;
  });
}

/** Removes the membership the way `admin_remove_member` does for the parts the worker reads (team memberships cascade). */
export async function removeMembership(db: Database, userId: string): Promise<void> {
  await ownerTx(db, (tx) => tx.execute(sql`delete from memberships where user_id = ${userId}::uuid`));
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
  mcpStats?: Record<string, Record<string, { errors: number; denied: number; ms: number; buckets: number[] }>>;
}

/** Inserts a turn with one session, one run per extra usage entry and matching usage rows. */
export async function addTurn(db: Database, s: TurnSpec): Promise<string> {
  return ownerTx(db, async (tx) => {
    const started = new Date(s.at);
    const stamp = new Date(s.stamp ?? s.at);
    const sum = (i: number) => s.usage.reduce((a, u) => a + (u[i] as number), 0);
    let sessionId: string;
    const existing = s.session
      ? await tx.select({ id: agentSessions.id }).from(agentSessions).where(sql`${agentSessions.externalId} = ${s.session}`)
      : [];
    if (existing[0]) sessionId = existing[0].id;
    else {
      const [ses] = await tx
        .insert(agentSessions)
        .values({ teamId: s.team, userId: s.user, externalId: s.session ?? `s-${s.key}`, harness: 'claude-code', startedAt: started })
        .returning({ id: agentSessions.id });
      sessionId = ses!.id;
    }
    const [t] = await tx
      .insert(turns)
      .values({
        teamId: s.team, userId: s.user, attribution: s.user ? 'verified' : 'unverified', sessionId,
        externalId: `t-${s.key}`, harness: 'claude-code', model: s.model ?? s.usage[0]![0], effort: s.effort === undefined ? s.usage[0]![1] : s.effort,
        startedAt: started, endedAt: new Date(started.getTime() + 60_000), durationMs: 60_000,
        inputTokens: sum(2), outputTokens: sum(3), cacheReadTokens: sum(4), cacheWriteTokens: sum(5), requests: s.usage.length,
        phasesMs: { thinking: 40_000, coding: 20_000 }, outcome: s.outcome ?? 'success', createdAt: stamp, updatedAt: stamp,
        skills: s.skills ?? {}, mcp: s.mcp ?? {}, mcpStats: s.mcpStats ?? {},
      })
      .returning({ id: turns.id });
    for (const [i, u] of s.usage.entries()) {
      let runId: string | null = null;
      if (i > 0) {
        const [r] = await tx
          .insert(runs)
          .values({
            teamId: s.team, userId: s.user, turnId: t!.id, turnExternalId: `t-${s.key}`, externalId: `r${i}`, agentType: 'Explore',
            depth: 1, startedAt: started, endedAt: started, createdAt: stamp, mcp: i === 1 ? (s.runMcp ?? {}) : {},
          })
          .returning({ id: runs.id });
        runId = r!.id;
      }
      await tx.insert(usage).values({
        teamId: s.team, userId: s.user, turnId: t!.id, runId, startedAt: started, model: u[0], effort: u[1],
        inputTokens: u[2], outputTokens: u[3], cacheReadTokens: u[4], cacheWriteTokens: u[5], requests: 1,
      });
    }
    return t!.id;
  });
}

export const addBudget = (db: Database, b: { teamId?: string; userId?: string; kind: 'tokens' | 'cost'; limit: number }) =>
  ownerTx(db, async (tx) => {
    const [r] = await tx.insert(budgets).values({ teamId: b.teamId, userId: b.userId, kind: b.kind, limitValue: String(b.limit) }).returning({ id: budgets.id });
    return r!.id;
  });

export const addNoise = (db: Database, userId: string, nowIso: string) =>
  ownerTx(db, async (tx) => {
    const ago = (days: number) => new Date(new Date(nowIso).getTime() - days * 86_400_000);
    await tx.insert(ingestEvents).values([
      { eventId: 'old', type: 'turn', receivedAt: ago(31) },
      { eventId: 'new', type: 'turn', receivedAt: ago(1) },
    ]);
    await tx.insert(magicLinks).values([
      { email: 'a@x.test', tokenHash: 'h1', expiresAt: ago(1) },
      { email: 'b@x.test', tokenHash: 'h2', expiresAt: new Date(new Date(nowIso).getTime() + 3_600_000) },
    ]);
    // a parked patch whose turn never came (and outlived its user), and a fresh one still waiting
    await tx.insert(pendingTurnPatches).values([
      { turnExternalId: 'claude-code:gone', summary: 'secret summary', receivedAt: ago(400) },
      { turnExternalId: 'claude-code:soon', summary: 'waiting', receivedAt: ago(1) },
    ]);
    await tx.insert(pendingSessionPatches).values([
      { sessionExternalId: 'claude-code:gone-s', title: 'secret title', titleSource: 'ai', receivedAt: ago(400) },
      { sessionExternalId: 'claude-code:soon-s', title: 'waiting', titleSource: 'custom', receivedAt: ago(1) },
    ]);
    await tx.insert(authSessions).values([
      { userId, tokenHash: 's1', expiresAt: ago(2) },
      { userId, tokenHash: 's2', expiresAt: new Date(new Date(nowIso).getTime() + 3_600_000) },
    ]);
    // device-login codes (ADR-0029): one expired two days ago (deleted), one open code just past its expiry (marked
    // expired, kept for a day), one still open
    const code = (userCode: string, expiresAt: Date) => ({
      deviceCodeHash: `hash-${userCode}`, userCode, clientName: 'ai-obs cli', clientVersion: '0.5.0', requesterIp: '127.0.0.1', expiresAt,
    });
    await tx.insert(deviceCodes).values([
      code('AAAAAAAA', ago(2)),
      code('BBBBBBBB', new Date(new Date(nowIso).getTime() - 60_000)),
      code('CCCCCCCC', new Date(new Date(nowIso).getTime() + 600_000)),
    ]);
  });
