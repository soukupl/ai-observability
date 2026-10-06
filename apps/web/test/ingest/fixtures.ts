import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { Tx } from '@ai-obs/db';
import type { IngestBatchInput, IngestEventInput } from '@ai-obs/protocol';
import { generateToken } from '../../src/lib/ingest/tokens';

/** The shared protocol fixture (6 events: session_start, turn, run, turn_outcome, turn_summary, session_end). */
export function protocolFixture(): IngestBatchInput {
  return JSON.parse(
    readFileSync(new URL('../../../../packages/protocol/fixtures/valid-batch.json', import.meta.url), 'utf8'),
  ) as IngestBatchInput;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let seq = 0;
/** Unique, valid ULID per call (the test database is fresh every run). */
export function ulid(): string {
  let n = ++seq;
  let tail = '';
  for (let i = 0; i < 6; i++) {
    tail = CROCKFORD[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  return `01JA${'0'.repeat(16)}${tail}`;
}

export function batch(events: IngestEventInput[], over: Partial<IngestBatchInput> = {}): IngestBatchInput {
  return {
    schema: 1,
    collector: { name: 'ai-obs', version: '1.0.0' },
    machine: { id: '0b0a6a8e-7d4b-4c1a-9b5e-3f2d1c0b9a87', os: 'linux' },
    identity: {},
    events,
    ...over,
  };
}

const usage = (model: string, input: number, output = 10) => ({
  model, effort: 'high', input, output, cache_read: 100, cache_write: 20, reasoning: 2, requests: 1,
});

export const ev = {
  sessionStart: (sessionId: string, projectKey?: string, name?: string): IngestEventInput => ({
    event_id: ulid(), type: 'session_start', harness: 'claude-code', session_id: sessionId,
    ...(projectKey ? { project: { key: projectKey, ...(name ? { name } : {}) } } : {}),
    at: '2026-10-05T09:00:00Z',
  }),
  turn: (sessionId: string, turnId: string, input = 1000, outcome: 'success' | 'failed' = 'success'): IngestEventInput => ({
    event_id: ulid(), type: 'turn', harness: 'claude-code', session_id: sessionId, turn_id: turnId,
    started_at: '2026-10-05T09:01:00Z', ended_at: '2026-10-05T09:03:00Z', model: 'claude-opus-5-5', effort: 'high',
    usage: [usage('claude-opus-5-5', input)], phases_ms: { thinking: 1000, coding: 2000 },
    outcome: { status: outcome, signals: [], provisional: true }, phase_rules_version: 1,
  }),
  run: (turnId: string, runId: string, parent: string | null, depth: number, input = 50): IngestEventInput => ({
    event_id: ulid(), type: 'run', harness: 'claude-code', turn_id: turnId, run_id: runId, parent_run_id: parent,
    agent_type: 'Explore', depth, started_at: '2026-10-05T09:01:10Z', ended_at: '2026-10-05T09:01:40Z',
    usage: [usage('claude-haiku-4-5', input)], phases_ms: { exploring: 30000 },
    outcome: { status: 'success', signals: [] },
  }),
  outcome: (turnId: string, status: 'failed' | 'success' = 'failed'): IngestEventInput => ({
    event_id: ulid(), type: 'turn_outcome', harness: 'claude-code', turn_id: turnId,
    outcome: { status, signals: ['next_prompt_correction'] },
  }),
  summary: (turnId: string, summary: string): IngestEventInput => ({
    event_id: ulid(), type: 'turn_summary', harness: 'claude-code', turn_id: turnId, summary,
  }),
};

export interface World {
  companyId: string;
  hashedCompanyId: string;
  teams: { platform: string; mobile: string; ci: string };
  users: { alice: string; bob: string; dave: string };
  tokens: { alice: string; bob: string; ci: string; revoked: string; hashedCo: string };
  projects: { billing: string };
}

/** Company "acme" (plain naming) with teams, users, a mapped project and tokens; company "hush" (hashed). */
export async function createWorld(tx: Tx): Promise<World> {
  const one = async <T>(q: ReturnType<typeof sql>) => ([...(await tx.execute(q))][0] as T);
  const company = (slug: string, naming: 'plain' | 'hashed') =>
    one<{ id: string }>(sql`insert into companies (name, slug, settings)
      values (${slug}, ${slug}, ${JSON.stringify({ individualVisibility: 'aggregates-only', projectNaming: naming, retentionDays: 395 })}::jsonb)
      returning id`);
  const team = async (companyId: string, name: string) =>
    (await one<{ id: string }>(sql`insert into teams (company_id, name) values (${companyId}, ${name}) returning id`)).id;
  const user = async (companyId: string, email: string, primary: string) =>
    (await one<{ id: string }>(sql`insert into users (company_id, email, name, primary_team_id)
      values (${companyId}, ${email}, ${email}, ${primary}) returning id`)).id;
  const token = async (companyId: string, teamId: string, userId: string | null, revoked = false) => {
    const t = generateToken(userId ? 'user' : 'team');
    await tx.execute(sql`insert into ingest_tokens (company_id, team_id, user_id, kind, name, prefix, hash, revoked_at)
      values (${companyId}, ${teamId}, ${userId}, ${t.kind}, 'test', ${t.prefix}, ${t.hash},
        ${revoked ? sql`now()` : sql`null`})`);
    return t.plaintext;
  };

  const acme = (await company('acme', 'plain')).id;
  const hush = (await company('hush', 'hashed')).id;
  const teams = { platform: await team(acme, 'Platform'), mobile: await team(acme, 'Mobile'), ci: await team(acme, 'CI') };
  const users = {
    alice: await user(acme, 'alice@acme.test', teams.platform),
    bob: await user(acme, 'bob@acme.test', teams.mobile),
    // Not in the CI team: a CI team token must not match this user's git e-mail (SEC-10).
    dave: await user(acme, 'dave@acme.test', teams.mobile),
  };
  // Memberships: a user token only resolves while its user belongs to the token's team (SEC-4), and a
  // team token matches git e-mails of its own team's members only (SEC-10). CI has Alice and Bob.
  for (const [team, u] of [[teams.platform, users.alice], [teams.mobile, users.bob], [teams.mobile, users.dave], [teams.ci, users.alice], [teams.ci, users.bob]] as const) {
    await tx.execute(sql`insert into team_memberships (company_id, team_id, user_id, role) values (${acme}, ${team}, ${u}, 'member')`);
  }
  const billing = (await one<{ id: string }>(sql`insert into projects (company_id, key, display_name, team_id)
    values (${acme}, 'github.com/acme/billing', 'Billing (admin name)', ${teams.mobile}) returning id`)).id;
  const hushTeam = await team(hush, 'Core');
  return {
    companyId: acme,
    hashedCompanyId: hush,
    teams,
    users,
    tokens: {
      alice: await token(acme, teams.platform, users.alice),
      bob: await token(acme, teams.mobile, users.bob),
      ci: await token(acme, teams.ci, null),
      revoked: await token(acme, teams.platform, users.alice, true),
      hashedCo: await token(hush, hushTeam, null),
    },
    projects: { billing },
  };
}
