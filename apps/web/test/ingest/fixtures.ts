import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { Tx } from '@ai-obs/db';
import type { IngestBatchInput, IngestEventInput } from '@ai-obs/protocol';
import { generateToken } from '../../src/lib/ingest/tokens';

/**
 * The shared protocol fixture (8 events: session_start, turn, run, turn_outcome, turn_summary, session_end,
 * session_title, turn_started).
 */
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
  sessionStart: (sessionId: string, projectKey?: string, name?: string, team?: string): IngestEventInput => ({
    event_id: ulid(), type: 'session_start', harness: 'claude-code', session_id: sessionId,
    ...(projectKey ? { project: { key: projectKey, ...(name ? { name } : {}), ...(team ? { team } : {}) } } : {}),
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
  title: (sessionId: string, title: string, source: 'custom' | 'ai' = 'ai'): IngestEventInput => ({
    event_id: ulid(), type: 'session_title', harness: 'claude-code', session_id: sessionId, title, source,
  }),
  /** Live status (ADR-0027): a main-agent prompt was submitted. */
  turnStarted: (sessionId: string, startedAt = '2026-10-05T09:00:30Z', turnId: string | null = null): IngestEventInput => ({
    event_id: ulid(), type: 'turn_started', harness: 'claude-code', session_id: sessionId, turn_id: turnId,
    started_at: startedAt,
  }),
};

export interface World {
  deploymentId: string;
  /** platform, mobile and design; slugs equal the names in lower case. */
  teams: { platform: string; mobile: string; design: string };
  /**
   * alice: admin, primary Platform (lead), also a member of Design. bob, dave: members, primary Mobile. nora: a member
   * without a primary team or any team. svc: a service user (no e-mail), primary Mobile.
   */
  users: { alice: string; bob: string; dave: string; nora: string; svc: string };
  /** User tokens; `revoked` and `expired` are alice's, `device` is alice's device-login token (label mac-alice). */
  tokens: { alice: string; bob: string; dave: string; nora: string; svc: string; revoked: string; expired: string; device: string };
  projects: { billing: string };
}

const first = async <T>(tx: Tx, q: ReturnType<typeof sql>) => [...(await tx.execute(q))][0] as T;

/** A person (e-mail and name) or, with `kind: 'service'`, a service user without e-mail. */
export async function insertUser(tx: Tx, email: string | null, name: string | null = email, kind: 'person' | 'service' = 'person'): Promise<string> {
  return (await first<{ id: string }>(tx, sql`insert into users (email, name, kind) values (${email}, ${name}, ${kind}) returning id`)).id;
}

/** Membership with role and primary team, plus a team membership in that primary team. */
export async function insertMember(
  tx: Tx,
  userId: string,
  opts: { role?: 'admin' | 'member'; primaryTeamId?: string | null; teamRole?: 'lead' | 'member' } = {},
): Promise<void> {
  const primary = opts.primaryTeamId ?? null;
  await tx.execute(sql`insert into memberships (user_id, role, primary_team_id) values (${userId}, ${opts.role ?? 'member'}, ${primary})`);
  if (primary) await joinTeam(tx, userId, primary, opts.teamRole ?? 'member');
}

export async function joinTeam(tx: Tx, userId: string, teamId: string, role: 'lead' | 'member' = 'member'): Promise<void> {
  await tx.execute(sql`insert into team_memberships (team_id, user_id, role) values (${teamId}, ${userId}, ${role})`);
}

export async function insertTeam(tx: Tx, name: string, slug: string = name.toLowerCase()): Promise<string> {
  return (await first<{ id: string }>(tx, sql`insert into teams (name, slug) values (${name}, ${slug}) returning id`)).id;
}

/** A user token; returns the plaintext. */
export async function insertToken(
  tx: Tx,
  userId: string,
  opts: { revoked?: boolean; expiresAt?: string | null; source?: 'device' | 'manual'; label?: string | null } = {},
): Promise<string> {
  const t = generateToken('user');
  await tx.execute(sql`insert into ingest_tokens (user_id, name, source, label, prefix, hash, revoked_at, expires_at, created_by_user_id)
    values (${userId}, 'test', ${opts.source ?? 'manual'}, ${opts.label ?? null}, ${t.prefix}, ${t.hash},
      ${opts.revoked ? sql`now()` : sql`null`}, ${opts.expiresAt ?? null}, ${userId})`);
  return t.plaintext;
}

/** Sets the deployment's settings (merged into the current ones). */
export async function setSettings(tx: Tx, settings: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`update deployment set settings = settings || ${JSON.stringify(settings)}::jsonb`);
}

/** The deployment SPECTADO (plain naming) with three teams, five users, a mapped project and tokens. */
export async function createWorld(tx: Tx): Promise<World> {
  const dep = await first<{ id: string }>(
    tx,
    sql`update deployment set name = 'SPECTADO', slug = 'spectado',
      settings = ${JSON.stringify({ individualVisibility: 'aggregates-only', projectNaming: 'plain', retentionDays: 395 })}::jsonb
      returning id`,
  );
  const teams = {
    platform: await insertTeam(tx, 'Platform'),
    mobile: await insertTeam(tx, 'Mobile'),
    design: await insertTeam(tx, 'Design'),
  };
  const users = {
    alice: await insertUser(tx, 'alice@acme.test', 'Alice'),
    bob: await insertUser(tx, 'bob@acme.test'),
    dave: await insertUser(tx, 'dave@acme.test'),
    nora: await insertUser(tx, 'nora@acme.test', 'Nora'),
    svc: await insertUser(tx, null, 'CI runner', 'service'),
  };
  await insertMember(tx, users.alice, { role: 'admin', primaryTeamId: teams.platform, teamRole: 'lead' });
  await joinTeam(tx, users.alice, teams.design);
  await insertMember(tx, users.bob, { primaryTeamId: teams.mobile });
  await insertMember(tx, users.dave, { primaryTeamId: teams.mobile });
  await insertMember(tx, users.nora);
  await insertMember(tx, users.svc, { primaryTeamId: teams.mobile });
  const billing = (await first<{ id: string }>(tx, sql`insert into projects (key, display_name, team_id)
    values ('github.com/acme/billing', 'Billing (admin name)', ${teams.mobile}) returning id`)).id;
  return {
    deploymentId: dep.id,
    teams,
    users,
    tokens: {
      alice: await insertToken(tx, users.alice),
      bob: await insertToken(tx, users.bob),
      dave: await insertToken(tx, users.dave),
      nora: await insertToken(tx, users.nora),
      svc: await insertToken(tx, users.svc, { expiresAt: '2099-01-01T00:00:00Z', label: 'ci' }),
      revoked: await insertToken(tx, users.alice, { revoked: true }),
      expired: await insertToken(tx, users.alice, { expiresAt: '2020-01-01T00:00:00Z' }),
      device: await insertToken(tx, users.alice, { source: 'device', label: 'mac-alice', expiresAt: '2027-01-22T10:00:00Z' }),
    },
    projects: { billing },
  };
}
