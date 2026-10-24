import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { DB_ROLES } from '../src/connections.js';
import { runMigrations } from '../src/migrate.js';
import { withRlsContext } from '../src/rls.js';
import { pgErrorCode } from './db-harness.js';
import { asDefiner, createDeployment, setVisibility, type DeploymentFixture, type Person } from './fixtures.js';
import { adminDbUrl, testDbName, testDbUrl } from './test-db.js';

/**
 * Migration 0015 (ADR-0024), as rewritten by 0018 (ADR-0028): flow_flags are private bookmarks (own rows only, in
 * either visibility mode; another member, lead or admin sees nothing; a row cannot be written for someone else;
 * deleting the turn removes the flag), and agg_ingest_stats() counts the ledger per type. Own database.
 */
const DB = testDbName('flowflags');
const URL_ = testDbUrl('flowflags');
const adminUrl = new URL(adminDbUrl());

async function prepare(): Promise<string | null> {
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    await admin.unsafe(`drop database if exists "${DB}" with (force)`);
    await admin.unsafe(`create database "${DB}"`);
    return null;
  } catch (err) {
    return `Postgres not reachable (${(err as { code?: string }).code || (err as Error).message})`;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

const skipReason = await prepare();
if (skipReason) console.warn(`[db] flow_flags tests skipped: ${skipReason}`);

describe.skipIf(skipReason !== null)('flow_flags + agg_ingest_stats (migrations 0015, 0018)', () => {
  let owner: Database, web: Database;
  const closers: Array<() => Promise<void>> = [];
  let D: DeploymentFixture;

  beforeAll(async () => {
    const quiet = console.log;
    console.log = () => {};
    try {
      await runMigrations(URL_);
    } finally {
      console.log = quiet;
    }
    const o = createDb({ url: URL_, max: 1 });
    const w = createDb({ url: URL_, role: DB_ROLES.web, max: 2 });
    owner = o.db;
    web = w.db;
    closers.push(o.close, w.close);
    D = await createDeployment(owner, 'ff', 'aggregates-only', ['t1'], [
      { key: 'admin', role: 'admin', teams: [['t1', 'member']] },
      { key: 'lead', teams: [['t1', 'lead']] },
      { key: 'm1', teams: [['t1', 'member']] },
    ]);
    await asDefiner(owner, (tx) =>
      tx.execute(sql`insert into ingest_events (event_id, type, received_at) values
        ('e1', 'turn', now() - interval '1 hour'),
        ('e2', 'turn', now() - interval '3 days'),
        ('e3', 'run', now() - interval '20 days')`),
    );
  });
  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`drop database if exists "${DB}" with (force)`).catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
  });

  const as = <T>(p: Person, fn: Parameters<typeof withRlsContext<T>>[2]) => withRlsContext(web, { userId: p.id, role: p.role }, fn);
  const rows = (p: Person, q: ReturnType<typeof sql>) => as(p, async (tx) => [...(await tx.execute(q))] as Record<string, unknown>[]);
  const count = async (p: Person) => Number((await rows(p, sql`select count(*)::int as n from flow_flags`))[0]!.n);
  const m1Turn = () => [...D.turns].find(([, u]) => u === D.people.m1!.id)![0];
  const flag = (p: Person, turnId: string, key: string, name = 'plan → impl', note: string | null = null) =>
    as(p, (tx) =>
      tx.execute(sql`insert into flow_flags (user_id, turn_id, flow_key, flow_name, note)
        values (${p.id}::uuid, ${turnId}::uuid, ${key}, ${name}, ${note})`),
    );

  it('a user sees only their own flags; admins, leads and other members see none, in either mode', async () => {
    const m1 = D.people.m1!;
    await flag(m1, m1Turn(), 'wf_abc', 'plan → impl → verify', 'check the verify step');
    for (const mode of ['aggregates-only', 'full'] as const) {
      await setVisibility(owner, mode);
      expect(await count(m1), mode).toBe(1);
      expect(await count(D.people.admin!), mode).toBe(0);
      expect(await count(D.people.lead!), mode).toBe(0);
    }
    await setVisibility(owner, 'aggregates-only');
    const r = await rows(m1, sql`select flow_key, flow_name, note from flow_flags`);
    expect(r).toEqual([{ flow_key: 'wf_abc', flow_name: 'plan → impl → verify', note: 'check the verify step' }]);
  });

  it('is unique per user and flow; two users may flag the same flow independently', async () => {
    const turn = m1Turn();
    expect(await pgErrorCode(flag(D.people.m1!, turn, 'wf_abc'))).toBe('23505');
    await flag(D.people.admin!, turn, 'wf_abc');
    expect(await count(D.people.admin!)).toBe(1);
    expect(await count(D.people.m1!)).toBe(1);
  });

  it('cannot write a flag for another user, nor delete someone else’s', async () => {
    const m1 = D.people.m1!;
    const other = D.people.lead!;
    const forUser = as(m1, (tx) =>
      tx.execute(sql`insert into flow_flags (user_id, turn_id, flow_key, flow_name)
        values (${other.id}::uuid, ${m1Turn()}::uuid, 'wf_x', 'x')`),
    );
    expect(await pgErrorCode(forUser)).toBe('42501');
    const deleted = await rows(other, sql`delete from flow_flags returning id`);
    expect(deleted).toHaveLength(0);
    expect(await count(m1)).toBe(1);
    expect(await pgErrorCode(as(m1, (tx) => tx.execute(sql`update flow_flags set flow_name = 'y'`)))).toBe('42501');
    await as(m1, (tx) => tx.execute(sql`update flow_flags set note = 'later'`));
    expect((await rows(m1, sql`select note from flow_flags`))[0]!.note).toBe('later');
  });

  it('rejects a malformed key, an empty name and a long note', async () => {
    const m1 = D.people.m1!;
    expect(await pgErrorCode(flag(m1, m1Turn(), 'bad key/with slash'))).toBe('23514');
    expect(await pgErrorCode(flag(m1, m1Turn(), 'wf_ok', ''))).toBe('23514');
    expect(await pgErrorCode(flag(m1, m1Turn(), 'wf_ok', 'n', 'x'.repeat(501)))).toBe('23514');
  });

  it('deleting the turn removes the flag (retention cascade), and the owner can delete their own', async () => {
    const m1 = D.people.m1!;
    const turn = m1Turn();
    await as(m1, (tx) => tx.execute(sql`delete from flow_flags where flow_key = 'wf_abc'`));
    expect(await count(m1)).toBe(0);
    expect(await count(D.people.admin!)).toBe(1);
    await asDefiner(owner, (tx) => tx.execute(sql`delete from turns where id = ${turn}::uuid`));
    expect(await count(D.people.admin!)).toBe(0);
  });

  it('agg_ingest_stats() counts per type with the last arrival, for members only', async () => {
    const r = await rows(D.people.m1!, sql`select type, events_24h::int as d1, events_7d::int as d7, last_received_at from agg_ingest_stats()`);
    expect(r.map(({ type, d1, d7 }) => ({ type, d1, d7 }))).toEqual([
      { type: 'run', d1: 0, d7: 0 },
      { type: 'turn', d1: 1, d7: 2 },
    ]);
    const turn = r.find((x) => x.type === 'turn')!;
    expect(Date.now() - new Date(turn.last_received_at as string).getTime()).toBeGreaterThan(50 * 60_000);
    // no context, no stats; the ledger itself stays closed to the dashboard role
    expect([...(await web.execute(sql`select * from agg_ingest_stats()`))]).toEqual([]);
    expect(await pgErrorCode(rows(D.people.admin!, sql`select received_at from ingest_events`))).toBe('42501');
  });
});
