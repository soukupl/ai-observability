import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../src/client.js';
import { DB_ROLES } from '../src/connections.js';
import { runMigrations } from '../src/migrate.js';
import { withRlsContext } from '../src/rls.js';
import { pgErrorCode } from './db-harness.js';
import { createCompany, type CompanyFixture, type Person } from './fixtures.js';

/**
 * Migration 0015 (ADR-0024): flow_flags are private bookmarks (own rows only, in either visibility mode; another
 * member, lead or admin of the company sees nothing; a row cannot be written for someone else or another company;
 * deleting the turn removes the flag), and agg_ingest_stats() counts only the caller's company. Own database.
 */
const base = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test');
base.pathname = '/ai_obs_flowflags_test';
const URL_ = base.toString();
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';

async function prepare(): Promise<string | null> {
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    await admin.unsafe('drop database if exists "ai_obs_flowflags_test" with (force)');
    await admin.unsafe('create database "ai_obs_flowflags_test"');
    return null;
  } catch (err) {
    return `Postgres not reachable (${(err as { code?: string }).code || (err as Error).message})`;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

const skipReason = await prepare();
if (skipReason) console.warn(`[db] flow_flags tests skipped: ${skipReason}`);

describe.skipIf(skipReason !== null)('flow_flags + agg_ingest_stats (migration 0015)', () => {
  let owner: Database, web: Database;
  const closers: Array<() => Promise<void>> = [];
  let A: CompanyFixture; // aggregates-only
  let B: CompanyFixture; // full detail

  beforeAll(async () => {
    await runMigrations(URL_);
    const o = createDb({ url: URL_, max: 1 });
    const w = createDb({ url: URL_, role: DB_ROLES.web, max: 2 });
    owner = o.db;
    web = w.db;
    closers.push(o.close, w.close);
    A = await createCompany(owner, 'acme-ff', 'aggregates-only', ['a1'], [
      { key: 'admin', role: 'admin', teams: [['a1', 'member']] },
      { key: 'lead', teams: [['a1', 'lead']] },
      { key: 'm1', teams: [['a1', 'member']] },
    ]);
    B = await createCompany(owner, 'globex-ff', 'full', ['b1'], [
      { key: 'admin', role: 'admin', teams: [['b1', 'member']] },
      { key: 'lead', teams: [['b1', 'lead']] },
      { key: 'm1', teams: [['b1', 'member']] },
    ]);
    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.execute(sql`insert into ingest_events (company_id, event_id, type, received_at) values
        (${A.id}::uuid, 'e1', 'turn', now() - interval '1 hour'),
        (${A.id}::uuid, 'e2', 'turn', now() - interval '3 days'),
        (${A.id}::uuid, 'e3', 'run', now() - interval '20 days'),
        (${B.id}::uuid, 'e4', 'turn', now())`);
    });
  });
  afterAll(async () => {
    await Promise.all(closers.map((c) => c()));
    const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe('drop database if exists "ai_obs_flowflags_test" with (force)').catch(() => {});
    await admin.end({ timeout: 1 }).catch(() => {});
  });

  const as = <T>(p: Person, fn: Parameters<typeof withRlsContext<T>>[2]) => withRlsContext(web, { companyId: p.companyId, userId: p.id, role: p.role }, fn);
  const rows = (p: Person, q: ReturnType<typeof sql>) => as(p, async (tx) => [...(await tx.execute(q))] as Record<string, unknown>[]);
  const count = async (p: Person) => Number((await rows(p, sql`select count(*)::int as n from flow_flags`))[0]!.n);
  const m1Turn = (fx: CompanyFixture) => [...fx.turns].find(([, u]) => u === fx.people.m1!.id)![0];
  const flag = (p: Person, turnId: string, key: string, name = 'plan → impl', note: string | null = null) =>
    as(p, (tx) =>
      tx.execute(sql`insert into flow_flags (company_id, user_id, turn_id, flow_key, flow_name, note)
        values (${p.companyId}::uuid, ${p.id}::uuid, ${turnId}::uuid, ${key}, ${name}, ${note})`),
    );

  it('a user sees only their own flags; admins, leads and other members of the company see none', async () => {
    for (const fx of [A, B]) {
      const m1 = fx.people.m1!;
      await flag(m1, m1Turn(fx), 'wf_abc', 'plan → impl → verify', 'check the verify step');
      expect(await count(m1)).toBe(1);
      expect(await count(fx.people.admin!)).toBe(0);
      expect(await count(fx.people.lead!)).toBe(0);
      const r = await rows(m1, sql`select flow_key, flow_name, note from flow_flags`);
      expect(r).toEqual([{ flow_key: 'wf_abc', flow_name: 'plan → impl → verify', note: 'check the verify step' }]);
    }
  });

  it('is unique per user and flow; two users may flag the same flow independently', async () => {
    const fx = B;
    const turn = m1Turn(fx);
    expect(await pgErrorCode(flag(fx.people.m1!, turn, 'wf_abc'))).toBe('23505');
    // the admin may flag m1's turn (visible in full mode) and sees only that row
    await flag(fx.people.admin!, turn, 'wf_abc');
    expect(await count(fx.people.admin!)).toBe(1);
    expect(await count(fx.people.m1!)).toBe(1);
  });

  it('cannot write a flag for another user or another company, nor delete someone else’s', async () => {
    const m1 = A.people.m1!;
    const other = A.people.lead!;
    const forUser = as(m1, (tx) =>
      tx.execute(sql`insert into flow_flags (company_id, user_id, turn_id, flow_key, flow_name)
        values (${m1.companyId}::uuid, ${other.id}::uuid, ${m1Turn(A)}::uuid, 'wf_x', 'x')`),
    );
    expect(await pgErrorCode(forUser)).toBe('42501');
    const forCompany = as(m1, (tx) =>
      tx.execute(sql`insert into flow_flags (company_id, user_id, turn_id, flow_key, flow_name)
        values (${B.id}::uuid, ${m1.id}::uuid, ${m1Turn(B)}::uuid, 'wf_x', 'x')`),
    );
    expect(await pgErrorCode(forCompany)).toBe('42501');
    const deleted = await rows(other, sql`delete from flow_flags returning id`);
    expect(deleted).toHaveLength(0);
    expect(await count(m1)).toBe(1);
    expect(await pgErrorCode(as(m1, (tx) => tx.execute(sql`update flow_flags set flow_name = 'y'`)))).toBe('42501');
    await as(m1, (tx) => tx.execute(sql`update flow_flags set note = 'later'`));
    expect((await rows(m1, sql`select note from flow_flags`))[0]!.note).toBe('later');
  });

  it('rejects a malformed key, an empty name and a long note', async () => {
    const m1 = A.people.m1!;
    expect(await pgErrorCode(flag(m1, m1Turn(A), 'bad key/with slash'))).toBe('23514');
    expect(await pgErrorCode(flag(m1, m1Turn(A), 'wf_ok', ''))).toBe('23514');
    expect(await pgErrorCode(flag(m1, m1Turn(A), 'wf_ok', 'n', 'x'.repeat(501)))).toBe('23514');
  });

  it('deleting the turn removes the flag (retention cascade), and the owner can delete their own', async () => {
    const m1 = B.people.m1!;
    const turn = m1Turn(B);
    await as(m1, (tx) => tx.execute(sql`delete from flow_flags where flow_key = 'wf_abc'`));
    expect(await count(m1)).toBe(0);
    expect(await count(B.people.admin!)).toBe(1);
    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.execute(sql`delete from turns where id = ${turn}::uuid`);
    });
    expect(await count(B.people.admin!)).toBe(0);
  });

  it('agg_ingest_stats() counts only the caller’s company, per type, with the last arrival', async () => {
    const r = await rows(A.people.m1!, sql`select type, events_24h::int as d1, events_7d::int as d7, last_received_at from agg_ingest_stats()`);
    expect(r.map(({ type, d1, d7 }) => ({ type, d1, d7 }))).toEqual([
      { type: 'run', d1: 0, d7: 0 },
      { type: 'turn', d1: 1, d7: 2 },
    ]);
    const turn = r.find((x) => x.type === 'turn')!;
    expect(Date.now() - new Date(turn.last_received_at as string).getTime()).toBeGreaterThan(50 * 60_000);
    const b = await rows(B.people.lead!, sql`select type, events_24h::int as d1 from agg_ingest_stats()`);
    expect(b).toEqual([{ type: 'turn', d1: 1 }]);
    // the ledger itself stays closed to the dashboard role
    expect(await pgErrorCode(rows(A.people.admin!, sql`select received_at from ingest_events`))).toBe('42501');
  });
});
