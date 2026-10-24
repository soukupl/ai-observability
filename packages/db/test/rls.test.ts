import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/client.js';
import { withIngestContext, withRlsContext } from '../src/rls.js';
import { closeAll, connectAs, connectOwner, pgErrorCode, prepareTestDatabase, useTestDatabase } from './db-harness.js';
import { asDefiner, createDeployment, setVisibility, type DeploymentFixture, type Person } from './fixtures.js';
import { testDbUrl } from './test-db.js';

/**
 * Proves BRIEF §12.4 against a real Postgres after ADR-0028 (one deployment = one company): member / lead / admin
 * scopes, aggregates-only vs full visibility (the deployment's mode is switched between the blocks), agg_* never
 * returning user ids, the service-role boundaries (ingest write guard, worker), tokens (ADR-0029), member removal and
 * the DB invariants. The cross-company proofs of the company era are gone with the company.
 *
 * Fixture: teams t1 / t2; admin (t1 member), lead (lead of t1), m1 (t1), m2 (primary t2, also a member of t1), one
 * unverified (ownerless, old company-token) turn on t1. Every person has one turn on their primary team.
 */
useTestDatabase(testDbUrl('rls'));
const skipReason = await prepareTestDatabase();
if (skipReason) console.warn(`[db] RLS tests skipped: ${skipReason}`);

const TELEMETRY = ['turns', 'runs', 'usage', 'agent_sessions', 'daily_rollups'] as const;
// ISO strings: drizzle's raw sql`` passes Date objects to postgres.js unserialized.
const FROM = new Date(Date.now() - 90 * 86_400_000).toISOString();
const TO = new Date(Date.now() + 86_400_000).toISOString();

