import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/client.js';
import { withIngestContext, withRlsContext } from '../src/rls.js';
import { closeAll, connectAs, connectOwner, pgErrorCode, prepareTestDatabase } from './db-harness.js';
import { addMembership, createCompany, type CompanyFixture, type Person } from './fixtures.js';

/**
 * Proves BRIEF §12.4 against a real Postgres: tenant isolation, member / lead / admin scopes,
 * aggregates-only vs full visibility, the service-role boundaries (ingest, worker, platform), and ADR-0022:
 * one identity in several companies (context = membership), token kinds, member removal, DB invariants.
 */
const skipReason = await prepareTestDatabase();
if (skipReason) console.warn(`[db] RLS tests skipped: ${skipReason}`);

const TELEMETRY = ['turns', 'runs', 'usage', 'agent_sessions', 'daily_rollups'] as const;
// ISO strings: drizzle's raw sql`` passes Date objects to postgres.js unserialized.
const FROM = new Date(Date.now() - 90 * 86_400_000).toISOString();
const TO = new Date(Date.now() + 86_400_000).toISOString();

describe.skipIf(skipReason !== null)(skipReason ? `RLS — SKIPPED: ${skipReason}` : 'RLS (real Postgres)', () => {
  let web: Database, ingest: Database, worker: Database, platform: Database;
  let A: CompanyFixture; // aggregates-only (default mode)
  let B: CompanyFixture; // full detail

  beforeAll(async () => {
    const owner = connectOwner();
    A = await createCompany(owner, 'acme-test', 'aggregates-only', ['a1', 'a2'], [
      { key: 'admin', role: 'admin', teams: [['a1', 'member']] },
      { key: 'lead', teams: [['a1', 'lead']] },
      { key: 'm1', teams: [['a1', 'member']] },
      { key: 'm2', teams: [['a2', 'member'], ['a1', 'member']] },
    ], 'a1');
    B = await createCompany(owner, 'globex-test', 'full', ['b1', 'b2'], [
      { key: 'admin', role: 'admin', teams: [['b1', 'member']] },
      { key: 'lead', teams: [['b1', 'lead']] },
      { key: 'm1', teams: [['b1', 'member']] },
      { key: 'm2', teams: [['b2', 'member']] },
    ], 'b1');
    web = connectAs('web');
    ingest = connectAs('ingest');
    worker = connectAs('worker');
    platform = connectAs('platform');
  });
  afterAll(closeAll);

  const as = <T>(p: Person, fn: Parameters<typeof withRlsContext<T>>[2], role = p.role) =>
    withRlsContext(web, { companyId: p.companyId, userId: p.id, role }, fn);
  const rows = (p: Person, query: ReturnType<typeof sql>, role = p.role) =>
    as(p, async (tx) => [...(await tx.execute(query))] as Record<string, unknown>[], role);
  const count = async (p: Person, table: string) =>
    Number((await rows(p, sql`select count(*)::int as n from ${sql.identifier(table)}`))[0]!.n);
  const turnUsers = async (p: Person) =>
    (await rows(p, sql`select user_id, company_id from turns`)).map((r) => r.user_id as string | null);
  const ownedBy = (fx: CompanyFixture, pred: (userId: string | null) => boolean) =>
    [...fx.turns.values()].filter(pred).length;

  describe('company isolation', () => {
    it('never returns another company’s rows from any table', async () => {
      for (const p of Object.values(B.people)) {
        const r = await rows(p, sql`select company_id from turns union all select company_id from teams
          union all select company_id from company_memberships union all select id from companies`);
        expect(r.length).toBeGreaterThan(0);
        expect(r.every((x) => x.company_id === B.id)).toBe(true);
      }
    });

    it('a forged app.company_id (user of B claiming company A) sees nothing but their own identity', async () => {
      const forged = { ...B.people.admin!, companyId: A.id };
      for (const t of [...TELEMETRY, 'teams', 'company_memberships', 'team_memberships', 'companies', 'projects', 'budgets', 'ingest_tokens']) {
        expect(await count(forged, t), t).toBe(0);
      }
      expect(await rows(forged, sql`select id from users`)).toEqual([{ id: forged.id }]);
      const agg = await rows(forged, sql`select * from agg_turns_daily(${FROM}, ${TO})`);
      expect(agg).toHaveLength(0);
    });

    it('aggregate functions only cover the caller’s company', async () => {
      const r = await rows(B.people.admin!, sql`select sum(turns)::int as n from agg_turns_daily(${FROM}, ${TO})`);
      expect(r[0]!.n).toBe(B.turns.size);
      const other = [...A.turns.keys()][0]!;
      expect(await rows(B.people.admin!, sql`select * from agg_turn_runs(${other}::uuid)`)).toHaveLength(0);
    });
  });

  describe('member', () => {
    it('sees only own rows in every telemetry table, in both modes', async () => {
      for (const fx of [A, B]) {
        const m = fx.people.m1!;
        expect(await turnUsers(m)).toEqual([m.id]);
        for (const t of TELEMETRY) {
          const r = await rows(m, sql`select user_id from ${sql.identifier(t)}`);
          expect(r.length, t).toBeGreaterThan(0);
          expect(r.every((x) => x.user_id === m.id), t).toBe(true);
        }
      }
    });

    it('cannot escalate by claiming app.role = admin', async () => {
      const m = A.people.m1!;
      expect(await rows(m, sql`select user_id from turns`, 'admin')).toHaveLength(1);
      const agg = await rows(m, sql`select sum(turns)::int as n from agg_turns_daily(${FROM}, ${TO})`, 'admin');
      expect(agg[0]!.n).toBe(1);
      const upd = await as(m, (tx) => tx.execute(sql`update companies set name = 'pwned'`), 'admin');
      expect(upd.count).toBe(0);
    });
  });

  describe('full-detail mode (company B)', () => {
    it('admin sees every turn of the company, incl. unverified ones', async () => {
      expect(await count(B.people.admin!, 'turns')).toBe(B.turns.size);
    });

    it('lead sees only the teams they lead', async () => {
      const lead = B.people.lead!;
      const visible = new Set(await turnUsers(lead));
      expect(visible.has(B.people.m2!.id)).toBe(false); // m2 is in b2 only
      expect(visible.has(B.people.m1!.id)).toBe(true);
      expect(visible.has(null)).toBe(true); // unverified turn of b1
      const b1Turns = ownedBy(B, (u) => u !== B.people.m2!.id);
      for (const t of TELEMETRY) {
        const n = await count(lead, t);
        expect(n, t).toBe(t === 'usage' ? b1Turns * 2 : b1Turns);
      }
    });
  });

  describe('aggregates-only mode (company A)', () => {
    it('admin and lead read only their own rows from telemetry tables', async () => {
      for (const p of [A.people.admin!, A.people.lead!]) {
        for (const t of TELEMETRY) {
          const r = await rows(p, sql`select user_id from ${sql.identifier(t)}`);
          expect(r.every((x) => x.user_id === p.id), `${t}`).toBe(true);
        }
        expect(await count(p, 'machines')).toBe(0);
      }
    });

    it('admin gets company-wide aggregates through agg_* functions', async () => {
      const admin = A.people.admin!;
      const daily = await rows(admin, sql`select sum(turns)::int as n, sum(input_tokens)::int as i from agg_turns_daily(${FROM}, ${TO})`);
      expect(daily[0]).toEqual({ n: A.turns.size, i: A.turns.size * 100 });
      const usage = await rows(admin, sql`select sum(input_tokens)::int as i from agg_usage_daily(${FROM}, ${TO})`);
      expect(usage[0]!.i).toBe(A.turns.size * 100);
      const agents = await rows(admin, sql`select runs::int from agg_agents(${FROM}, ${TO})`);
      expect(agents).toEqual([{ runs: A.turns.size }]);
      const phases = await rows(admin, sql`select sum(ms)::int as ms from agg_phases('team', ${FROM}, ${TO}) where phase = 'thinking'`);
      expect(phases[0]!.ms).toBe(A.turns.size * 40_000);
      const rollups = await rows(admin, sql`select sum(turns)::int as n from agg_rollups(${FROM.slice(0, 10)}::date, ${TO.slice(0, 10)}::date)`);
      expect(rollups[0]!.n).toBe(A.turns.size);
    });

    it('lead aggregates cover only led teams', async () => {
      const r = await rows(A.people.lead!, sql`select sum(turns)::int as n from agg_turns_daily(${FROM}, ${TO})`);
      // m2's primary team is a2 → excluded even though m2 is also a member of a1.
      expect(r[0]!.n).toBe(ownedBy(A, (u) => u !== A.people.m2!.id));
    });

    it('aggregate outputs never carry user ids', async () => {
      const lead = A.people.lead!;
      const list = await rows(lead, sql`select * from agg_turn_list(${FROM}, ${TO})`);
      expect(list.length).toBe(ownedBy(A, (u) => u !== A.people.m2!.id));
      expect(list.filter((x) => x.is_mine)).toHaveLength(1);
      const userIds = new Set(Object.values(A.people).map((p) => p.id));
      for (const fn of ['agg_turn_list', 'agg_turns_daily', 'agg_usage_daily', 'agg_turns_by_project', 'agg_turns_by_model', 'agg_agents',
        'agg_timeline_turns', 'agg_timeline_runs', 'agg_timeline_links', 'agg_flow_runs', 'agg_flow_links']) {
        const out = await rows(lead, sql`select * from ${sql.identifier(fn)}(${FROM}, ${TO})`);
        for (const row of out) {
          expect(Object.keys(row)).not.toContain('user_id');
          expect(Object.values(row).some((v) => userIds.has(v as string)), fn).toBe(false);
        }
      }
      const runs = await rows(lead, sql`select * from agg_turn_runs(${list[0]!.id as string}::uuid)`);
      expect(runs).toHaveLength(1);
      expect(Object.keys(runs[0]!)).not.toContain('user_id');
    });

    it('timeline functions: same scope as the turn list, overlap window, limit, member sees only own (ADR-0019)', async () => {
      const lead = A.people.lead!;
      const visible = ownedBy(A, (u) => u !== A.people.m2!.id);
      const turns = await rows(lead, sql`select * from agg_timeline_turns(${FROM}, ${TO})`);
      expect(turns).toHaveLength(visible);
      expect(turns.filter((x) => x.is_mine)).toHaveLength(1);
      const runs = await rows(lead, sql`select * from agg_timeline_runs(${FROM}, ${TO})`);
      expect(runs).toHaveLength(visible);
      expect(runs[0]).toMatchObject({ agent_type: 'Explore', agent_group: null, orchestration_id: null, depth: 1 });
      expect(await rows(lead, sql`select * from agg_timeline_turns(${FROM}, ${TO}, p_limit => 1)`)).toHaveLength(1);
      // A window that starts inside a turn (started before p_from, ended after) still returns it; one that starts at
      // its end does not. The look-back is one day, the fixture turns are a day apart.
      const t = turns[0]!;
      const inside = new Date(new Date(t.started_at as string).getTime() + 30_000).toISOString();
      const after = new Date(new Date(inside).getTime() + 60_000).toISOString();
      const hit = await rows(lead, sql`select id from agg_timeline_turns(${inside}::timestamptz, ${after}::timestamptz)`);
      expect(hit.map((x) => x.id)).toEqual([t.id]);
      const endIso = new Date(t.ended_at as string).toISOString();
      const later = new Date(new Date(endIso).getTime() + 60_000).toISOString();
      expect(await rows(lead, sql`select id from agg_timeline_turns(${endIso}::timestamptz, ${later}::timestamptz)`)).toEqual([]);
      const m1 = A.people.m1!;
      const own = await rows(m1, sql`select is_mine from agg_timeline_turns(${FROM}, ${TO})`);
      expect(own).toEqual([{ is_mine: true }]);
    });

    it('timeline turns: session ids are per-window pseudonyms; parents of runs that outlive their turn are kept', async () => {
      const lead = A.people.lead!;
      const owner = connectOwner();
      const turns = await rows(lead, sql`select id, session_id, started_at, ended_at from agg_timeline_turns(${FROM}, ${TO})`);
      const t = turns[0]!;
      const stored = await owner.execute(sql`select session_id from turns where id = ${t.id as string}::uuid`);
      const storedSession = String((stored as unknown as { session_id: string }[])[0]!.session_id);
      expect(t.session_id).toBeTruthy();
      expect(t.session_id).not.toBe(storedSession);
      // Stable inside one window, different in another.
      const again = await rows(lead, sql`select session_id from agg_timeline_turns(${FROM}, ${TO}) where id = ${t.id as string}::uuid`);
      expect(again[0]!.session_id).toBe(t.session_id);
      const shifted = new Date(new Date(FROM).getTime() - 60_000).toISOString();
      const other = await rows(lead, sql`select session_id from agg_timeline_turns(${shifted}, ${TO}) where id = ${t.id as string}::uuid`);
      expect(other[0]!.session_id).not.toBe(t.session_id);

      // A background run that keeps going two hours after its turn ended: a window inside that tail returns the run and
      // its parent turn (the turn itself does not overlap the window).
      const endMs = new Date(t.ended_at as string).getTime();
      const tailFrom = new Date(endMs + 3_600_000).toISOString();
      const tailTo = new Date(endMs + 3_660_000).toISOString();
      const before = await owner.execute(sql`select id, ended_at from runs where turn_id = ${t.id as string}::uuid`);
      const run = (before as unknown as { id: string; ended_at: Date | string }[])[0]!;
      await owner.execute(sql`update runs set ended_at = ${new Date(endMs + 7_200_000).toISOString()}::timestamptz where id = ${run.id}::uuid`);
      try {
        const tailTurns = await rows(lead, sql`select id from agg_timeline_turns(${tailFrom}::timestamptz, ${tailTo}::timestamptz)`);
        const tailRuns = await rows(lead, sql`select id, turn_id from agg_timeline_runs(${tailFrom}::timestamptz, ${tailTo}::timestamptz)`);
        expect(tailRuns).toEqual([{ id: run.id, turn_id: t.id }]);
        expect(tailTurns).toEqual([{ id: t.id }]);
      } finally {
        await owner.execute(sql`update runs set ended_at = ${new Date(run.ended_at).toISOString()}::timestamptz where id = ${run.id}::uuid`);
      }
    });

    it('the internal scope function is not callable by app_web', async () => {
      const code = await pgErrorCode(rows(A.people.admin!, sql`select * from agg_scope_turns(${FROM}, ${TO}, null, null, null, null)`));
      expect(code).toBe('42501');
    });

    it('switching the company to full mode reveals per-user rows (admins only may switch)', async () => {
      const setMode = (p: Person, mode: string) =>
        as(p, (tx) => tx.execute(sql`update companies set settings = jsonb_set(settings, '{individualVisibility}', to_jsonb(${mode}::text))`));
      expect((await setMode(A.people.lead!, 'full')).count).toBe(0);
      expect((await setMode(A.people.admin!, 'full')).count).toBe(1);
      try {
        expect(await count(A.people.admin!, 'turns')).toBe(A.turns.size);
      } finally {
        await setMode(A.people.admin!, 'aggregates-only');
      }
      expect(await count(A.people.admin!, 'turns')).toBe(1);
    });
  });

  describe('app_platform (super admin)', () => {
    it('has no access to telemetry tables', async () => {
      for (const t of [...TELEMETRY, 'run_links', 'projects', 'machines', 'teams', 'team_memberships', 'ingest_events', 'ingest_tokens', 'budgets', 'pending_turn_patches']) {
        expect(await pgErrorCode(platform.execute(sql`select 1 from ${sql.identifier(t)} limit 1`)), t).toBe('42501');
      }
    });

    it('pending_turn_patches is ingest-internal: the dashboard role cannot read it either', async () => {
      expect(await pgErrorCode(web.execute(sql`select 1 from pending_turn_patches limit 1`))).toBe('42501');
    });

    it('manages companies and sees only admin contacts (through admin memberships)', async () => {
      const cs = [...(await platform.execute(sql`select id from companies`))];
      expect(cs.map((c) => c.id)).toEqual(expect.arrayContaining([A.id, B.id]));
      const us = [...(await platform.execute(sql`select id from users`))].map((u) => u.id);
      expect(new Set(us)).toEqual(new Set([A.people.admin!.id, B.people.admin!.id]));
      const ms = [...(await platform.execute(sql`select user_id, company_role from company_memberships`))];
      expect(new Set(ms.map((m) => m.user_id))).toEqual(new Set([A.people.admin!.id, B.people.admin!.id]));
      expect(ms.every((m) => m.company_role === 'admin')).toBe(true);
    });
  });

  describe('app_ingest', () => {
    it('cannot read telemetry back', async () => {
      await withIngestContext(ingest, A.id, async () => {});
      for (const q of [sql`select * from turns`, sql`select summary from turns`, sql`select input_tokens from usage`, sql`select * from runs`, sql`select * from users`, sql`select * from ingest_tokens`, sql`select * from run_links`]) {
        expect(await pgErrorCode(withIngestContext(ingest, A.id, (tx) => tx.execute(q)))).toBe('42501');
      }
    });

    it('resolves a token via lookup_ingest_token and writes only into that company', async () => {
      const m1 = A.people.m1!;
      await as(m1, (tx) => tx.execute(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${A.id}, ${m1.id}, 'user', 'laptop', 'aiobs_u_ab', 'hash-a', ${m1.id})`));
      const [tok] = [...(await ingest.execute(sql`select * from lookup_ingest_token('hash-a')`))];
      // Company labels and the user's e-mail feed collector-config; the primary team comes from the membership.
      expect(tok).toMatchObject({ company_id: A.id, company_name: 'acme-test', company_slug: 'acme-test', user_id: m1.id,
        user_email: 'm1@acme-test.test', user_primary_team_id: A.teams.a1, kind: 'user' });
      expect(Object.keys(tok!)).not.toContain('team_id');

      const insertTurn = (companyId: string, ext: string) => sql`insert into turns
        (company_id, team_id, user_id, attribution, external_id, harness, started_at, ended_at)
        values (${companyId}, ${A.teams.a1}, ${m1.id}, 'verified', ${ext}, 'codex', now(), now()) returning id`;
      await withIngestContext(ingest, A.id, async (tx) => {
        expect([...(await tx.execute(insertTurn(A.id, 'ingest-1')))]).toHaveLength(1);
        const patched = await tx.execute(sql`update turns set summary = 'Patched', outcome = 'failed' where external_id = 'ingest-1'`);
        expect(patched.count).toBe(1);
        const dup = await tx.execute(sql`insert into ingest_events (company_id, event_id, type) values (${A.id}, 'e1', 'turn'), (${A.id}, 'e1', 'turn') on conflict do nothing returning event_id`);
        expect([...dup]).toHaveLength(1);
        // Idempotent upserts with RETURNING id work with the column-level grants, as long as SET uses
        // bound values: referencing excluded.<col> needs SELECT on <col>, which app_ingest lacks.
        const upsertMachine = sql`insert into machines (company_id, user_id, machine_id, os) values (${A.id}, ${m1.id}, 'mac-1', 'darwin')
          on conflict (company_id, machine_id) do update set last_seen_at = now(), os = ${'darwin'} returning id`;
        const [first] = [...(await tx.execute(upsertMachine))];
        const [again] = [...(await tx.execute(upsertMachine))];
        expect(again!.id).toBe(first!.id);
        const upsertProject = sql`insert into projects (company_id, key) values (${A.id}, 'github.com/acme/api')
          on conflict (company_id, key) do update set last_seen_at = now() returning id, team_id`;
        expect([...(await tx.execute(upsertProject))]).toHaveLength(1);
      });
      // Local paths are never stored as project keys (CHECK constraint).
      const pathKey = sql`insert into projects (company_id, key) values (${A.id}, '/Users/dev/secret')`;
      expect(await pgErrorCode(withIngestContext(ingest, A.id, (tx) => tx.execute(pathKey)))).toBe('23514');
      // A row for another company is rejected by the WITH CHECK policy.
      expect(await pgErrorCode(withIngestContext(ingest, A.id, (tx) => tx.execute(insertTurn(B.id, 'ingest-x'))))).toBe('42501');
      // Patches cannot reach another company's turns.
      const other = await withIngestContext(ingest, B.id, (tx) => tx.execute(sql`update turns set summary = 'x' where external_id = 'ingest-1'`));
      expect(other.count).toBe(0);
    });

    it('revoked tokens resolve to nothing', async () => {
      await as(A.people.m1!, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = now() where hash = 'hash-a'`));
      expect([...(await ingest.execute(sql`select * from lookup_ingest_token('hash-a')`))]).toHaveLength(0);
    });
  });

  describe('app_web writes: tokens (ADR-0022, Q9)', () => {
    const ins = (p: Person, kind: string, userId: string | null, hash: string) =>
      as(p, (tx) => tx.execute(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${p.companyId}, ${userId}, ${kind}::token_kind, 'x', 'aiobs_x', ${hash}, ${p.id})`));
    const tokenNames = async (p: Person) =>
      (await rows(p, sql`select hash from ingest_tokens where hash like 'w-%' order by hash`)).map((r) => r.hash);

    it('members cannot create company tokens or tokens for others', async () => {
      const m1 = A.people.m1!;
      expect(await pgErrorCode(ins(m1, 'company', null, 'w-m1-co'))).toBe('42501');
      expect(await pgErrorCode(ins(m1, 'user', A.people.m2!.id, 'w-m1-for-m2'))).toBe('42501');
    });

    it('admins and leads create company tokens; everyone creates only their own user token', async () => {
      expect(await pgErrorCode(ins(A.people.admin!, 'company', null, 'w-admin-co'))).toBeUndefined();
      expect(await pgErrorCode(ins(A.people.lead!, 'company', null, 'w-lead-co'))).toBeUndefined();
      expect(await pgErrorCode(ins(A.people.m2!, 'user', A.people.m2!.id, 'w-m2-own'))).toBeUndefined();
      expect(await pgErrorCode(ins(A.people.admin!, 'user', A.people.m2!.id, 'w-admin-for-m2'))).toBe('42501');
      // The CHECK: a company token never carries a user (app_definer bypasses RLS, not the CHECK).
      const owner = connectOwner();
      const bad = owner.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        await tx.execute(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash)
          values (${A.id}, ${A.people.m1!.id}, 'company', 'x', 'aiobs_c_x', 'w-bad')`);
      });
      expect(await pgErrorCode(bad)).toBe('23514');
    });

    it('visibility (D6): admins see every token, leads company tokens + own, members own only', async () => {
      expect(await tokenNames(A.people.admin!)).toEqual(['w-admin-co', 'w-lead-co', 'w-m2-own']);
      expect(await tokenNames(A.people.lead!)).toEqual(['w-admin-co', 'w-lead-co']);
      expect(await tokenNames(A.people.m2!)).toEqual(['w-m2-own']);
      expect(await tokenNames(A.people.m1!)).toEqual([]);
      // Company token lookup: no user, no team.
      const [co] = [...(await ingest.execute(sql`select * from lookup_ingest_token('w-lead-co')`))];
      expect(co).toMatchObject({ kind: 'company', company_id: A.id, user_id: null, user_email: null, user_primary_team_id: null });
    });

    it('a company token resolves only while its creator is an admin or lead of the company (D2 at use time)', async () => {
      // Rows as a concurrent insert would leave them: the one-shot revoke of a removal / demotion could not see
      // them, so they are unrevoked although their creator is a plain member or not a member at all.
      const owner = connectOwner();
      const insDef = (hash: string, createdBy: string) => owner.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        await tx.execute(sql`insert into ingest_tokens (company_id, kind, name, prefix, hash, created_by_user_id)
          values (${A.id}, 'company', 'race', 'aiobs_c_r', ${hash}, ${createdBy})`);
      });
      await insDef('race-member', A.people.m1!.id);
      await insDef('race-outsider', B.people.admin!.id);
      await insDef('race-admin', A.people.admin!.id);
      const look = async (h: string) => [...(await ingest.execute(sql`select * from lookup_ingest_token(${h})`))].length;
      expect(await look('race-member')).toBe(0);
      expect(await look('race-outsider')).toBe(0);
      expect(await look('race-admin')).toBe(1);
      expect(await look('w-lead-co')).toBe(1);
    });
  });

  describe('app_worker', () => {
    it('reads telemetry across companies but cannot touch tokens or auth secrets', async () => {
      const [r] = [...(await worker.execute(sql`select count(distinct company_id)::int as n from turns`))];
      expect(r!.n).toBeGreaterThanOrEqual(2);
      expect(await pgErrorCode(worker.execute(sql`select * from ingest_tokens`))).toBe('42501');
      expect(await pgErrorCode(worker.execute(sql`update turns set summary = 'x'`))).toBe('42501');
    });
  });

  describe('run_links (ADR-0020)', () => {
    // m1's turn in each company gets a second run r2 (stage 1, flow 'data') fed by r1 (an 'item' link), plus a link
    // whose source has not arrived (from_run_id null). The worker removes r2 at the end (cascade test), so the
    // run counts of the other blocks are unaffected.
    const extra = new Map<string, { turnId: string; r1: string; r2: string }>();
    const m1Turn = (fx: CompanyFixture) => [...fx.turns].find(([, u]) => u === fx.people.m1!.id)![0];

    beforeAll(async () => {
      const owner = connectOwner();
      for (const fx of [A, B]) {
        const turnId = m1Turn(fx);
        await owner.transaction(async (tx) => {
          await tx.execute(sql`set local role app_definer`);
          const [r1] = [...(await tx.execute(sql`select id from runs where turn_id = ${turnId}::uuid`))] as { id: string }[];
          const [r2] = [...(await tx.execute(sql`insert into runs (company_id, team_id, user_id, turn_id, turn_external_id,
              external_id, agent_type, depth, started_at, ended_at, stage_index, flow_key, orchestration_id, skills, mcp)
            select company_id, team_id, user_id, turn_id, turn_external_id, 'r2', 'workflow', 1,
              started_at + interval '1 second', started_at + interval '2 seconds', 1, 'data', 'wf_r2',
              '{"review": {"model": 1, "user": 0}}'::jsonb, '{"github": {"get_issue": 2}}'::jsonb
            from runs where id = ${r1!.id}::uuid returning id`))] as { id: string }[];
          await tx.execute(sql`insert into run_links (company_id, turn_id, turn_external_id, from_run_id, to_run_id,
              from_external_id, to_external_id, kind)
            select company_id, turn_id, turn_external_id, ${r1!.id}::uuid, ${r2!.id}::uuid, 'r1', 'r2', 'item'
            from runs where id = ${r1!.id}::uuid
            union all
            select company_id, turn_id, turn_external_id, null, ${r2!.id}::uuid, 'r0-missing', 'r2', 'sequence'
            from runs where id = ${r1!.id}::uuid`);
          extra.set(fx.id, { turnId, r1: r1!.id, r2: r2!.id });
        });
      }
    });

    const linkCount = async (p: Person) => count(p, 'run_links');

    it('a link is visible when its target run is: owner, a lead of the team in full mode; not another member', async () => {
      // Full mode (B): m1 owns them, b1's lead sees b1's rows, the admin sees the company, m2 (b2 only) sees nothing.
      expect(await linkCount(B.people.m1!)).toBe(2);
      expect(await linkCount(B.people.lead!)).toBe(2);
      expect(await linkCount(B.people.admin!)).toBe(2);
      expect(await linkCount(B.people.m2!)).toBe(0);
      // Aggregates-only (A): only the owner reads rows; the lead and admin go through agg_turn_links.
      expect(await linkCount(A.people.m1!)).toBe(2);
      for (const k of ['lead', 'admin', 'm2']) expect(await linkCount(A.people[k]!), k).toBe(0);
      // A forged company context sees nothing.
      expect(await linkCount({ ...B.people.admin!, companyId: A.id })).toBe(0);
    });

    it('agg_turn_links / agg_timeline_links give an aggregates-only admin the resolved links, never user ids', async () => {
      const admin = A.people.admin!;
      const { turnId, r1, r2 } = extra.get(A.id)!;
      const edge = { from_run_id: r1, to_run_id: r2, kind: 'item' };
      expect(await rows(admin, sql`select * from agg_turn_links(${turnId}::uuid)`)).toEqual([edge]);
      expect(await rows(admin, sql`select * from agg_timeline_links(${FROM}, ${TO})`)).toEqual([edge]);
      expect(await rows(A.people.lead!, sql`select * from agg_timeline_links(${FROM}, ${TO})`)).toEqual([edge]);
      expect(await rows(admin, sql`select * from agg_timeline_links(${FROM}, ${TO}, p_limit => 0)`)).toEqual([]);
      // Out of scope: a member for someone else's turn, another company's admin, a window after the target run.
      expect(await rows(A.people.m2!, sql`select * from agg_turn_links(${turnId}::uuid)`)).toEqual([]);
      expect(await rows(A.people.m2!, sql`select * from agg_timeline_links(${FROM}, ${TO})`)).toEqual([]);
      expect(await rows(B.people.admin!, sql`select * from agg_turn_links(${turnId}::uuid)`)).toEqual([]);
      const late = new Date(Date.now() + 3_600_000).toISOString();
      expect(await rows(admin, sql`select * from agg_timeline_links(${late}::timestamptz, ${TO})`)).toEqual([]);
      // stage_index / flow_key (and, for agg_turn_runs, orchestration_id) are appended to the run functions.
      const turnRuns = await rows(admin, sql`select id, agent_group, stage_index, flow_key, orchestration_id from agg_turn_runs(${turnId}::uuid)`);
      expect(turnRuns).toEqual(expect.arrayContaining([{ id: r2, agent_group: null, stage_index: 1, flow_key: 'data', orchestration_id: 'wf_r2' }]));
      const winRuns = await rows(admin, sql`select id, stage_index, flow_key from agg_timeline_runs(${FROM}, ${TO}) where id = ${r2}::uuid`);
      expect(winRuns).toEqual([{ id: r2, stage_index: 1, flow_key: 'data' }]);
      const userIds = new Set(Object.values(A.people).map((p) => p.id));
      for (const out of [
        await rows(admin, sql`select * from agg_turn_links(${turnId}::uuid)`),
        await rows(admin, sql`select * from agg_timeline_links(${FROM}, ${TO})`),
      ]) {
        for (const row of out) {
          expect(Object.keys(row)).toEqual(['from_run_id', 'to_run_id', 'kind']);
          expect(Object.values(row).some((v) => userIds.has(v as string))).toBe(false);
        }
      }
    });

    it('agg_turn_runs appends skills / mcp after orchestration_id (agent flows view)', async () => {
      const admin = A.people.admin!;
      const { turnId, r2 } = extra.get(A.id)!;
      const out = await rows(admin, sql`select * from agg_turn_runs(${turnId}::uuid)`);
      expect(out).toHaveLength(2);
      expect(Object.keys(out[0]!).slice(-5)).toEqual(['stage_index', 'flow_key', 'orchestration_id', 'skills', 'mcp']);
      expect(out.find((r) => r.id === r2)).toMatchObject({
        skills: { review: { model: 1, user: 0 } }, mcp: { github: { get_issue: 2 } } });
      expect(out.find((r) => r.id !== r2)).toMatchObject({ skills: {}, mcp: {} });
    });

    it('agg_flow_runs / agg_flow_links: the aggregates-only admin gets the company scope, filters and limit apply, never user ids', async () => {
      const admin = A.people.admin!;
      const lead = A.people.lead!;
      const { turnId, r1, r2 } = extra.get(A.id)!;
      const allRuns = A.turns.size + 1; // one run per turn plus r2
      const runs = await rows(admin, sql`select * from agg_flow_runs(${FROM}, ${TO})`);
      expect(runs).toHaveLength(allRuns);
      expect(Object.keys(runs[0]!)).toEqual(['id', 'turn_id', 'parent_run_id', 'agent_type', 'agent_group',
        'orchestration_id', 'stage_index', 'flow_key', 'depth', 'model', 'effort', 'started_at', 'ended_at', 'duration_ms',
        'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'outcome',
        'turn_started_at', 'turn_project_id', 'turn_harness', 'turn_summary', 'turn_is_mine']);
      const starts = runs.map((r) => new Date(r.started_at as string).getTime());
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
      expect(runs.find((r) => r.id === r2)).toMatchObject({ turn_id: turnId, agent_type: 'workflow', stage_index: 1,
        flow_key: 'data', orchestration_id: 'wf_r2', turn_harness: 'claude-code', turn_summary: 'Did a thing',
        turn_project_id: null, turn_is_mine: false });
      expect(runs.filter((r) => r.turn_is_mine)).toHaveLength(1);
      const userIds = new Set(Object.values(A.people).map((p) => p.id));
      for (const row of runs) expect(Object.values(row).some((v) => userIds.has(v as string))).toBe(false);
      // Lead: led team a1 only (m2's primary team is a2); member m2: own turn only; another company: nothing.
      expect(await rows(lead, sql`select id from agg_flow_runs(${FROM}, ${TO})`)).toHaveLength(allRuns - 1);
      const m2Runs = await rows(A.people.m2!, sql`select turn_is_mine from agg_flow_runs(${FROM}, ${TO})`);
      expect(m2Runs).toEqual([{ turn_is_mine: true }]);
      expect(await rows(B.people.admin!, sql`select id from agg_flow_runs(${FROM}, ${TO}) where id in (${r1}::uuid, ${r2}::uuid)`)).toEqual([]);
      // Team / harness / model filters and the limit (capped at the default + 1).
      expect(await rows(admin, sql`select id from agg_flow_runs(${FROM}, ${TO}, ${A.teams.a2!}::uuid)`)).toHaveLength(1);
      expect(await rows(admin, sql`select id from agg_flow_runs(${FROM}, ${TO}, p_harness => 'codex')`)).toEqual([]);
      expect(await rows(admin, sql`select id from agg_flow_runs(${FROM}, ${TO}, p_model => 'claude-opus-5-5')`)).toHaveLength(allRuns);
      expect(await rows(admin, sql`select id from agg_flow_runs(${FROM}, ${TO}, p_limit => 1)`)).toHaveLength(1);
      expect(await rows(admin, sql`select id from agg_flow_runs(${FROM}, ${TO}, p_limit => 0)`)).toEqual([]);
      expect(await rows(admin, sql`select id from agg_flow_runs(${FROM}, ${TO}, p_limit => -5)`)).toEqual([]);
      // The range selects by the TURN's start: a window that starts after the turn began drops all of its runs.
      const turnStart = new Date(runs.find((r) => r.id === r2)!.turn_started_at as string).getTime();
      const justAfter = new Date(turnStart + 1).toISOString();
      const later = await rows(admin, sql`select id from agg_flow_runs(${justAfter}::timestamptz, ${TO})`);
      expect(later.map((r) => r.id)).not.toContain(r2);

      // Links: the resolved edge only (the link with a missing source is left out), same scope and filters.
      const edge = { from_run_id: r1, to_run_id: r2, kind: 'item' };
      expect(await rows(admin, sql`select * from agg_flow_links(${FROM}, ${TO})`)).toEqual([edge]);
      expect(await rows(lead, sql`select * from agg_flow_links(${FROM}, ${TO})`)).toEqual([edge]);
      expect(await rows(admin, sql`select * from agg_flow_links(${FROM}, ${TO}, ${A.teams.a2!}::uuid)`)).toEqual([]);
      expect(await rows(admin, sql`select * from agg_flow_links(${FROM}, ${TO}, p_limit => 0)`)).toEqual([]);
      expect(await rows(admin, sql`select * from agg_flow_links(${justAfter}::timestamptz, ${TO})`)).toEqual([]);
      expect(await rows(A.people.m2!, sql`select * from agg_flow_links(${FROM}, ${TO})`)).toEqual([]);
      expect(await rows(B.people.admin!, sql`select * from agg_flow_links(${FROM}, ${TO}) where to_run_id = ${r2}::uuid`)).toEqual([]);

      // Project filter: move m1's turn into a project; only its runs / links match.
      const owner = connectOwner();
      const [project] = [...(await owner.execute(sql`insert into projects (company_id, key)
        values (${A.id}::uuid, 'github.com/acme/flows') returning id`))] as { id: string }[];
      await owner.execute(sql`update turns set project_id = ${project!.id}::uuid where id = ${turnId}::uuid`);
      try {
        const inProject = await rows(admin, sql`select id, turn_project_id from agg_flow_runs(${FROM}, ${TO}, null, ${project!.id}::uuid)`);
        expect(inProject.map((r) => r.id).sort()).toEqual([r1, r2].sort());
        expect(inProject.every((r) => r.turn_project_id === project!.id)).toBe(true);
        expect(await rows(admin, sql`select * from agg_flow_links(${FROM}, ${TO}, null, ${project!.id}::uuid)`)).toEqual([edge]);
        const otherProject = '00000000-0000-4000-8000-000000000000';
        expect(await rows(admin, sql`select * from agg_flow_links(${FROM}, ${TO}, null, ${otherProject}::uuid)`)).toEqual([]);
      } finally {
        await owner.execute(sql`update turns set project_id = null where id = ${turnId}::uuid`);
        await owner.execute(sql`delete from projects where id = ${project!.id}::uuid`);
      }
    });

    it('app_ingest writes links only into its own company and cannot read their timestamps', async () => {
      const { r2 } = extra.get(A.id)!;
      const insert = (companyId: string) => sql`insert into run_links (company_id, turn_external_id, to_run_id,
        from_external_id, to_external_id, kind) values (${companyId}, 'ext', ${r2}::uuid, 'x', 'y', 'item')`;
      expect(await pgErrorCode(withIngestContext(ingest, A.id, (tx) => tx.execute(insert(B.id))))).toBe('42501');
      expect(await pgErrorCode(withIngestContext(ingest, A.id, (tx) => tx.execute(sql`select created_at from run_links`)))).toBe('42501');
      const bad = sql`insert into run_links (company_id, turn_external_id, from_external_id, to_external_id, kind)
        values (${A.id}, 'ext', 'x', 'y', 'continues')`;
      expect(await pgErrorCode(withIngestContext(ingest, A.id, (tx) => tx.execute(bad)))).toBe('23514');
    });

    it('retention: the worker deleting a run removes its links through the cascade, without a grant on run_links', async () => {
      expect(await pgErrorCode(worker.execute(sql`select 1 from run_links limit 1`))).toBe('42501');
      const owner = connectOwner();
      for (const fx of [A, B]) {
        const { r2 } = extra.get(fx.id)!;
        const del = await worker.execute(sql`delete from runs where id = ${r2}::uuid`);
        expect(del.count).toBe(1);
        const left = [...(await owner.execute(sql`select count(*)::int as n from run_links where company_id = ${fx.id}::uuid`))];
        expect(left[0]!.n).toBe(0);
      }
    });
  });
  describe('one login, many companies (ADR-0022)', () => {
    // dana: admin of X and member of Y (lead of team y1 there). Y is in full mode, so Y's admin reads rows.
    let X: CompanyFixture, Y: CompanyFixture;
    let danaX: Person, danaY: Person;
    const danaTurns = new Map<string, string>(); // company id -> dana's turn id there
    const ownerQ = async (query: ReturnType<typeof sql>) => {
      const owner = connectOwner();
      return owner.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        return [...(await tx.execute(query))] as Record<string, unknown>[];
      });
    };

    beforeAll(async () => {
      const owner = connectOwner();
      X = await createCompany(owner, 'multi-x', 'full', ['x1'], [
        { key: 'dana', role: 'admin', teams: [['x1', 'member']] },
        { key: 'xm', teams: [['x1', 'member']] },
      ]);
      Y = await createCompany(owner, 'multi-y', 'full', ['y1', 'y2'], [
        { key: 'admin', role: 'admin', teams: [['y1', 'member']] },
        { key: 'ym', teams: [['y2', 'member']] },
      ]);
      danaX = X.people.dana!;
      danaY = await addMembership(owner, danaX.id, Y.id, 'member', Y.teams.y1!);
      await ownerQ(sql`insert into team_memberships (company_id, team_id, user_id, role) values (${Y.id}, ${Y.teams.y1}, ${danaX.id}, 'lead')`);
      danaTurns.set(X.id, [...X.turns].find(([, u]) => u === danaX.id)![0]);
      // dana's telemetry in Y: a session, a turn with a run and usage, a machine, a rollup, a runaway alert; and a budget.
      const [s] = await ownerQ(sql`insert into agent_sessions (company_id, team_id, user_id, external_id, harness, started_at)
        values (${Y.id}, ${Y.teams.y1}, ${danaX.id}, 's-dana-y', 'claude-code', now() - interval '1 hour') returning id`);
      const [t] = await ownerQ(sql`insert into turns (company_id, team_id, user_id, attribution, session_id, external_id, harness,
          started_at, ended_at, input_tokens) values (${Y.id}, ${Y.teams.y1}, ${danaX.id}, 'verified', ${s!.id as string}, 't-dana-y',
          'claude-code', now() - interval '1 hour', now() - interval '50 minutes', 100) returning id`);
      danaTurns.set(Y.id, t!.id as string);
      const [r] = await ownerQ(sql`insert into runs (company_id, team_id, user_id, turn_id, turn_external_id, external_id, agent_type,
          started_at, ended_at) values (${Y.id}, ${Y.teams.y1}, ${danaX.id}, ${t!.id as string}, 't-dana-y', 'r1', 'Explore',
          now() - interval '1 hour', now() - interval '55 minutes') returning id`);
      await ownerQ(sql`insert into usage (company_id, team_id, user_id, turn_id, run_id, started_at, model, input_tokens) values
        (${Y.id}, ${Y.teams.y1}, ${danaX.id}, ${t!.id as string}, null, now() - interval '1 hour', 'claude-opus-5-5', 90),
        (${Y.id}, ${Y.teams.y1}, ${danaX.id}, ${t!.id as string}, ${r!.id as string}, now() - interval '1 hour', 'claude-haiku-4-5', 10)`);
      await ownerQ(sql`insert into machines (company_id, user_id, machine_id) values (${Y.id}, ${danaX.id}, 'dana-mac')`);
      await ownerQ(sql`insert into daily_rollups (company_id, day, team_id, user_id, harness, model, turns)
        values (${Y.id}, current_date, ${Y.teams.y1}, ${danaX.id}, 'claude-code', 'claude-opus-5-5', 1)`);
      await ownerQ(sql`insert into runaway_alerts (company_id, turn_id, team_id, user_id, harness, started_at, reasons)
        values (${Y.id}, ${t!.id as string}, ${Y.teams.y1}, ${danaX.id}, 'claude-code', now() - interval '1 hour', '["tokens"]')`);
      await ownerQ(sql`insert into budgets (company_id, user_id, kind, limit_value) values (${Y.id}, ${danaX.id}, 'tokens', 1000)`);
      // Tokens: a user token in each company and a company token dana minted in Y (as a lead of y1).
      await as(danaX, (tx) => tx.execute(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${X.id}, ${danaX.id}, 'user', 'x', 'aiobs_u_x', 'dana-x-user', ${danaX.id})`));
      await as(danaY, (tx) => tx.execute(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${Y.id}, ${danaX.id}, 'user', 'y', 'aiobs_u_y', 'dana-y-user', ${danaX.id})`));
      await as(danaY, (tx) => tx.execute(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${Y.id}, null, 'company', 'ci', 'aiobs_c_y', 'dana-y-company', ${danaX.id})`));
    });

    const ids = (r: Record<string, unknown>[], k = 'id') => r.map((x) => x[k]).sort();

    it('the X context (admin) sees only X: turns, members and tokens', async () => {
      expect(ids(await rows(danaX, sql`select id from turns`))).toEqual([...X.turns.keys()].sort());
      expect(ids(await rows(danaX, sql`select user_id from company_memberships`), 'user_id'))
        .toEqual(Object.values(X.people).map((p) => p.id).sort());
      expect(ids(await rows(danaX, sql`select hash from ingest_tokens`), 'hash')).toEqual(['dana-x-user']);
      expect(ids(await rows(danaX, sql`select id from users`))).toEqual(Object.values(X.people).map((p) => p.id).sort());
    });

    it('the Y context sees only Y, and app_is_admin() is false there even when the context claims admin', async () => {
      const yTurns = await rows(danaY, sql`select id, company_id from turns`, 'admin');
      expect(yTurns.length).toBeGreaterThan(0);
      expect(yTurns.every((t) => t.company_id === Y.id)).toBe(true);
      // A lead of y1 in full mode: y1's turns (dana's and Y's admin's), never X's.
      expect(yTurns.map((t) => t.id)).toContain(danaTurns.get(Y.id));
      expect(yTurns.map((t) => t.id)).not.toContain(danaTurns.get(X.id));
      const [flag] = await rows(danaY, sql`select app_is_admin() as a, app_company() as c`, 'admin');
      expect(flag).toEqual({ a: false, c: Y.id });
      const upd = await as(danaY, (tx) => tx.execute(sql`update companies set name = 'pwned'`), 'admin');
      expect(upd.count).toBe(0);
      expect(ids(await rows(danaY, sql`select hash from ingest_tokens`), 'hash')).toEqual(['dana-y-company', 'dana-y-user']);
    });

    it('a context for a company the user is not in sees nothing but the own users row', async () => {
      const outsider = { ...danaX, companyId: A.id };
      for (const t of [...TELEMETRY, 'teams', 'company_memberships', 'companies', 'ingest_tokens', 'machines']) {
        expect(await count(outsider, t), t).toBe(0);
      }
      expect(await rows(outsider, sql`select id from users`)).toEqual([{ id: danaX.id }]);
      expect(await rows(outsider, sql`select app_company() as c`)).toEqual([{ c: null }]);
    });

    it('users.last_login_at is not readable by app_web; identity columns are, for self and co-members only', async () => {
      for (const p of [X.people.xm!, danaX]) {
        expect(await pgErrorCode(rows(p, sql`select last_login_at from users`))).toBe('42501');
        expect(await pgErrorCode(rows(p, sql`select * from users`))).toBe('42501');
      }
      const seen = await rows(X.people.xm!, sql`select id, email, name from users`);
      expect(ids(seen)).toEqual(Object.values(X.people).map((p) => p.id).sort());
    });

    it('admin_remove_member in Y: membership-bound rows go, telemetry stays, tokens are revoked (D1, D2, D8)', async () => {
      const web2 = connectAs('web');
      // A dashboard session of dana working in Y (stamps last_active_at) and one in X.
      await web2.execute(sql`insert into auth_sessions (user_id, token_hash, expires_at, active_company_id)
        values (${danaX.id}, 'sess-dana-y', now() + interval '1 day', ${Y.id}), (${danaX.id}, 'sess-dana-x', now() + interval '1 day', ${X.id})`);

      // Only an admin of the context's company may call it, never on themselves.
      expect(await pgErrorCode(as(Y.people.ym!, (tx) => tx.execute(sql`select * from admin_remove_member(${danaX.id}::uuid)`)))).toBe('42501');
      expect(await pgErrorCode(as(Y.people.admin!, (tx) => tx.execute(sql`select * from admin_remove_member(${Y.people.admin!.id}::uuid)`)))).toBe('42501');

      const revoked = await rows(Y.people.admin!, sql`select * from admin_remove_member(${danaX.id}::uuid)`);
      expect(revoked.map((t) => t.token_kind).sort()).toEqual(['company', 'user']);
      expect(revoked.map((t) => t.token_name).sort()).toEqual(['ci', 'y']);

      const n = async (q: ReturnType<typeof sql>) => Number((await ownerQ(q))[0]!.n);
      // Gone: the Y membership, Y team memberships, the per-user Y budget.
      expect(await n(sql`select count(*)::int n from company_memberships where user_id = ${danaX.id} and company_id = ${Y.id}`)).toBe(0);
      expect(await n(sql`select count(*)::int n from team_memberships where user_id = ${danaX.id} and company_id = ${Y.id}`)).toBe(0);
      expect(await n(sql`select count(*)::int n from budgets where user_id = ${danaX.id}`)).toBe(0);
      // Kept with their user_id (D1).
      for (const t of ['turns', 'runs', 'usage', 'agent_sessions', 'machines', 'daily_rollups', 'runaway_alerts']) {
        expect(await n(sql`select count(*)::int n from ${sql.identifier(t)} where user_id = ${danaX.id} and company_id = ${Y.id}`), t)
          .toBeGreaterThan(0);
      }
      // Tokens: rows kept, revoked; lookups fail. X's token is untouched.
      const toks = await ownerQ(sql`select hash, revoked_at is not null as revoked from ingest_tokens where hash like 'dana-%' order by hash`);
      expect(toks).toEqual([
        { hash: 'dana-x-user', revoked: false },
        { hash: 'dana-y-company', revoked: true },
        { hash: 'dana-y-user', revoked: true },
      ]);
      expect([...(await ingest.execute(sql`select * from lookup_ingest_token('dana-y-company')`))]).toHaveLength(0);
      expect([...(await ingest.execute(sql`select * from lookup_ingest_token('dana-x-user')`))]).toHaveLength(1);
      // Sessions: the Y one lost its company, the X one did not. The X membership is untouched.
      const sess = [...(await web2.execute(sql`select token_hash, active_company_id from auth_sessions
        where user_id = ${danaX.id} order by token_hash`))];
      expect(sess).toEqual([
        { token_hash: 'sess-dana-x', active_company_id: X.id },
        { token_hash: 'sess-dana-y', active_company_id: null },
      ]);
      expect(await n(sql`select count(*)::int n from company_memberships where user_id = ${danaX.id} and company_id = ${X.id}`)).toBe(1);

      // Y's admin still sees the kept turn, but no longer dana's identity (rendered as a former member).
      expect((await rows(Y.people.admin!, sql`select id from turns`)).map((t) => t.id)).toContain(danaTurns.get(Y.id));
      expect(await rows(Y.people.admin!, sql`select name from users where id = ${danaX.id}`)).toEqual([]);
      // dana's own Y context is dead without the membership.
      expect(await rows(danaY, sql`select app_company() as c`)).toEqual([{ c: null }]);
    });
  });

  describe('invariants (ADR-0022, D6/D11)', () => {
    const asDefiner = async (query: ReturnType<typeof sql>) => {
      const owner = connectOwner();
      return owner.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        return [...(await tx.execute(query))] as Record<string, unknown>[];
      });
    };

    it('a revoked token stays revoked: owner, lead and app_definer all get 42501', async () => {
      const m1 = B.people.m1!;
      const lead = B.people.lead!;
      await as(m1, (tx) => tx.execute(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${B.id}, ${m1.id}, 'user', 'r', 'aiobs_u_r', 'inv-user', ${m1.id})`));
      await as(lead, (tx) => tx.execute(sql`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${B.id}, null, 'company', 'r', 'aiobs_c_r', 'inv-co', ${lead.id})`));
      expect((await as(m1, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = now() where hash = 'inv-user'`))).count).toBe(1);
      expect((await as(lead, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = now() where hash = 'inv-co'`))).count).toBe(1);
      expect(await pgErrorCode(as(m1, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = null where hash = 'inv-user'`)))).toBe('42501');
      expect(await pgErrorCode(as(lead, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = null where hash = 'inv-co'`)))).toBe('42501');
      expect(await pgErrorCode(asDefiner(sql`update ingest_tokens set revoked_at = null where hash = 'inv-co'`))).toBe('42501');
      expect(await pgErrorCode(asDefiner(sql`update ingest_tokens set revoked_at = now() - interval '1 day' where hash = 'inv-user'`))).toBe('42501');
      // Renaming a revoked token is still fine (the trigger only guards revoked_at).
      expect((await as(m1, (tx) => tx.execute(sql`update ingest_tokens set name = 'old' where hash = 'inv-user'`))).count).toBe(1);
    });

    it('a super admin holds no membership, and a member cannot become a super admin (23514)', async () => {
      const [sa] = await asDefiner(sql`insert into users (email, name, is_super_admin) values ('root@inv.test', 'Root', true) returning id`);
      expect(await pgErrorCode(asDefiner(sql`insert into company_memberships (company_id, user_id) values (${B.id}, ${sa!.id as string})`)))
        .toBe('23514');
      expect(await pgErrorCode(asDefiner(sql`update users set is_super_admin = true where id = ${B.people.m2!.id}`))).toBe('23514');
      // auth_ensure_super_admin refuses members with its own message.
      await expect(asDefiner(sql`select auth_ensure_super_admin('m2@globex-test.test')`)).rejects.toThrow();
    });

    it('a concurrent membership insert and auth_ensure_super_admin cannot both commit', async () => {
      const [u] = await asDefiner(sql`insert into users (email, name) values ('race@inv.test', 'Race') returning id`);
      const userId = u!.id as string;
      const t1 = connectOwner();
      const t2 = connectOwner();
      const probe = connectOwner();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let inserted!: () => void;
      const didInsert = new Promise<void>((r) => (inserted = r));
      const first = t1.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        await tx.execute(sql`insert into company_memberships (company_id, user_id) values (${B.id}, ${userId})`);
        inserted();
        await gate;
      });
      await didInsert;
      const second = t2.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        await tx.execute(sql`select auth_ensure_super_admin('race@inv.test')`);
      });
      // Wait until the second transaction blocks on the users row lock, then commit the first.
      for (let i = 0; i < 100; i++) {
        const [w] = [...(await probe.execute(sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`))] as { n: number }[];
        if (w!.n > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      release();
      const results = await Promise.allSettled([first, second]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      const [state] = await asDefiner(sql`select u.is_super_admin as sa, (select count(*)::int from company_memberships m
        where m.user_id = u.id) as n from users u where u.id = ${userId}`);
      expect(state).toEqual({ sa: false, n: 1 });
    });

    it('the primary team stays in the company (23503); deleting a team nulls only primary_team_id', async () => {
      const admin = A.people.admin!;
      const m1 = A.people.m1!;
      const cross = as(admin, (tx) => tx.execute(sql`update company_memberships set primary_team_id = ${B.teams.b1}
        where user_id = ${m1.id} and company_id = ${A.id}`));
      expect(await pgErrorCode(cross)).toBe('23503');
      // Same company works for an admin.
      const ok = await as(admin, (tx) => tx.execute(sql`update company_memberships set primary_team_id = ${A.teams.a2}
        where user_id = ${m1.id} and company_id = ${A.id}`));
      expect(ok.count).toBe(1);
      // A member cannot change memberships at all (RLS: 0 rows).
      const denied = await as(m1, (tx) => tx.execute(sql`update company_memberships set company_role = 'admin' where user_id = ${m1.id}`));
      expect(denied.count).toBe(0);
      const [team] = await asDefiner(sql`insert into teams (company_id, name) values (${A.id}, 'temp') returning id`);
      await asDefiner(sql`update company_memberships set primary_team_id = ${team!.id as string} where user_id = ${m1.id} and company_id = ${A.id}`);
      await asDefiner(sql`delete from teams where id = ${team!.id as string}`);
      const after = await asDefiner(sql`select company_id, primary_team_id from company_memberships where user_id = ${m1.id}`);
      expect(after).toEqual([{ company_id: A.id, primary_team_id: null }]);
      await asDefiner(sql`update company_memberships set primary_team_id = ${A.teams.a1} where user_id = ${m1.id} and company_id = ${A.id}`);
    });

    it('a team membership needs a company membership (23503)', async () => {
      const [u] = await asDefiner(sql`insert into users (email) values ('loner@inv.test') returning id`);
      expect(await pgErrorCode(asDefiner(sql`insert into team_memberships (company_id, team_id, user_id)
        values (${A.id}, ${A.teams.a1}, ${u!.id as string})`))).toBe('23503');
    });

    it('a session started in a company stamps the membership last_active_at (D4)', async () => {
      const m2 = A.people.m2!;
      await asDefiner(sql`update company_memberships set last_active_at = null where user_id = ${m2.id}`);
      await web.execute(sql`insert into auth_sessions (user_id, token_hash, expires_at, active_company_id)
        values (${m2.id}, 'sess-m2', now() + interval '1 day', ${A.id})`);
      const [m] = await asDefiner(sql`select last_active_at is not null as stamped from company_memberships where user_id = ${m2.id}`);
      expect(m).toEqual({ stamped: true });
    });
  });
});
