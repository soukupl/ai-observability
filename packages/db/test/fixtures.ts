import { sql } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import {
  agentSessions,
  dailyRollups,
  deployment,
  memberships,
  runs,
  teamMemberships,
  teams,
  turns,
  usage,
  users,
} from '../src/schema/index.js';
import type { MemberRole, TeamRole } from '../src/schema/enums.js';
import type { IndividualVisibility } from '../src/schema/settings.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface Person {
  id: string;
  role: MemberRole;
}

interface MemberSpec {
  key: string;
  role?: MemberRole;
  teams: Array<[teamKey: string, role: TeamRole]>;
}

export interface DeploymentFixture {
  teams: Record<string, string>;
  people: Record<string, Person>;
  /** turn id → owning user id (null = unverified, an old company-token turn). */
  turns: Map<string, string | null>;
}

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);

async function addTurn(tx: Tx, prefix: string, teamId: string, userId: string | null, n: number) {
  const started = at(n + 1);
  const [s] = await tx
    .insert(agentSessions)
    .values({ teamId, userId, externalId: `s-${prefix}-${n}`, harness: 'claude-code', startedAt: started })
    .returning({ id: agentSessions.id });
  const [t] = await tx
    .insert(turns)
    .values({
      teamId, userId, sessionId: s!.id,
      attribution: userId ? 'verified' : 'unverified',
      externalId: `t-${prefix}-${n}`, harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high',
      startedAt: started, endedAt: new Date(started.getTime() + 60_000), durationMs: 60_000,
      inputTokens: 100, outputTokens: 10, phasesMs: { thinking: 40_000, coding: 20_000 }, outcome: 'success',
      summary: 'Did a thing',
    })
    .returning({ id: turns.id });
  const [r] = await tx
    .insert(runs)
    .values({
      teamId, userId, turnId: t!.id, turnExternalId: `t-${prefix}-${n}`, externalId: 'r1',
      agentType: 'Explore', depth: 1, startedAt: started, endedAt: started, inputTokens: 5,
    })
    .returning({ id: runs.id });
  await tx.insert(usage).values([
    { teamId, userId, turnId: t!.id, startedAt: started, model: 'claude-opus-5-5', effort: 'high', inputTokens: 95, outputTokens: 10 },
    { teamId, userId, turnId: t!.id, runId: r!.id, startedAt: started, model: 'claude-haiku-4-5', inputTokens: 5 },
  ]);
  await tx.insert(dailyRollups).values({
    teamId, userId, day: started.toISOString().slice(0, 10), harness: 'claude-code',
    model: 'claude-opus-5-5', effort: 'high', turns: 1, inputTokens: 100, outputTokens: 10, success: 1,
  });
  return t!.id;
}

/** Runs `fn` as app_definer (the owner is bound by FORCE RLS unless it is a superuser). */
export async function asDefiner<T>(owner: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return owner.transaction(async (tx) => {
    await tx.execute(sql`set local role app_definer`);
    return fn(tx);
  });
}

/** Sets the deployment's individual-visibility mode (as app_definer). */
export async function setVisibility(owner: Database, mode: IndividualVisibility): Promise<void> {
  await asDefiner(owner, (tx) =>
    tx.execute(sql`update deployment set settings = jsonb_set(settings, '{individualVisibility}', to_jsonb(${mode}::text))`),
  );
}

/**
 * Fills the deployment (the one row migration 0018 created): teams, people (each a person with a membership, team
 * memberships and one turn on their primary team, the first team listed) and optionally an unverified turn. `prefix`
 * keeps e-mails, team names and external ids unique when one database gets several fixtures.
 */
export async function createDeployment(
  db: Database,
  prefix: string,
  visibility: IndividualVisibility,
  teamKeys: string[],
  members: MemberSpec[],
  unverifiedTurnTeam?: string,
): Promise<DeploymentFixture> {
  return asDefiner(db, async (tx) => {
    await tx
      .update(deployment)
      .set({ settings: { individualVisibility: visibility, projectNaming: 'plain', retentionDays: 395 } });
    const fx: DeploymentFixture = { teams: {}, people: {}, turns: new Map() };
    for (const key of teamKeys) {
      const [t] = await tx.insert(teams).values({ name: `${prefix}-${key}` }).returning({ id: teams.id });
      fx.teams[key] = t!.id;
    }
    let n = 0;
    for (const m of members) {
      const role = m.role ?? 'member';
      const primary = fx.teams[m.teams[0]![0]]!;
      const [u] = await tx
        .insert(users)
        .values({ email: `${m.key}@${prefix}.test`, name: m.key })
        .returning({ id: users.id });
      await tx.insert(memberships).values({ userId: u!.id, role, primaryTeamId: primary });
      fx.people[m.key] = { id: u!.id, role };
      for (const [teamKey, teamRole] of m.teams) {
        await tx.insert(teamMemberships).values({ teamId: fx.teams[teamKey]!, userId: u!.id, role: teamRole });
      }
      fx.turns.set(await addTurn(tx, prefix, primary, u!.id, n++), u!.id);
    }
    if (unverifiedTurnTeam) {
      fx.turns.set(await addTurn(tx, prefix, fx.teams[unverifiedTurnTeam]!, null, n++), null);
    }
    return fx;
  });
}