describe.skipIf(skipReason !== null)(skipReason ? `RLS — SKIPPED: ${skipReason}` : 'RLS (real Postgres)', () => {
  let web: Database, ingest: Database, worker: Database, owner: Database;
  let D: DeploymentFixture;

  beforeAll(async () => {
    owner = connectOwner();
    D = await createDeployment(owner, 'rls', 'aggregates-only', ['t1', 't2'], [
      { key: 'admin', role: 'admin', teams: [['t1', 'member']] },
      { key: 'lead', teams: [['t1', 'lead']] },
      { key: 'm1', teams: [['t1', 'member']] },
      { key: 'm2', teams: [['t2', 'member'], ['t1', 'member']] },
    ], 't1');
    web = connectAs('web');
    ingest = connectAs('ingest');
    worker = connectAs('worker');
  });
  afterAll(closeAll);

  const as = <T>(p: Person, fn: Parameters<typeof withRlsContext<T>>[2], role = p.role) =>
    withRlsContext(web, { userId: p.id, role }, fn);
  const rows = (p: Person, query: ReturnType<typeof sql>, role = p.role) =>
    as(p, async (tx) => [...(await tx.execute(query))] as Record<string, unknown>[], role);
  const count = async (p: Person, table: string) =>
    Number((await rows(p, sql`select count(*)::int as n from ${sql.identifier(table)}`))[0]!.n);
  const turnUsers = async (p: Person) => (await rows(p, sql`select user_id from turns`)).map((r) => r.user_id as string | null);
  const ownedBy = (pred: (userId: string | null) => boolean) => [...D.turns.values()].filter(pred).length;
  const definer = (q: ReturnType<typeof sql>) => asDefiner(owner, async (tx) => [...(await tx.execute(q))] as Record<string, unknown>[]);
  /** A person with no membership (never joined, or removed): app_user() is null for them. */
  const outsider = async (): Promise<Person> => {
    const [u] = await definer(sql`insert into users (email, name) values (${`outsider-${Math.random()}@rls.test`}, 'Out') returning id`);
    return { id: u!.id as string, role: 'admin' };
  };

  describe('the context', () => {
    it('a user without a membership sees nothing, even claiming admin', async () => {
      const o = await outsider();
      for (const t of [...TELEMETRY, 'teams', 'memberships', 'team_memberships', 'projects', 'budgets', 'ingest_tokens', 'users', 'machines']) {
        expect(await count(o, t), t).toBe(0);
      }
      expect(await rows(o, sql`select app_user() as u, app_is_admin() as a`)).toEqual([{ u: null, a: false }]);
      expect(await rows(o, sql`select * from agg_turns_daily(${FROM}, ${TO})`)).toHaveLength(0);
      expect(await rows(o, sql`select * from agg_ingest_stats()`)).toHaveLength(0);
      expect((await as(o, (tx) => tx.execute(sql`update deployment set name = 'pwned'`))).count).toBe(0);
    });

    it('everyone reads the deployment row (name, settings); the salt is readable only server side', async () => {
      const [d] = await rows(D.people.m1!, sql`select name, slug, settings->>'individualVisibility' as v from deployment`);
      expect(d).toMatchObject({ v: 'aggregates-only' });
      expect(Number((await web.execute(sql`select count(*)::int as n from deployment`))[0]!.n)).toBe(1);
    });
  });

  describe('member', () => {
    it('sees only own rows in every telemetry table, in both modes', async () => {
      for (const mode of ['aggregates-only', 'full'] as const) {
        await setVisibility(owner, mode);
        const m = D.people.m1!;
        expect(await turnUsers(m), mode).toEqual([m.id]);
        for (const t of TELEMETRY) {
          const r = await rows(m, sql`select user_id from ${sql.identifier(t)}`);
          expect(r.length, `${mode} ${t}`).toBeGreaterThan(0);
          expect(r.every((x) => x.user_id === m.id), `${mode} ${t}`).toBe(true);
        }
      }
      await setVisibility(owner, 'aggregates-only');
    });

    it('cannot escalate by claiming app.role = admin', async () => {
      const m = D.people.m1!;
      expect(await rows(m, sql`select user_id from turns`, 'admin')).toHaveLength(1);
      const agg = await rows(m, sql`select sum(turns)::int as n from agg_turns_daily(${FROM}, ${TO})`, 'admin');
      expect(agg[0]!.n).toBe(1);
      const upd = await as(m, (tx) => tx.execute(sql`update deployment set name = 'pwned'`), 'admin');
      expect(upd.count).toBe(0);
    });

    it('sees the directory: every team, member and team membership, no removed identities', async () => {
      const m = D.people.m2!;
      expect(await count(m, 'teams')).toBe(2);
      expect(await count(m, 'memberships')).toBe(4);
      expect(await count(m, 'team_memberships')).toBe(5);
      expect(new Set((await rows(m, sql`select id from users`)).map((r) => r.id))).toEqual(
        new Set(Object.values(D.people).map((p) => p.id)),
      );
    });
  });

  describe('full-detail mode', () => {
    beforeAll(() => setVisibility(owner, 'full'));
    afterAll(() => setVisibility(owner, 'aggregates-only'));

    it('admin sees every turn, incl. unverified ones', async () => {
      expect(await count(D.people.admin!, 'turns')).toBe(D.turns.size);
    });

    it('lead sees only the teams they lead', async () => {
      const lead = D.people.lead!;
      const visible = new Set(await turnUsers(lead));
      expect(visible.has(D.people.m2!.id)).toBe(false); // m2's turn is on t2
      expect(visible.has(D.people.m1!.id)).toBe(true);
      expect(visible.has(null)).toBe(true); // unverified turn of t1
      const t1Turns = ownedBy((u) => u !== D.people.m2!.id);
      for (const t of TELEMETRY) {
        const n = await count(lead, t);
        expect(n, t).toBe(t === 'usage' ? t1Turns * 2 : t1Turns);
      }
    });
  });

  describe('aggregates-only mode', () => {
    it('admin and lead read only their own rows from telemetry tables', async () => {
      for (const p of [D.people.admin!, D.people.lead!]) {
        for (const t of TELEMETRY) {
          const r = await rows(p, sql`select user_id from ${sql.identifier(t)}`);
          expect(r.every((x) => x.user_id === p.id), `${t}`).toBe(true);
        }
        expect(await count(p, 'machines')).toBe(0);
      }
    });

    it('admin gets deployment-wide aggregates through agg_* functions', async () => {
      const admin = D.people.admin!;
      const daily = await rows(admin, sql`select sum(turns)::int as n, sum(input_tokens)::int as i from agg_turns_daily(${FROM}, ${TO})`);
      expect(daily[0]).toEqual({ n: D.turns.size, i: D.turns.size * 100 });
      const usage = await rows(admin, sql`select sum(input_tokens)::int as i from agg_usage_daily(${FROM}, ${TO})`);
      expect(usage[0]!.i).toBe(D.turns.size * 100);
      const agents = await rows(admin, sql`select runs::int from agg_agents(${FROM}, ${TO})`);
      expect(agents).toEqual([{ runs: D.turns.size }]);
      const phases = await rows(admin, sql`select sum(ms)::int as ms from agg_phases('team', ${FROM}, ${TO}) where phase = 'thinking'`);
      expect(phases[0]!.ms).toBe(D.turns.size * 40_000);
      const rollups = await rows(admin, sql`select sum(turns)::int as n from agg_rollups(${FROM.slice(0, 10)}::date, ${TO.slice(0, 10)}::date)`);
      expect(rollups[0]!.n).toBe(D.turns.size);
    });

    it('lead aggregates cover only led teams', async () => {
      const r = await rows(D.people.lead!, sql`select sum(turns)::int as n from agg_turns_daily(${FROM}, ${TO})`);
      // m2's primary team is t2 → excluded even though m2 is also a member of t1.
      expect(r[0]!.n).toBe(ownedBy((u) => u !== D.people.m2!.id));
    });

    it('aggregate outputs never carry user ids', async () => {
      const lead = D.people.lead!;
      const list = await rows(lead, sql`select * from agg_turn_list(${FROM}, ${TO})`);
      expect(list.length).toBe(ownedBy((u) => u !== D.people.m2!.id));
      expect(list.filter((x) => x.is_mine)).toHaveLength(1);
      const userIds = new Set(Object.values(D.people).map((p) => p.id));
      for (const fn of ['agg_turn_list', 'agg_turns_daily', 'agg_usage_daily', 'agg_turns_by_project', 'agg_turns_by_model', 'agg_agents',
        'agg_timeline_turns', 'agg_timeline_runs', 'agg_timeline_links', 'agg_flow_runs', 'agg_flow_links', 'agg_wasted',
        'agg_skill_mcp', 'agg_effort_cells', 'agg_skill_impact', 'agg_mcp_reliability', 'agg_runaways']) {
        const out = await rows(lead, sql`select * from ${sql.identifier(fn)}(${FROM}, ${TO})`);
        for (const row of out) {
          expect(Object.keys(row), fn).not.toContain('user_id');
          expect(Object.values(row).some((v) => userIds.has(v as string)), fn).toBe(false);
        }
      }
      const runs = await rows(lead, sql`select * from agg_turn_runs(${list[0]!.id as string}::uuid)`);
      expect(runs).toHaveLength(1);
      expect(Object.keys(runs[0]!)).not.toContain('user_id');
    });

    it('timeline functions: same scope as the turn list, overlap window, limit, member sees only own (ADR-0019)', async () => {
      const lead = D.people.lead!;
      const visible = ownedBy((u) => u !== D.people.m2!.id);
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
      const own = await rows(D.people.m1!, sql`select is_mine from agg_timeline_turns(${FROM}, ${TO})`);
      expect(own).toEqual([{ is_mine: true }]);
    });

    it('timeline turns: session ids are per-window pseudonyms; parents of runs that outlive their turn are kept', async () => {
      const lead = D.people.lead!;
      const turns = await rows(lead, sql`select id, session_id, started_at, ended_at from agg_timeline_turns(${FROM}, ${TO})`);
      const t = turns[0]!;
      const stored = await owner.execute(sql`select session_id from turns where id = ${t.id as string}::uuid`);
      const storedSession = String((stored as unknown as { session_id: string }[])[0]!.session_id);
      expect(t.session_id).toBeTruthy();
      expect(t.session_id).not.toBe(storedSession);
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
      const code = await pgErrorCode(rows(D.people.admin!, sql`select * from agg_scope_turns(${FROM}, ${TO}, null, null, null, null)`));
      expect(code).toBe('42501');
    });

    it('switching the deployment to full mode reveals per-user rows (admins only may switch)', async () => {
      const setMode = (p: Person, mode: string) =>
        as(p, (tx) => tx.execute(sql`update deployment set settings = jsonb_set(settings, '{individualVisibility}', to_jsonb(${mode}::text))`));
      expect((await setMode(D.people.lead!, 'full')).count).toBe(0);
      expect((await setMode(D.people.admin!, 'full')).count).toBe(1);
      try {
        expect(await count(D.people.admin!, 'turns')).toBe(D.turns.size);
      } finally {
        await setMode(D.people.admin!, 'aggregates-only');
      }
      expect(await count(D.people.admin!, 'turns')).toBe(1);
    });

    it('agg_ingest_stats counts the ledger for any member, nothing without a context', async () => {
      await definer(sql`insert into ingest_events (event_id, type, received_at) values ('stats-1', 'turn', now()), ('stats-2', 'run', now() - interval '3 days')`);
      const stats = await rows(D.people.m1!, sql`select type, events_24h::int as d, events_7d::int as w from agg_ingest_stats()`);
      expect(stats).toEqual([{ type: 'run', d: 0, w: 1 }, { type: 'turn', d: 1, w: 1 }]);
      expect([...(await web.execute(sql`select * from agg_ingest_stats()`))]).toEqual([]);
    });
  });

  describe('ingest-internal tables and the dropped platform role', () => {
    it('pending_turn_patches / pending_session_patches: the dashboard role cannot read them', async () => {
      expect(await pgErrorCode(web.execute(sql`select 1 from pending_turn_patches limit 1`))).toBe('42501');
      expect(await pgErrorCode(web.execute(sql`select 1 from pending_session_patches limit 1`))).toBe('42501');
    });

    it('app_platform holds nothing in this database (migration 0018)', async () => {
      const [grants] = await definer(sql`select
        (select count(*)::int from information_schema.role_table_grants where grantee = 'app_platform') as tables,
        (select count(*)::int from pg_policies where 'app_platform' = any (roles)) as policies,
        (select count(*)::int from pg_proc where proname like 'platform\\_%') as functions`);
      expect(grants).toEqual({ tables: 0, policies: 0, functions: 0 });
    });
  });

  describe('app_ingest', () => {
    let tokenUser: Person;

    beforeAll(async () => {
      tokenUser = D.people.m1!;
      await as(tokenUser, (tx) => tx.execute(sql`insert into ingest_tokens (user_id, name, prefix, hash, created_by_user_id, expires_at)
        values (${tokenUser.id}, 'laptop', 'aiobs_u_ab', 'hash-a', ${tokenUser.id}, now() + interval '90 days')`));
    });

    it('without an ingest context it sees no rows at all, not even ownerless ones', async () => {
      expect(ownedBy((u) => u === null)).toBeGreaterThan(0);
      for (const t of ['turns', 'agent_sessions', 'runs']) {
        expect([...(await ingest.execute(sql`select id from ${sql.identifier(t)}`))]).toEqual([]);
      }
      expect((await ingest.execute(sql`update turns set user_id = ${tokenUser.id}::uuid where user_id is null`)).count).toBe(0);
    });

    it('cannot read telemetry back', async () => {
      for (const q of [sql`select * from turns`, sql`select summary from turns`, sql`select input_tokens from usage`, sql`select * from runs`,
        sql`select * from users`, sql`select * from ingest_tokens`, sql`select * from run_links`, sql`select * from deployment`]) {
        expect(await pgErrorCode(withIngestContext(ingest, tokenUser.id, (tx) => tx.execute(q)))).toBe('42501');
      }
    });

    it('resolves a token via lookup_ingest_token: user, kind, primary team, settings, salt, expiry', async () => {
      const [tok] = [...(await ingest.execute(sql`select * from lookup_ingest_token('hash-a')`))];
      expect(tok).toMatchObject({ user_id: tokenUser.id, user_email: 'm1@rls.test', user_name: 'm1', user_kind: 'person',
        primary_team_id: D.teams.t1, token_source: 'manual', token_label: null });
      expect(Object.keys(tok!).slice(0, 9)).toEqual(['token_id', 'user_id', 'user_email', 'user_name', 'user_kind', 'primary_team_id',
        'settings', 'project_salt', 'expires_at']);
      expect((tok!.settings as { retentionDays: number }).retentionDays).toBe(395);
      expect(tok!.project_salt).toMatch(/^[0-9a-f]{64}$/);
      const [salt] = [...(await ingest.execute(sql`select ingest_project_salt() as s`))] as { s: string }[];
      expect(salt!.s).toBe(tok!.project_salt);
    });

    it('writes only rows of its own user (the ingest write guard) and patches only its own turns', async () => {
      const insertTurn = (userId: string, ext: string) => sql`insert into turns
        (team_id, user_id, attribution, external_id, harness, started_at, ended_at)
        values (${D.teams.t1}, ${userId}, 'verified', ${ext}, 'codex', now(), now()) returning id`;
      await withIngestContext(ingest, tokenUser.id, async (tx) => {
        expect([...(await tx.execute(insertTurn(tokenUser.id, 'ingest-1')))]).toHaveLength(1);
        const patched = await tx.execute(sql`update turns set summary = 'Patched', outcome = 'failed' where external_id = 'ingest-1'`);
        expect(patched.count).toBe(1);
        const dup = await tx.execute(sql`insert into ingest_events (event_id, type) values ('e1', 'turn'), ('e1', 'turn') on conflict do nothing returning event_id`);
        expect([...dup]).toHaveLength(1);
        // Idempotent upserts with RETURNING id work with the column-level grants, as long as SET uses bound values.
        const upsertMachine = sql`insert into machines (user_id, machine_id, os) values (${tokenUser.id}, 'mac-1', 'darwin')
          on conflict (machine_id) do update set last_seen_at = now(), os = ${'darwin'}, user_id = ${tokenUser.id}::uuid returning id`;
        const [first] = [...(await tx.execute(upsertMachine))];
        const [again] = [...(await tx.execute(upsertMachine))];
        expect(again!.id).toBe(first!.id);
        const upsertProject = sql`insert into projects (key) values ('github.com/acme/api')
          on conflict (key) do update set last_seen_at = now() returning id, team_id`;
        expect([...(await tx.execute(upsertProject))]).toHaveLength(1);
        // The project → team mapping is the admins' (ADR-0030): ingest neither sets nor changes projects.team_id.
        expect(await pgErrorCode(tx.transaction((sp) => sp.execute(sql`insert into projects (key, team_id)
          values ('github.com/acme/forged', ${D.teams.t2}::uuid)`)))).toBe('42501');
        expect(await pgErrorCode(tx.transaction((sp) => sp.execute(sql`update projects set team_id = ${D.teams.t2}::uuid
          where key = 'github.com/acme/api'`)))).toBe('42501');
        // Another user's turn is invisible to this user's patches.
        const others = await tx.execute(sql`update turns set summary = 'x' where user_id = ${D.people.m2!.id}::uuid`);
        expect(others.count).toBe(0);
      });
      // Local paths are never stored as project keys (CHECK constraint).
      const pathKey = sql`insert into projects (key) values ('/Users/dev/secret')`;
      expect(await pgErrorCode(withIngestContext(ingest, tokenUser.id, (tx) => tx.execute(pathKey)))).toBe('23514');
      // A row for another user is rejected by the WITH CHECK policy; so is a write with no context at all.
      expect(await pgErrorCode(withIngestContext(ingest, tokenUser.id, (tx) => tx.execute(insertTurn(D.people.m2!.id, 'ingest-x'))))).toBe('42501');
      expect(await pgErrorCode(ingest.execute(insertTurn(tokenUser.id, 'ingest-y')))).toBe('42501');
      expect(await pgErrorCode(ingest.execute(sql`insert into ingest_events (event_id, type) values ('e-noctx', 'turn')`))).toBe('42501');
      // m2's ingest context cannot patch m1's turn.
      const other = await withIngestContext(ingest, D.people.m2!.id, (tx) => tx.execute(sql`update turns set summary = 'x' where external_id = 'ingest-1'`));
      expect(other.count).toBe(0);
      // A machine used by two people: the second one's upsert takes it over (machines are shared, rows are not hidden).
      const [m] = [...(await withIngestContext(ingest, D.people.m2!.id, (tx) => tx.execute(sql`insert into machines (user_id, machine_id, os)
        values (${D.people.m2!.id}, 'mac-1', 'darwin') on conflict (machine_id) do update set last_seen_at = now(), user_id = ${D.people.m2!.id}::uuid returning id`)))];
      expect(m).toBeDefined();
    });

    it('an ownerless (old company-token) row may be claimed by the token user, never handed to another user', async () => {
      const unverified = [...D.turns].find(([, u]) => u === null)![0];
      const claimed = await withIngestContext(ingest, tokenUser.id, (tx) =>
        tx.execute(sql`update turns set user_id = ${tokenUser.id}::uuid, attribution = 'verified' where id = ${unverified}::uuid and user_id is null`));
      expect(claimed.count).toBe(1);
      expect(await pgErrorCode(withIngestContext(ingest, tokenUser.id, (tx) =>
        tx.execute(sql`update turns set user_id = ${D.people.m2!.id}::uuid where id = ${unverified}::uuid`)))).toBe('42501');
      await definer(sql`update turns set user_id = null, attribution = 'unverified' where id = ${unverified}::uuid`);
    });

    it('team resolution helpers: membership-checked slug lookup, status and the user’s teams', async () => {
      const slugs = await definer(sql`select (select slug from teams where id = ${D.teams.t1}::uuid) as s1,
        (select slug from teams where id = ${D.teams.t2}::uuid) as s2`);
      expect(slugs).toEqual([{ s1: 'rls-t1', s2: 'rls-t2' }]);
      const resolve = async (u: string, slug: string) =>
        ([...(await ingest.execute(sql`select ingest_resolve_team(${u}::uuid, ${slug}) as t`))][0] as { t: string | null }).t;
      expect(await resolve(D.people.m2!.id, 'rls-t1')).toBe(D.teams.t1);
      expect(await resolve(D.people.m1!.id, 'rls-t2')).toBeNull(); // not a member
      expect(await resolve(D.people.m1!.id, 'nope')).toBeNull(); // unknown
      const status = async (u: string, slug: string) => [...(await ingest.execute(sql`select * from ingest_team_status(${u}::uuid, ${slug})`))];
      expect(await status(D.people.m1!.id, 'rls-t1')).toEqual([{ team_id: D.teams.t1, status: 'member' }]);
      expect(await status(D.people.m1!.id, 'rls-t2')).toEqual([{ team_id: null, status: 'not_member' }]);
      expect(await status(D.people.m1!.id, 'nope')).toEqual([{ team_id: null, status: 'unknown' }]);
      const teams = [...(await ingest.execute(sql`select slug, role from ingest_user_teams(${D.people.m2!.id}::uuid)`))];
      expect(teams).toEqual([{ slug: 'rls-t1', role: 'member' }, { slug: 'rls-t2', role: 'member' }]);
    });

    it('revoked and expired tokens resolve to nothing', async () => {
      await as(tokenUser, (tx) => tx.execute(sql`insert into ingest_tokens (user_id, name, prefix, hash, created_by_user_id, expires_at)
        values (${tokenUser.id}, 'old', 'aiobs_u_ex', 'hash-expired', ${tokenUser.id}, now() - interval '1 minute'),
               (${tokenUser.id}, 'forever', 'aiobs_u_fv', 'hash-forever', ${tokenUser.id}, null)`));
      expect([...(await ingest.execute(sql`select * from lookup_ingest_token('hash-expired')`))]).toHaveLength(0);
      expect([...(await ingest.execute(sql`select * from lookup_ingest_token('hash-forever')`))]).toHaveLength(1);
      await as(tokenUser, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = now() where hash = 'hash-a'`));
      expect([...(await ingest.execute(sql`select * from lookup_ingest_token('hash-a')`))]).toHaveLength(0);
    });
  });

  describe('app_web writes: tokens (ADR-0029)', () => {
    let svc: string;
    const ins = (p: Person, userId: string, hash: string, source = 'manual') =>
      as(p, (tx) => tx.execute(sql`insert into ingest_tokens (user_id, name, source, prefix, hash, created_by_user_id, expires_at)
        values (${userId}, 'x', ${source}::token_source, 'aiobs_u_x', ${hash}, ${p.id}, now() + interval '30 days')`));
    const tokenHashes = async (p: Person) =>
      (await rows(p, sql`select hash from ingest_tokens where hash like 'w-%' order by hash`)).map((r) => r.hash);

    beforeAll(async () => {
      const [s] = await rows(D.people.admin!, sql`select admin_create_service_user('ci bot', ${D.teams.t1}::uuid) as id`);
      svc = s!.id as string;
    });

    it('everyone creates only their own manual tokens; device tokens come only from device_exchange', async () => {
      expect(await pgErrorCode(ins(D.people.m1!, D.people.m2!.id, 'w-m1-for-m2'))).toBe('42501');
      expect(await pgErrorCode(ins(D.people.m2!, D.people.m2!.id, 'w-m2-own'))).toBeUndefined();
      expect(await pgErrorCode(ins(D.people.m2!, D.people.m2!.id, 'w-m2-device', 'device'))).toBe('42501');
      expect(await pgErrorCode(ins(D.people.lead!, svc, 'w-lead-svc'))).toBe('42501');
    });

    it('admins create tokens for service users, never for other people', async () => {
      expect(await pgErrorCode(ins(D.people.admin!, svc, 'w-admin-svc'))).toBeUndefined();
      expect(await pgErrorCode(ins(D.people.admin!, D.people.m2!.id, 'w-admin-for-m2'))).toBe('42501');
      // A token always has a user (NOT NULL, also for app_definer).
      const bad = asDefiner(owner, (tx) => tx.execute(sql`insert into ingest_tokens (name, prefix, hash) values ('x', 'aiobs_u_x', 'w-bad')`));
      expect(await pgErrorCode(bad)).toBe('23502');
    });

    it('visibility: admins see every token, everyone else (leads included) only their own', async () => {
      expect(await tokenHashes(D.people.admin!)).toEqual(['w-admin-svc', 'w-m2-own']);
      expect(await tokenHashes(D.people.lead!)).toEqual([]);
      expect(await tokenHashes(D.people.m2!)).toEqual(['w-m2-own']);
      expect(await tokenHashes(D.people.m1!)).toEqual([]);
      const [svcTok] = [...(await ingest.execute(sql`select * from lookup_ingest_token('w-admin-svc')`))];
      expect(svcTok).toMatchObject({ user_id: svc, user_kind: 'service', user_email: null, user_name: 'ci bot', primary_team_id: D.teams.t1 });
    });

    it('admins revoke any token, others only their own', async () => {
      expect((await as(D.people.m1!, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = now() where hash = 'w-m2-own'`))).count).toBe(0);
      expect((await as(D.people.admin!, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = now() where hash = 'w-m2-own'`))).count).toBe(1);
    });

    it('service users: admins rename them; people cannot be renamed through app_web', async () => {
      expect((await as(D.people.admin!, (tx) => tx.execute(sql`update users set name = 'ci runner' where id = ${svc}::uuid`))).count).toBe(1);
      expect((await as(D.people.admin!, (tx) => tx.execute(sql`update users set name = 'x' where id = ${D.people.m1!.id}::uuid`))).count).toBe(0);
      expect((await as(D.people.m1!, (tx) => tx.execute(sql`update users set name = 'x' where id = ${svc}::uuid`))).count).toBe(0);
      expect(await pgErrorCode(rows(D.people.m1!, sql`select admin_create_service_user('nope')`))).toBe('42501');
    });
  });

  describe('model prices (admins edit them)', () => {
    it('everyone reads; only admins write', async () => {
      expect(await count(D.people.m1!, 'model_prices')).toBeGreaterThan(0);
      const ins = (p: Person) => as(p, (tx) => tx.execute(sql`insert into model_prices (model, effective_from, input_per_mtok, output_per_mtok,
        cache_read_per_mtok, cache_write_per_mtok) values ('test-model', '2026-10-01', 1, 2, 0.1, 1.25)`));
      expect(await pgErrorCode(ins(D.people.m1!))).toBe('42501');
      expect(await pgErrorCode(ins(D.people.admin!))).toBeUndefined();
      expect((await as(D.people.m1!, (tx) => tx.execute(sql`delete from model_prices where model = 'test-model'`))).count).toBe(0);
      expect((await as(D.people.admin!, (tx) => tx.execute(sql`delete from model_prices where model = 'test-model'`))).count).toBe(1);
    });
  });

  describe('app_worker', () => {
    it('reads telemetry and the deployment but cannot touch tokens or auth secrets', async () => {
      const [r] = [...(await worker.execute(sql`select count(*)::int as n from turns`))];
      expect(r!.n).toBeGreaterThanOrEqual(D.turns.size);
      const [d] = [...(await worker.execute(sql`select settings->>'retentionDays' as r from deployment`))];
      expect(d).toEqual({ r: '395' });
      expect(await pgErrorCode(worker.execute(sql`select * from ingest_tokens`))).toBe('42501');
      expect(await pgErrorCode(worker.execute(sql`update turns set summary = 'x'`))).toBe('42501');
    });
  });

  describe('run_links (ADR-0020)', () => {
    // m1's turn gets a second run r2 (stage 1, flow 'data') fed by r1 (an 'item' link), plus a link whose source has not
    // arrived (from_run_id null). The worker removes r2 at the end (cascade test), so the run counts of the other blocks
    // are unaffected.
    let extra: { turnId: string; r1: string; r2: string };

    beforeAll(async () => {
      const turnId = [...D.turns].find(([, u]) => u === D.people.m1!.id)![0];
      await asDefiner(owner, async (tx) => {
        const [r1] = [...(await tx.execute(sql`select id from runs where turn_id = ${turnId}::uuid`))] as { id: string }[];
        const [r2] = [...(await tx.execute(sql`insert into runs (team_id, user_id, turn_id, turn_external_id,
            external_id, agent_type, depth, started_at, ended_at, stage_index, flow_key, orchestration_id, skills, mcp)
          select team_id, user_id, turn_id, turn_external_id, 'r2', 'workflow', 1,
            started_at + interval '1 second', started_at + interval '2 seconds', 1, 'data', 'wf_r2',
            '{"review": {"model": 1, "user": 0}}'::jsonb, '{"github": {"get_issue": 2}}'::jsonb
          from runs where id = ${r1!.id}::uuid returning id`))] as { id: string }[];
        await tx.execute(sql`insert into run_links (turn_id, turn_external_id, from_run_id, to_run_id, from_external_id, to_external_id, kind)
          select turn_id, turn_external_id, ${r1!.id}::uuid, ${r2!.id}::uuid, 'r1', 'r2', 'item' from runs where id = ${r1!.id}::uuid
          union all
          select turn_id, turn_external_id, null, ${r2!.id}::uuid, 'r0-missing', 'r2', 'sequence' from runs where id = ${r1!.id}::uuid`);
        extra = { turnId, r1: r1!.id, r2: r2!.id };
      });
    });

    const linkCount = async (p: Person) => count(p, 'run_links');

    it('a link is visible when its target run is: owner, a lead of the team in full mode; not another member', async () => {
      await setVisibility(owner, 'full');
      try {
        expect(await linkCount(D.people.m1!)).toBe(2);
        expect(await linkCount(D.people.lead!)).toBe(2);
        expect(await linkCount(D.people.admin!)).toBe(2);
        expect(await linkCount(D.people.m2!)).toBe(0);
      } finally {
        await setVisibility(owner, 'aggregates-only');
      }
      // Aggregates-only: only the owner reads rows; the lead and admin go through agg_turn_links.
      expect(await linkCount(D.people.m1!)).toBe(2);
      for (const k of ['lead', 'admin', 'm2']) expect(await linkCount(D.people[k]!), k).toBe(0);
      expect(await linkCount(await outsider())).toBe(0);
    });

    it('agg_turn_links / agg_timeline_links give an aggregates-only admin the resolved links, never user ids', async () => {
      const admin = D.people.admin!;
      const { turnId, r1, r2 } = extra;
      const edge = { from_run_id: r1, to_run_id: r2, kind: 'item' };
      expect(await rows(admin, sql`select * from agg_turn_links(${turnId}::uuid)`)).toEqual([edge]);
      expect(await rows(admin, sql`select * from agg_timeline_links(${FROM}, ${TO})`)).toEqual([edge]);
      expect(await rows(D.people.lead!, sql`select * from agg_timeline_links(${FROM}, ${TO})`)).toEqual([edge]);
      expect(await rows(admin, sql`select * from agg_timeline_links(${FROM}, ${TO}, p_limit => 0)`)).toEqual([]);
      // Out of scope: a member for someone else's turn, a user without a membership, a window after the target run.
      expect(await rows(D.people.m2!, sql`select * from agg_turn_links(${turnId}::uuid)`)).toEqual([]);
      expect(await rows(D.people.m2!, sql`select * from agg_timeline_links(${FROM}, ${TO})`)).toEqual([]);
      expect(await rows(await outsider(), sql`select * from agg_turn_links(${turnId}::uuid)`)).toEqual([]);
      const late = new Date(Date.now() + 3_600_000).toISOString();
      expect(await rows(admin, sql`select * from agg_timeline_links(${late}::timestamptz, ${TO})`)).toEqual([]);
      const turnRuns = await rows(admin, sql`select id, agent_group, stage_index, flow_key, orchestration_id from agg_turn_runs(${turnId}::uuid)`);
      expect(turnRuns).toEqual(expect.arrayContaining([{ id: r2, agent_group: null, stage_index: 1, flow_key: 'data', orchestration_id: 'wf_r2' }]));
      const winRuns = await rows(admin, sql`select id, stage_index, flow_key from agg_timeline_runs(${FROM}, ${TO}) where id = ${r2}::uuid`);
      expect(winRuns).toEqual([{ id: r2, stage_index: 1, flow_key: 'data' }]);
      const userIds = new Set(Object.values(D.people).map((p) => p.id));
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
      const { turnId, r2 } = extra;
      const out = await rows(D.people.admin!, sql`select * from agg_turn_runs(${turnId}::uuid)`);
      expect(out).toHaveLength(2);
      expect(Object.keys(out[0]!).slice(-5)).toEqual(['stage_index', 'flow_key', 'orchestration_id', 'skills', 'mcp']);
      expect(out.find((r) => r.id === r2)).toMatchObject({ skills: { review: { model: 1, user: 0 } }, mcp: { github: { get_issue: 2 } } });
      expect(out.find((r) => r.id !== r2)).toMatchObject({ skills: {}, mcp: {} });
    });

    it('agg_flow_runs / agg_flow_links: the aggregates-only admin gets the deployment scope, filters and limit apply, never user ids', async () => {
      const admin = D.people.admin!;
      const lead = D.people.lead!;
      const { turnId, r1, r2 } = extra;
      const allRuns = D.turns.size + 1; // one run per turn plus r2
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
      const userIds = new Set(Object.values(D.people).map((p) => p.id));
      for (const row of runs) expect(Object.values(row).some((v) => userIds.has(v as string))).toBe(false);
      // Lead: led team t1 only (m2's primary team is t2); member m2: own turn only; no membership: nothing.
      expect(await rows(lead, sql`select id from agg_flow_runs(${FROM}, ${TO})`)).toHaveLength(allRuns - 1);
      const m2Runs = await rows(D.people.m2!, sql`select turn_is_mine from agg_flow_runs(${FROM}, ${TO})`);
      expect(m2Runs).toEqual([{ turn_is_mine: true }]);
      expect(await rows(await outsider(), sql`select id from agg_flow_runs(${FROM}, ${TO}) where id in (${r1}::uuid, ${r2}::uuid)`)).toEqual([]);
      // Team / harness / model filters and the limit (capped at the default + 1).
      expect(await rows(admin, sql`select id from agg_flow_runs(${FROM}, ${TO}, ${D.teams.t2!}::uuid)`)).toHaveLength(1);
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

      const edge = { from_run_id: r1, to_run_id: r2, kind: 'item' };
      expect(await rows(admin, sql`select * from agg_flow_links(${FROM}, ${TO})`)).toEqual([edge]);
      expect(await rows(lead, sql`select * from agg_flow_links(${FROM}, ${TO})`)).toEqual([edge]);
      expect(await rows(admin, sql`select * from agg_flow_links(${FROM}, ${TO}, ${D.teams.t2!}::uuid)`)).toEqual([]);
      expect(await rows(admin, sql`select * from agg_flow_links(${FROM}, ${TO}, p_limit => 0)`)).toEqual([]);
      expect(await rows(admin, sql`select * from agg_flow_links(${justAfter}::timestamptz, ${TO})`)).toEqual([]);
      expect(await rows(D.people.m2!, sql`select * from agg_flow_links(${FROM}, ${TO})`)).toEqual([]);

      // Project filter: move m1's turn into a project; only its runs / links match.
      const [project] = [...(await owner.execute(sql`insert into projects (key) values ('github.com/acme/flows') returning id`))] as { id: string }[];
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

    it('app_ingest writes links only with a context and cannot read their timestamps', async () => {
      const { r2 } = extra;
      const insert = sql`insert into run_links (turn_external_id, to_run_id, from_external_id, to_external_id, kind)
        values ('ext', ${r2}::uuid, 'x', 'y', 'item')`;
      expect(await pgErrorCode(ingest.execute(insert))).toBe('42501');
      expect(await pgErrorCode(withIngestContext(ingest, D.people.m1!.id, (tx) => tx.execute(sql`select created_at from run_links`)))).toBe('42501');
      const bad = sql`insert into run_links (turn_external_id, to_run_id, from_external_id, to_external_id, kind)
        values ('ext', ${r2}::uuid, 'x', 'y', 'continues')`;
      expect(await pgErrorCode(withIngestContext(ingest, D.people.m1!.id, (tx) => tx.execute(bad)))).toBe('23514');
    });

    it('app_ingest touches only the links of its own user\'s runs (the target run decides)', async () => {
      const { r2 } = extra;
      const m1 = D.people.m1!.id, m2 = D.people.m2!.id;
      const insert = sql`insert into run_links (turn_external_id, to_run_id, from_external_id, to_external_id, kind)
        values ('ext-own', ${r2}::uuid, 'x', 'r2', 'item')`;
      // m2 neither sees, deletes, re-points nor adds links whose target run is m1's.
      await withIngestContext(ingest, m2, async (tx) => {
        expect([...(await tx.execute(sql`select id from run_links where to_run_id = ${r2}::uuid`))]).toEqual([]);
        expect((await tx.execute(sql`delete from run_links where to_run_id = ${r2}::uuid`)).count).toBe(0);
        expect((await tx.execute(sql`update run_links set turn_id = null where to_run_id = ${r2}::uuid`)).count).toBe(0);
      });
      expect(await pgErrorCode(withIngestContext(ingest, m2, (tx) => tx.execute(insert)))).toBe('42501');
      // m1 (the owner) can.
      await withIngestContext(ingest, m1, async (tx) => {
        expect([...(await tx.execute(insert))]).toEqual([]);
        expect((await tx.execute(sql`delete from run_links where turn_external_id = 'ext-own'`)).count).toBe(1);
      });
      expect(await linkCount(D.people.m1!)).toBe(2);
    });

    it('retention: the worker deleting a run removes its links through the cascade, without a grant on run_links', async () => {
      expect(await pgErrorCode(worker.execute(sql`select 1 from run_links limit 1`))).toBe('42501');
      const del = await worker.execute(sql`delete from runs where id = ${extra.r2}::uuid`);
      expect(del.count).toBe(1);
      const left = [...(await owner.execute(sql`select count(*)::int as n from run_links`))];
      expect(left[0]!.n).toBe(0);
    });
  });

  describe('identities and member removal', () => {
    it('users.last_login_at is not readable by app_web; identity columns are', async () => {
      for (const p of [D.people.m1!, D.people.admin!]) {
        expect(await pgErrorCode(rows(p, sql`select last_login_at from users`))).toBe('42501');
        expect(await pgErrorCode(rows(p, sql`select * from users`))).toBe('42501');
      }
      const seen = await rows(D.people.m1!, sql`select id, email, name, kind from users where id = ${D.people.m1!.id}::uuid`);
      expect(seen).toEqual([{ id: D.people.m1!.id, email: 'm1@rls.test', name: 'm1', kind: 'person' }]);
    });

    it('admin_remove_member: membership-bound rows go, telemetry stays, tokens are revoked, sessions end (D1, D2, D8)', async () => {
      // dana: a member of t1 (lead) with telemetry, a machine, a runaway alert, a per-user budget, tokens and a session.
      const X = await createDeployment(owner, 'rm', 'aggregates-only', ['x1'], [{ key: 'dana', teams: [['x1', 'lead']] }]);
      const dana = X.people.dana!;
      const danaTurn = [...X.turns.keys()][0]!;
      await definer(sql`insert into machines (user_id, machine_id) values (${dana.id}, 'dana-mac')`);
      await definer(sql`insert into runaway_alerts (turn_id, team_id, user_id, harness, started_at, reasons)
        values (${danaTurn}, ${X.teams.x1}, ${dana.id}, 'claude-code', now() - interval '1 hour', '["tokens"]')`);
      await definer(sql`insert into budgets (user_id, kind, limit_value) values (${dana.id}, 'tokens', 1000)`);
      await as(dana, (tx) => tx.execute(sql`insert into ingest_tokens (user_id, name, prefix, hash, created_by_user_id, expires_at)
        values (${dana.id}, 'laptop', 'aiobs_u_d', 'dana-user', ${dana.id}, now() + interval '90 days')`));
      await web.execute(sql`insert into auth_sessions (user_id, token_hash, expires_at) values (${dana.id}, 'sess-dana', now() + interval '1 day')`);

      // Only an admin may call it, never on themselves.
      expect(await pgErrorCode(as(D.people.m1!, (tx) => tx.execute(sql`select * from admin_remove_member(${dana.id}::uuid)`)))).toBe('42501');
      expect(await pgErrorCode(as(D.people.m1!, (tx) => tx.execute(sql`select * from admin_remove_member(${dana.id}::uuid)`), 'admin'))).toBe('42501');
      expect(await pgErrorCode(as(D.people.admin!, (tx) => tx.execute(sql`select * from admin_remove_member(${D.people.admin!.id}::uuid)`)))).toBe('42501');

      const revoked = await rows(D.people.admin!, sql`select * from admin_remove_member(${dana.id}::uuid)`);
      expect(revoked.map((t) => t.token_name)).toEqual(['laptop']);
      expect(Object.keys(revoked[0]!)).toEqual(['token_id', 'token_name', 'token_prefix']);

      const n = async (q: ReturnType<typeof sql>) => Number((await definer(q))[0]!.n);
      expect(await n(sql`select count(*)::int n from memberships where user_id = ${dana.id}`)).toBe(0);
      expect(await n(sql`select count(*)::int n from team_memberships where user_id = ${dana.id}`)).toBe(0);
      expect(await n(sql`select count(*)::int n from budgets where user_id = ${dana.id}`)).toBe(0);
      expect(await n(sql`select count(*)::int n from auth_sessions where user_id = ${dana.id}`)).toBe(0);
      for (const t of ['turns', 'runs', 'usage', 'agent_sessions', 'machines', 'daily_rollups', 'runaway_alerts']) {
        expect(await n(sql`select count(*)::int n from ${sql.identifier(t)} where user_id = ${dana.id}`), t).toBeGreaterThan(0);
      }
      expect(await definer(sql`select revoked_at is not null as revoked from ingest_tokens where hash = 'dana-user'`)).toEqual([{ revoked: true }]);
      expect([...(await ingest.execute(sql`select * from lookup_ingest_token('dana-user')`))]).toHaveLength(0);

      // The admin still sees the kept turn through the aggregates, but no longer dana's identity (a former member).
      const ids = (await rows(D.people.admin!, sql`select id from agg_turn_list(${FROM}, ${TO})`)).map((r) => r.id);
      expect(ids).toContain(danaTurn);
      expect(await rows(D.people.admin!, sql`select name from users where id = ${dana.id}`)).toEqual([]);
      // dana's own context is dead without the membership.
      expect(await rows(dana, sql`select app_user() as u`)).toEqual([{ u: null }]);
      expect(await count(dana, 'turns')).toBe(0);
      // An unrevoked token of a removed member (e.g. inserted concurrently) still never resolves.
      await definer(sql`insert into ingest_tokens (user_id, name, prefix, hash) values (${dana.id}, 'race', 'aiobs_u_r', 'dana-race')`);
      expect([...(await ingest.execute(sql`select * from lookup_ingest_token('dana-race')`))]).toHaveLength(0);
    });
  });

  describe('invariants', () => {
    it('a revoked token stays revoked: owner, admin and app_definer all get 42501', async () => {
      const m1 = D.people.m1!;
      await as(m1, (tx) => tx.execute(sql`insert into ingest_tokens (user_id, name, prefix, hash, created_by_user_id)
        values (${m1.id}, 'r', 'aiobs_u_r', 'inv-user', ${m1.id})`));
      expect((await as(m1, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = now() where hash = 'inv-user'`))).count).toBe(1);
      expect(await pgErrorCode(as(m1, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = null where hash = 'inv-user'`)))).toBe('42501');
      expect(await pgErrorCode(as(D.people.admin!, (tx) => tx.execute(sql`update ingest_tokens set revoked_at = null where hash = 'inv-user'`)))).toBe('42501');
      expect(await pgErrorCode(definer(sql`update ingest_tokens set revoked_at = now() - interval '1 day' where hash = 'inv-user'`))).toBe('42501');
      // Renaming a revoked token is still fine (the trigger only guards revoked_at).
      expect((await as(m1, (tx) => tx.execute(sql`update ingest_tokens set name = 'old' where hash = 'inv-user'`))).count).toBe(1);
    });

    it('a person needs an e-mail, a service user has none; the deployment has exactly one row', async () => {
      expect(await pgErrorCode(definer(sql`insert into users (name) values ('no mail')`))).toBe('23514');
      expect(await pgErrorCode(definer(sql`insert into users (name, kind) values ('bot', 'service') returning id`))).toBeUndefined();
      expect(await pgErrorCode(definer(sql`insert into users (email) values ('Upper@Case.test')`))).toBe('23514');
      expect(await pgErrorCode(definer(sql`insert into deployment (name, slug) values ('second', 'second')`))).toBe('23505');
    });

    it('team slugs: derived from the name, unique, fixed once a turn references the team (ADR-0030)', async () => {
      const [a] = await definer(sql`insert into teams (name) values ('Žlutý Kůň & Co.') returning id, slug`);
      expect(a!.slug).toBe('lut-k-co');
      const [b] = await definer(sql`insert into teams (name, slug) values ('Other', '') returning slug`);
      expect(b!.slug).toBe('other');
      const [c] = await definer(sql`insert into teams (name) values ('other ') returning slug`);
      expect(c!.slug).toBe('other-2');
      expect(await pgErrorCode(definer(sql`insert into teams (name, slug) values ('Bad', 'Not Valid')`))).toBe('23514');
      expect(await pgErrorCode(definer(sql`insert into teams (name, slug) values ('Dup', 'other')`))).toBe('23505');
      // An unused team's slug can change (admins, through app_web); a used one cannot.
      expect((await as(D.people.admin!, (tx) => tx.execute(sql`update teams set slug = 'yellow' where id = ${a!.id as string}::uuid`))).count).toBe(1);
      expect((await as(D.people.m1!, (tx) => tx.execute(sql`update teams set slug = 'x' where id = ${a!.id as string}::uuid`))).count).toBe(0);
      expect(await pgErrorCode(as(D.people.admin!, (tx) => tx.execute(sql`update teams set slug = 'renamed' where id = ${D.teams.t1}::uuid`)))).toBe('23514');
      expect((await as(D.people.admin!, (tx) => tx.execute(sql`update teams set name = 'renamed' where id = ${D.teams.t1}::uuid`))).count).toBe(1);
      await definer(sql`update teams set name = 'rls-t1' where id = ${D.teams.t1}::uuid`);
    });

    it('deleting a team nulls only primary_team_id; members cannot change memberships', async () => {
      const m1 = D.people.m1!;
      const denied = await as(m1, (tx) => tx.execute(sql`update memberships set role = 'admin' where user_id = ${m1.id}`));
      expect(denied.count).toBe(0);
      const ok = await as(D.people.admin!, (tx) => tx.execute(sql`update memberships set primary_team_id = ${D.teams.t2} where user_id = ${m1.id}`));
      expect(ok.count).toBe(1);
      const [team] = await definer(sql`insert into teams (name) values ('temp') returning id`);
      await definer(sql`update memberships set primary_team_id = ${team!.id as string} where user_id = ${m1.id}`);
      await definer(sql`delete from teams where id = ${team!.id as string}`);
      expect(await definer(sql`select role, primary_team_id from memberships where user_id = ${m1.id}`)).toEqual([{ role: 'member', primary_team_id: null }]);
      await definer(sql`update memberships set primary_team_id = ${D.teams.t1} where user_id = ${m1.id}`);
    });

    it('a team membership needs a membership (23503); one membership per user (23505)', async () => {
      const [u] = await definer(sql`insert into users (email) values ('loner@inv.test') returning id`);
      expect(await pgErrorCode(definer(sql`insert into team_memberships (team_id, user_id) values (${D.teams.t1}, ${u!.id as string})`))).toBe('23503');
      expect(await pgErrorCode(definer(sql`insert into memberships (user_id) values (${D.people.m1!.id})`))).toBe('23505');
    });
  });
});
