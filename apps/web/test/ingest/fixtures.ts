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
  teams: { platform: string; mobile: string };
  /** alice, bob, dave are members of acme; hank is a member of hush only. */
  users: { alice: string; bob: string; dave: string; hank: string };
  /** `ci` and `hashedCo` are company tokens; the others are user tokens of acme. */
  tokens: { alice: string; bob: string; ci: string; revoked: string; hashedCo: string };
  projects: { billing: string };
}

const first = async <T>(tx: Tx, q: ReturnType<typeof sql>) => [...(await tx.execute(q))][0] as T;

/** An identity (users holds e-mail and name only, ADR-0022). */
export async function insertUser(tx: Tx, email: string, name: string = email): Promise<string> {
  return (await first<{ id: string }>(tx, sql`insert into users (email, name) values (${email}, ${name}) returning id`)).id;
}

/** Company membership with role and primary team, plus a team membership in that primary team. */
export async function insertMember(
  tx: Tx,
  companyId: string,
  userId: string,
  opts: { role?: 'admin' | 'member'; primaryTeamId?: string | null; teamRole?: 'lead' | 'member' } = {},
): Promise<void> {
  const primary = opts.primaryTeamId ?? null;
  await tx.execute(sql`insert into company_memberships (company_id, user_id, company_role, primary_team_id)
    values (${companyId}, ${userId}, ${opts.role ?? 'member'}, ${primary})`);
  if (primary) {
    await tx.execute(sql`insert into team_memberships (company_id, team_id, user_id, role)
      values (${companyId}, ${primary}, ${userId}, ${opts.teamRole ?? 'member'})`);
  }
}

/**
 * A user token (userId set) or a company token (userId null); returns the plaintext. A company token resolves only
 * while its creator is an admin or lead of the company (D2), so it needs `createdBy`; a user token defaults to its owner.
 */
export async function insertToken(
  tx: Tx,
  companyId: string,
  userId: string | null,
  revoked = false,
  createdBy: string | null = userId,
): Promise<string> {
  const t = generateToken(userId ? 'user' : 'company');
  await tx.execute(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, revoked_at, created_by_user_id)
    values (${companyId}, ${userId}, ${t.kind}, 'test', ${t.prefix}, ${t.hash}, ${revoked ? sql`now()` : sql`null`}, ${createdBy})`);
  return t.plaintext;
}

/** Company "acme" (plain naming) with teams, members, a mapped project and tokens; company "hush" (hashed). */
export async function createWorld(tx: Tx): Promise<World> {
  const company = async (slug: string, naming: 'plain' | 'hashed') =>
    (await first<{ id: string }>(tx, sql`insert into companies (name, slug, settings)
      values (${slug}, ${slug}, ${JSON.stringify({ individualVisibility: 'aggregates-only', projectNaming: naming, retentionDays: 395 })}::jsonb)
      returning id`)).id;
  const team = async (companyId: string, name: string) =>
    (await first<{ id: string }>(tx, sql`insert into teams (company_id, name) values (${companyId}, ${name}) returning id`)).id;

  const acme = await company('acme', 'plain');
  const hush = await company('hush', 'hashed');
  const teams = { platform: await team(acme, 'Platform'), mobile: await team(acme, 'Mobile') };
  const hushTeam = await team(hush, 'Core');
  const users = {
    alice: await insertUser(tx, 'alice@acme.test'),
    bob: await insertUser(tx, 'bob@acme.test'),
    dave: await insertUser(tx, 'dave@acme.test'),
    // A member of another company: a company token of acme must not match this git e-mail.
    hank: await insertUser(tx, 'hank@hush.test'),
  };
  // alice is acme's admin and hank hush's: the company tokens below are theirs (D2 needs an admin or lead creator).
  await insertMember(tx, acme, users.alice, { role: 'admin', primaryTeamId: teams.platform });
  await insertMember(tx, acme, users.bob, { primaryTeamId: teams.mobile });
  await insertMember(tx, acme, users.dave, { primaryTeamId: teams.mobile });
  await insertMember(tx, hush, users.hank, { role: 'admin', primaryTeamId: hushTeam });
  const billing = (await first<{ id: string }>(tx, sql`insert into projects (company_id, key, display_name, team_id)
    values (${acme}, 'github.com/acme/billing', 'Billing (admin name)', ${teams.mobile}) returning id`)).id;
  return {
    companyId: acme,
    hashedCompanyId: hush,
    teams,
    users,
    tokens: {
      alice: await insertToken(tx, acme, users.alice),
      bob: await insertToken(tx, acme, users.bob),
      ci: await insertToken(tx, acme, null, false, users.alice),
      revoked: await insertToken(tx, acme, users.alice, true),
      hashedCo: await insertToken(tx, hush, null, false, users.hank),
    },
    projects: { billing },
  };
}
