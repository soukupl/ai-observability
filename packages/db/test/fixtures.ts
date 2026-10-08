import { sql } from 'drizzle-orm';
import type { Database } from '../src/client.js';
import {
  agentSessions,
  companies,
  companyMemberships,
  dailyRollups,
  runs,
  teamMemberships,
  teams,
  turns,
  usage,
  users,
} from '../src/schema/index.js';
import type { CompanyRole, TeamRole } from '../src/schema/enums.js';
import type { IndividualVisibility } from '../src/schema/settings.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface Person {
  id: string;
  companyId: string;
  role: CompanyRole;
}

interface MemberSpec {
  key: string;
  role?: CompanyRole;
  teams: Array<[teamKey: string, role: TeamRole]>;
}

export interface CompanyFixture {
  id: string;
  teams: Record<string, string>;
  people: Record<string, Person>;
  /** turn id → owning user id (null = unverified). */
  turns: Map<string, string | null>;
}

const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);

async function addTurn(tx: Tx, companyId: string, teamId: string, userId: string | null, n: number) {
  const started = at(n + 1);
  const [s] = await tx
    .insert(agentSessions)
    .values({ companyId, teamId, userId, externalId: `s-${companyId}-${n}`, harness: 'claude-code', startedAt: started })
    .returning({ id: agentSessions.id });
  const [t] = await tx
    .insert(turns)
    .values({
      companyId, teamId, userId, sessionId: s!.id,
      attribution: userId ? 'verified' : 'unverified',
      externalId: `t-${companyId}-${n}`, harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high',
      startedAt: started, endedAt: new Date(started.getTime() + 60_000), durationMs: 60_000,
      inputTokens: 100, outputTokens: 10, phasesMs: { thinking: 40_000, coding: 20_000 }, outcome: 'success',
      summary: 'Did a thing',
    })
    .returning({ id: turns.id });
  const [r] = await tx
    .insert(runs)
    .values({
      companyId, teamId, userId, turnId: t!.id, turnExternalId: `t-${companyId}-${n}`, externalId: 'r1',
      agentType: 'Explore', depth: 1, startedAt: started, endedAt: started, inputTokens: 5,
    })
    .returning({ id: runs.id });
  await tx.insert(usage).values([
    { companyId, teamId, userId, turnId: t!.id, startedAt: started, model: 'claude-opus-5-5', effort: 'high', inputTokens: 95, outputTokens: 10 },
    { companyId, teamId, userId, turnId: t!.id, runId: r!.id, startedAt: started, model: 'claude-haiku-4-5', inputTokens: 5 },
  ]);
  await tx.insert(dailyRollups).values({
    companyId, teamId, userId, day: started.toISOString().slice(0, 10), harness: 'claude-code',
    model: 'claude-opus-5-5', effort: 'high', turns: 1, inputTokens: 100, outputTokens: 10, success: 1,
  });
  return t!.id;
}

/**
 * Adds an existing identity to a company (ADR-0022: one login, many companies) as app_definer. Team memberships are
 * up to the caller.
 */
export async function addMembership(
  owner: Database,
  userId: string,
  companyId: string,
  role: CompanyRole,
  primaryTeamId: string | null = null,
): Promise<Person> {
  await owner.transaction(async (tx) => {
    await tx.execute(sql`set local role app_definer`);
    await tx.insert(companyMemberships).values({ companyId, userId, companyRole: role, primaryTeamId });
  });
  return { id: userId, companyId, role };
}

/**
 * Inserts a company with teams, people (each an identity plus a membership, with one turn) and optionally an
 * unverified turn.
 */
export async function createCompany(
  db: Database,
  slug: string,
  visibility: IndividualVisibility,
  teamKeys: string[],
  members: MemberSpec[],
  unverifiedTurnTeam?: string,
): Promise<CompanyFixture> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role app_definer`);
    const [c] = await tx
      .insert(companies)
      .values({ name: slug, slug, settings: { individualVisibility: visibility, projectNaming: 'plain', retentionDays: 395 } })
      .returning({ id: companies.id });
    const companyId = c!.id;
    const fx: CompanyFixture = { id: companyId, teams: {}, people: {}, turns: new Map() };
    for (const key of teamKeys) {
      const [t] = await tx.insert(teams).values({ companyId, name: key }).returning({ id: teams.id });
      fx.teams[key] = t!.id;
    }
    let n = 0;
    for (const m of members) {
      const role = m.role ?? 'member';
      const primary = fx.teams[m.teams[0]![0]]!;
      const [u] = await tx
        .insert(users)
        .values({ email: `${m.key}@${slug}.test`, name: m.key })
        .returning({ id: users.id });
      await tx.insert(companyMemberships).values({ companyId, userId: u!.id, companyRole: role, primaryTeamId: primary });
      fx.people[m.key] = { id: u!.id, companyId, role };
      for (const [teamKey, teamRole] of m.teams) {
        await tx.insert(teamMemberships).values({ companyId, teamId: fx.teams[teamKey]!, userId: u!.id, role: teamRole });
      }
      fx.turns.set(await addTurn(tx, companyId, primary, u!.id, n++), u!.id);
    }
    if (unverifiedTurnTeam) {
      fx.turns.set(await addTurn(tx, companyId, fx.teams[unverifiedTurnTeam]!, null, n++), null);
    }
    return fx;
  });
}
