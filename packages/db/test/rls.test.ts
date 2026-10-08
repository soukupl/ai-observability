import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/client.js';
import { withIngestContext, withRlsContext } from '../src/rls.js';
import { closeAll, connectAs, connectOwner, pgErrorCode, prepareTestDatabase } from './db-harness.js';
import { createCompany, type CompanyFixture, type Person } from './fixtures.js';

/**
 * Proves BRIEF §12.4 against a real Postgres: tenant isolation, member / lead / admin scopes,
 * aggregates-only vs full visibility, and the service-role boundaries (ingest, worker, platform).
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
          union all select company_id from users union all select id from companies`);
        expect(r.length).toBeGreaterThan(0);
        expect(r.every((x) => x.company_id === B.id)).toBe(true);
      }
    });

    it('a forged app.company_id (user of B claiming company A) sees nothing', async () => {
      const forged = { ...B.people.admin!, companyId: A.id };
      for (const t of [...TELEMETRY, 'teams', 'users', 'companies', 'projects', 'budgets']) {
        expect(await count(forged, t)).toBe(0);
      }
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
        'agg_timeline_turns', 'agg_timeline_runs', 'agg_timeline_links']) {
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

    it('manages companies and sees only admin contacts', async () => {
      const cs = [...(await platform.execute(sql`select id from companies`))];
      expect(cs.map((c) => c.id)).toEqual(expect.arrayContaining([A.id, B.id]));
      const us = [...(await platform.execute(sql`select id from users`))].map((u) => u.id);
      expect(new Set(us)).toEqual(new Set([A.people.admin!.id, B.people.admin!.id]));
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
      await as(m1, (tx) => tx.execute(sql`insert into ingest_tokens (company_id, team_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${A.id}, ${A.teams.a1}, ${m1.id}, 'user', 'laptop', 'aiobs_u_ab', 'hash-a', ${m1.id})`));
      const [tok] = [...(await ingest.execute(sql`select * from lookup_ingest_token('hash-a')`))];
      expect(tok).toMatchObject({ company_id: A.id, user_id: m1.id, kind: 'user' });

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

  describe('app_web writes', () => {
    it('members cannot create team tokens or tokens for others', async () => {
      const m1 = A.people.m1!;
      const ins = (kind: string, userId: string | null) =>
        as(m1, (tx) => tx.execute(sql`insert into ingest_tokens (company_id, team_id, user_id, kind, name, prefix, hash, created_by_user_id)
          values (${A.id}, ${A.teams.a1}, ${userId}, ${kind}::token_kind, 'x', 'aiobs_x', ${'h-' + kind + userId}, ${m1.id})`));
      expect(await pgErrorCode(ins('team', null))).toBe('42501');
      expect(await pgErrorCode(ins('user', A.people.m2!.id))).toBe('42501');
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
              external_id, agent_type, depth, started_at, ended_at, stage_index, flow_key, orchestration_id)
            select company_id, team_id, user_id, turn_id, turn_external_id, 'r2', 'workflow', 1,
              started_at + interval '1 second', started_at + interval '2 seconds', 1, 'data', 'wf_r2'
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
});
