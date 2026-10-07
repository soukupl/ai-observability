import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@ai-obs/db';
import type { WorkerContext } from '../src/context.js';
import { monthToDate, runBudgets } from '../src/jobs/budgets.js';
import { runRetention } from '../src/jobs/retention.js';
import { recomputeDay, runRollups } from '../src/jobs/rollups.js';
import { detectRunaways, sendRunawayDigests } from '../src/jobs/runaways.js';
import { loadConfig } from '../src/lib/config.js';
import type { MailMessage } from '../src/lib/mailer.js';
import { memoryStateStore } from '../src/lib/state.js';
import { addBudget, addNoise, addTurn, openWorkerTestDb, ownerTx, seedCompany, type Seeded } from './db-fixture.js';

type Harness = Awaited<ReturnType<typeof openWorkerTestDb>>['h'];

const NOW = new Date('2026-10-05T12:00:00Z');
const AFTER_NOW = '2026-10-05T12:01:00Z'; // created/updated stamp of "fresh" rows, after any watermark taken at NOW

let h: Harness;
let skip: string | null;
let owner: Database;
let worker: Database;
let co: Seeded;

const rows = async <T = Record<string, unknown>>(q: ReturnType<typeof sql>) => (await owner.execute(q)) as unknown as T[];

function makeCtx(over: { now?: Date; mails?: MailMessage[]; failMail?: boolean } = {}): WorkerContext & { state: ReturnType<typeof memoryStateStore> } {
  const mails = over.mails ?? [];
  return {
    db: worker,
    state: memoryStateStore(),
    config: loadConfig({ APP_URL: 'https://obs.test' }),
    log: { info: vi.fn(), error: vi.fn() },
    mailer: {
      send: async (m) => {
        if (over.failMail) throw new Error('smtp down');
        mails.push(m);
      },
    },
    now: () => over.now ?? NOW,
  };
}

const OPUS = 'claude-opus-5-5'; // default price: 4 in / 20 out per Mtok since 2026-01-01
const HAIKU = 'claude-haiku-4-5';

beforeAll(async () => {
  const r = await openWorkerTestDb();
  skip = r.skip;
  h = r.h;
  if (skip) return;
  owner = h.connectOwner();
  worker = h.connectAs('worker');
}, 60_000);

afterAll(async () => {
  if (h) await h.closeAll();
});

describe('worker jobs against Postgres', () => {
  it('is reachable or skips with a reason', (ctx) => {
    if (skip) {
      console.warn(`worker integration tests skipped: ${skip}`);
      ctx.skip();
    }
  });

  describe('rollups', () => {
    beforeAll(async () => {
      if (skip) return;
      co = await seedCompany(owner, { slug: 'rollups', retentionDays: 90 });
      const a = co.teamA;
      await addTurn(owner, co.companyId, { key: 'r1', at: '2026-10-05T09:00:00Z', user: co.carol, team: a, usage: [[OPUS, 'high', 1000, 200, 5000, 300], [HAIKU, null, 50, 10, 0, 0]] });
      await addTurn(owner, co.companyId, { key: 'r2', at: '2026-10-05T10:00:00Z', user: co.carol, team: a, outcome: 'failed', usage: [[OPUS, 'high', 400, 100, 0, 0]] });
      await addTurn(owner, co.companyId, { key: 'r3', at: '2026-10-05T11:00:00Z', user: null, team: a, outcome: 'unknown', usage: [[OPUS, 'low', 10, 1, 0, 0]] });
      await addTurn(owner, co.companyId, { key: 'r4', at: '2026-09-20T09:00:00Z', user: co.dave, team: co.teamB, usage: [[HAIKU, null, 700, 70, 0, 0]] });
    });

    const rollupSums = (day: string) =>
      rows<{ turns: string; runs: string; i: string; o: string; cr: string; cw: string; rq: string; dur: string; ok: string; failed: string; unknown: string; n: string }>(sql`
        select coalesce(sum(turns),0) turns, coalesce(sum(runs),0) runs, coalesce(sum(input_tokens),0) i, coalesce(sum(output_tokens),0) o,
          coalesce(sum(cache_read_tokens),0) cr, coalesce(sum(cache_write_tokens),0) cw, coalesce(sum(requests),0) rq,
          coalesce(sum(duration_ms),0) dur, coalesce(sum(success),0) ok, coalesce(sum(failed),0) failed, coalesce(sum(unknown),0) unknown, count(*) n
        from daily_rollups where company_id = ${co.companyId} and day = ${day}::date`).then((r) => r[0]!);
    const rawSums = (day: string) =>
      rows<{ turns: string; runs: string; i: string; o: string; cr: string; cw: string; rq: string; dur: string }>(sql`
        select (select count(*) from turns where company_id = ${co.companyId} and (started_at at time zone 'UTC')::date = ${day}::date) turns,
          (select count(*) from runs r join turns t on t.id = r.turn_id where t.company_id = ${co.companyId} and (t.started_at at time zone 'UTC')::date = ${day}::date) runs,
          coalesce(sum(u.input_tokens),0) i, coalesce(sum(u.output_tokens),0) o, coalesce(sum(u.cache_read_tokens),0) cr,
          coalesce(sum(u.cache_write_tokens),0) cw, coalesce(sum(u.requests),0) rq,
          (select coalesce(sum(duration_ms),0) from turns where company_id = ${co.companyId} and (started_at at time zone 'UTC')::date = ${day}::date) dur
        from usage u join turns t on t.id = u.turn_id where t.company_id = ${co.companyId} and (t.started_at at time zone 'UTC')::date = ${day}::date`).then((r) => r[0]!);

    it('cold start folds every day and the rollups equal the raw sums', async (ctx) => {
      if (skip) return ctx.skip();
      const c = makeCtx();
      const s = await runRollups(c);
      expect(s.full).toBe(true);
      expect(s.days).toBe(2);
      for (const day of ['2026-10-05', '2026-09-20']) {
        const r = await rollupSums(day);
        const raw = await rawSums(day);
        expect({ turns: r.turns, runs: r.runs, i: r.i, o: r.o, cr: r.cr, cw: r.cw, rq: r.rq, dur: r.dur }).toEqual(raw);
      }
      const day = await rollupSums('2026-10-05');
      expect(Number(day.turns)).toBe(3);
      expect(Number(day.runs)).toBe(1);
      expect(Number(day.ok)).toBe(1);
      expect(Number(day.failed)).toBe(1);
      expect(Number(day.unknown)).toBe(1);
      // mixed-model turn r1: haiku tokens land in a usage-only row (turns = 0) and opus/high carries both opus turns
      const haiku = await rows<{ turns: number; input_tokens: string; user_id: string | null }>(sql`
        select turns, input_tokens, user_id from daily_rollups where company_id = ${co.companyId} and day = '2026-10-05' and model = ${HAIKU}`);
      expect(haiku).toEqual([{ turns: 0, input_tokens: '50', user_id: co.carol }]);
      const unverified = await rows(sql`select 1 from daily_rollups where company_id = ${co.companyId} and day = '2026-10-05' and user_id is null`);
      expect(unverified).toHaveLength(1);
      expect(c.state.get('rollups.watermark')).toBe(NOW.toISOString());
    });

    it('splits tokens by outcome: wasted = failed / abandoned turns, unknown separately (ADR-0017)', async (ctx) => {
      if (skip) return ctx.skip();
      await runRollups(makeCtx());
      const [r] = await rows<{ w: string; u: string; split: boolean }>(sql`
        select coalesce(sum(wasted_input_tokens), 0) w, coalesce(sum(unknown_input_tokens), 0) u, bool_and(outcome_split) split
        from daily_rollups where company_id = ${co.companyId} and day = '2026-10-05'`);
      expect(r).toEqual({ w: '400', u: '10', split: true }); // r2 failed (400 input), r3 unknown (10 input)
    });

    it('is idempotent: a second pass leaves identical rows', async (ctx) => {
      if (skip) return ctx.skip();
      const snapshot = () =>
        rows(sql`select day::text, team_id, user_id, project_id, harness, model, effort, turns, runs, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, requests, duration_ms, phases_ms, success, failed, abandoned, unknown
          from daily_rollups where company_id = ${co.companyId} order by 1, 2, 3, 4, 5, 6, 7, 8, 9`);
      const c = makeCtx();
      await runRollups(c);
      const first = await snapshot();
      await runRollups(c); // watermark set: incremental pass
      await runRollups(makeCtx()); // fresh state: cold start again
      expect(await snapshot()).toEqual(first);
      expect(first.length).toBeGreaterThan(0);
    });

    it('picks up a late turn for an old day through the watermark, without a cold start', async (ctx) => {
      if (skip) return ctx.skip();
      const c = makeCtx();
      await runRollups(c);
      await addTurn(owner, co.companyId, { key: 'late', at: '2026-09-20T15:00:00Z', stamp: AFTER_NOW, user: co.dave, team: co.teamB, usage: [[HAIKU, null, 5, 5, 0, 0]] });
      const s = await runRollups(c);
      expect(s.full).toBe(false);
      expect(s.days).toBe(2); // today (always) and 2026-09-20 (changed); yesterday has no raw turns
      const r = await rollupSums('2026-09-20');
      expect(Number(r.turns)).toBe(2);
      expect(Number(r.i)).toBe(705);
      expect(r).toMatchObject(await rawSums('2026-09-20').then((x) => ({ i: x.i, o: x.o })));
    });

    it('picks up an old turn changed after the watermark through updated_at alone (e.g. a late outcome patch)', async (ctx) => {
      if (skip) return ctx.skip();
      const c = makeCtx();
      await runRollups(c);
      expect(Number((await rollupSums('2026-09-20')).failed)).toBe(0);
      // created_at stays old: only updated_at moves, as when ingest applies a patch to an existing turn.
      await rows(sql`update turns set outcome = 'failed', updated_at = ${AFTER_NOW}::timestamptz
        where company_id = ${co.companyId} and external_id = 't-r4'`);
      const s = await runRollups(c);
      expect(s.full).toBe(false);
      expect(Number((await rollupSums('2026-09-20')).failed)).toBe(1);
    });

    it('leaves days outside the retention window and days without raw rows alone', async (ctx) => {
      if (skip) return ctx.skip();
      // a rollup for a day whose raw rows are gone must survive a pass
      await owner.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        await tx.execute(sql`insert into daily_rollups (company_id, day, harness, model, turns, input_tokens) values (${co.companyId}, '2024-01-01', 'claude-code', ${OPUS}, 7, 1234)`);
      });
      await runRollups(makeCtx());
      const kept = await rows<{ turns: number }>(sql`select turns from daily_rollups where company_id = ${co.companyId} and day = '2024-01-01'`);
      expect(kept).toEqual([{ turns: 7 }]);
    });

    it('keeps the anonymised rollup rows of a deleted user when the day is recomputed (ADR-0012)', async (ctx) => {
      if (skip) return ctx.skip();
      const x = await seedCompany(owner, { slug: 'anon', retentionDays: 90 });
      const day = '2026-10-05';
      await addTurn(owner, x.companyId, { key: 'an-c', at: `${day}T08:00:00Z`, user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 1000, 0, 0, 0]] });
      await addTurn(owner, x.companyId, { key: 'an-b', at: `${day}T09:00:00Z`, user: x.bob, team: x.teamA, usage: [[OPUS, 'high', 500, 0, 0, 0]] });
      await addTurn(owner, x.companyId, { key: 'an-u', at: `${day}T09:30:00Z`, user: null, team: x.teamA, usage: [[OPUS, 'high', 20, 0, 0, 0]] });
      const sums = () =>
        rows<{ turns: number; i: number; ok: number; failed: number; anon: number }>(sql`
          select sum(turns)::int turns, sum(input_tokens)::int i, sum(success)::int ok, sum(failed)::int failed,
            coalesce(sum(input_tokens) filter (where user_id is null), 0)::int anon
          from daily_rollups where company_id = ${x.companyId} and day = ${day}::date`).then((r) => r[0]!);
      const c = makeCtx();
      await runRollups(c);
      expect(await sums()).toEqual({ turns: 3, i: 1520, ok: 3, failed: 0, anon: 20 });

      // Delete carol: her raw rows go (cascade), her rollup rows stay with user_id = null.
      await ownerTx(owner, (tx) => tx.execute(sql`delete from users where id = ${x.carol}`));
      expect(await rows(sql`select 1 from turns where company_id = ${x.companyId} and user_id = ${x.carol}`)).toHaveLength(0);
      // The unverified turn changes afterwards, so the slice is rebuilt (and must still be rebuilt correctly).
      await rows(sql`update turns set outcome = 'failed', updated_at = ${AFTER_NOW}::timestamptz where company_id = ${x.companyId} and external_id = 't-an-u'`);
      await runRollups(c); // incremental: today is always recomputed
      await runRollups(makeCtx()); // cold start
      expect(await sums()).toEqual({ turns: 3, i: 1520, ok: 2, failed: 1, anon: 1020 });

      // New turns of the day are still folded in, next to the kept anonymised rows.
      await addTurn(owner, x.companyId, { key: 'an-b2', at: `${day}T10:00:00Z`, stamp: AFTER_NOW, user: x.bob, team: x.teamA, usage: [[OPUS, 'high', 7, 0, 0, 0]] });
      await runRollups(c);
      expect(await sums()).toEqual({ turns: 4, i: 1527, ok: 3, failed: 1, anon: 1020 });
      // A team budget reading these rollups still sees carol's usage (raw and rollups agree on the team total).
      const team = await monthToDate(makeCtx({ now: new Date('2026-10-07T12:00:00Z') }), { companyId: x.companyId, teamId: x.teamA, userId: null }, '2026-10-01', '2026-10-06');
      expect(team.reduce((a, r) => a + r.input, 0)).toBe(1527);
    });

    it('folds skill and MCP use (turn + runs) into daily_skill_mcp_rollups and keeps a deleted user\'s rows', async (ctx) => {
      if (skip) return ctx.skip();
      const x = await seedCompany(owner, { slug: 'skills', retentionDays: 90 });
      const day = '2026-10-05';
      await addTurn(owner, x.companyId, {
        key: 'sk-c', at: `${day}T08:00:00Z`, user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 10, 0, 0, 0], [HAIKU, null, 1, 0, 0, 0]],
        skills: { 'code-review': { model: 1, user: 1 } }, mcp: { github: { search_code: 2 } }, runMcp: { github: { search_code: 1, get_file: 1 } },
        mcpStats: { github: { search_code: { errors: 1, denied: 0, ms: 6000, buckets: [1, 0, 1, 0, 0] } } },
      });
      await addTurn(owner, x.companyId, { key: 'sk-b', at: `${day}T09:00:00Z`, user: x.bob, team: x.teamA, usage: [[OPUS, 'high', 10, 0, 0, 0]], skills: { 'code-review': { model: 0, user: 1 } } });
      await addTurn(owner, x.companyId, { key: 'sk-none', at: `${day}T10:00:00Z`, user: x.bob, team: x.teamA, usage: [[OPUS, 'high', 10, 0, 0, 0]] });
      const totals = () =>
        rows<{ kind: string; name: string; tool: string; calls: number; model_calls: number; user_calls: number; turns: number; users: number }>(sql`
          select kind, name, tool, sum(calls)::int calls, sum(model_calls)::int model_calls, sum(user_calls)::int user_calls,
            sum(turns)::int turns, count(distinct user_id)::int users
          from daily_skill_mcp_rollups where company_id = ${x.companyId} and day = ${day}::date group by 1, 2, 3 order by 1, 2, 3`);
      const c = makeCtx();
      await runRollups(c);
      const expected = [
        { kind: 'mcp', name: 'github', tool: '', calls: 4, model_calls: 4, user_calls: 0, turns: 1, users: 1 },
        { kind: 'mcp', name: 'github', tool: 'get_file', calls: 1, model_calls: 1, user_calls: 0, turns: 1, users: 1 },
        { kind: 'mcp', name: 'github', tool: 'search_code', calls: 3, model_calls: 3, user_calls: 0, turns: 1, users: 1 },
        { kind: 'skill', name: 'code-review', tool: '', calls: 3, model_calls: 1, user_calls: 2, turns: 2, users: 2 },
      ];
      expect(await totals()).toEqual(expected);
      const [oc] = await rows<{ success: number; failed: number; split: boolean }>(sql`
        select sum(success)::int success, sum(failed)::int failed, bool_and(outcome_split) split from daily_skill_mcp_rollups
        where company_id = ${x.companyId} and kind = 'skill' and name = 'code-review'`);
      expect(oc).toEqual({ success: 2, failed: 0, split: true }); // both code-review turns succeeded (fixture default)
      const rel = await rows(sql`select tool, errors::int, latency_ms::int, lat0::int, lat2::int from daily_skill_mcp_rollups
        where company_id = ${x.companyId} and kind = 'mcp' and name = 'github' order by tool`);
      expect(rel).toEqual([
        { tool: '', errors: 1, latency_ms: 6000, lat0: 1, lat2: 1 },
        { tool: 'get_file', errors: 0, latency_ms: 0, lat0: 0, lat2: 0 },
        { tool: 'search_code', errors: 1, latency_ms: 6000, lat0: 1, lat2: 1 },
      ]);
      await runRollups(makeCtx()); // idempotent
      expect(await totals()).toEqual(expected);

      // Deleting carol keeps her (now anonymised) rows through a rebuild of the slice.
      await ownerTx(owner, (tx) => tx.execute(sql`delete from users where id = ${x.carol}`));
      await rows(sql`update turns set outcome = 'failed', updated_at = ${AFTER_NOW}::timestamptz where company_id = ${x.companyId} and external_id = 't-sk-b'`);
      await runRollups(c);
      expect((await totals()).map(({ users: _u, ...r }) => r)).toEqual(expected.map(({ users: _u, ...r }) => r));
    });

    it('a failed slice makes the pass fail, keeps the watermark and never throws out of the scheduler contract', async (ctx) => {
      if (skip) return ctx.skip();
      const broken = makeCtx();
      broken.db = { ...worker, execute: () => Promise.reject(new Error('db down')) } as unknown as Database;
      await expect(runRollups(broken)).rejects.toThrow('db down');
      expect(broken.state.get('rollups.watermark')).toBeUndefined();
    });
  });

  describe('retention', () => {
    let sessionKeepId: string;
    beforeAll(async () => {
      if (skip) return;
      co = await seedCompany(owner, { slug: 'retention', retentionDays: 30 });
      const a = co.teamA;
      // cutoff for 30 days at NOW = 2026-09-05T00:00Z
      await addTurn(owner, co.companyId, { key: 'old1', at: '2026-09-04T23:00:00Z', user: co.carol, team: a, usage: [[OPUS, 'high', 100, 10, 0, 0], [HAIKU, null, 5, 5, 0, 0]] });
      await addTurn(owner, co.companyId, { key: 'old2', at: '2026-07-01T10:00:00Z', user: co.carol, team: a, usage: [[OPUS, 'high', 200, 20, 0, 0]] });
      await addTurn(owner, co.companyId, { key: 'keep1', at: '2026-09-05T01:00:00Z', user: co.carol, team: a, usage: [[OPUS, 'high', 300, 30, 0, 0]] });
      // long-running session: its first turn is expired but it still holds a newer turn -> the session must survive
      await addTurn(owner, co.companyId, { key: 'long-old', at: '2026-08-01T10:00:00Z', user: co.bob, team: a, session: 'long', usage: [[OPUS, 'high', 1, 1, 0, 0]] });
      await addTurn(owner, co.companyId, { key: 'long-new', at: '2026-10-01T10:00:00Z', user: co.bob, team: a, session: 'long', usage: [[OPUS, 'high', 2, 2, 0, 0]] });
      await addNoise(owner, co.companyId, co.carol, NOW.toISOString());
      sessionKeepId = (await rows<{ id: string }>(sql`select id from agent_sessions where company_id = ${co.companyId} and external_id = 'long'`))[0]!.id;
    });

    const counts = () =>
      rows<{ turns: string; runs: string; usage: string; sessions: string }>(sql`
        select (select count(*) from turns where company_id = ${co.companyId}) turns, (select count(*) from runs where company_id = ${co.companyId}) runs,
          (select count(*) from usage where company_id = ${co.companyId}) usage, (select count(*) from agent_sessions where company_id = ${co.companyId}) sessions`).then((r) => r[0]!);

    it('deletes expired turns/runs/usage/sessions, folds them into rollups first, and keeps the rest', async (ctx) => {
      if (skip) return ctx.skip();
      expect(await counts()).toEqual({ turns: '5', runs: '1', usage: '6', sessions: '4' });
      const c = makeCtx();
      const s = await runRetention(c, { force: true });
      expect(s).toMatchObject({ turns: 3, runs: 1, usage: 4, sessions: 2, ingestEvents: 1, pendingPatches: 1, magicLinks: 1, authSessions: 1 });
      expect(await counts()).toEqual({ turns: '2', runs: '0', usage: '2', sessions: '2' });
      const left = await rows<{ external_id: string }>(sql`select external_id from turns where company_id = ${co.companyId} order by 1`);
      expect(left.map((r) => r.external_id)).toEqual(['t-keep1', 't-long-new']);
      // the session that still holds newer turns survived
      expect(await rows(sql`select 1 from agent_sessions where id = ${sessionKeepId}`)).toHaveLength(1);
      // expired days were folded into the permanent rollups before the raw rows went away
      const rolled = await rows<{ day: string; turns: string; i: string }>(sql`
        select day::text, sum(turns)::text turns, sum(input_tokens)::text i from daily_rollups where company_id = ${co.companyId} and day in ('2026-09-04','2026-07-01') group by 1 order by 1`);
      expect(rolled).toEqual([{ day: '2026-07-01', turns: '1', i: '200' }, { day: '2026-09-04', turns: '1', i: '105' }]);
      // global pruning kept the fresh rows
      expect(await rows(sql`select event_id from ingest_events where company_id = ${co.companyId}`)).toEqual([{ event_id: 'new' }]);
      // parked patches whose turn never came are dropped after 30 days (ADR-0015), even if the company stopped ingesting
      expect(await rows(sql`select turn_external_id from pending_turn_patches where company_id = ${co.companyId}`)).toEqual([{ turn_external_id: 'claude-code:soon' }]);
      expect(await rows(sql`select token_hash from magic_links`)).toEqual([{ token_hash: 'h2' }]);
      expect(await rows(sql`select token_hash from auth_sessions`)).toEqual([{ token_hash: 's2' }]);
      expect(c.state.get('retention.lastDay')).toBe('2026-10-05');
    });

    it('is idempotent and does not shrink rollups when run again', async (ctx) => {
      if (skip) return ctx.skip();
      const s = await runRetention(makeCtx(), { force: true });
      expect(s).toMatchObject({ turns: 0, runs: 0, usage: 0, sessions: 0, ingestEvents: 0, pendingPatches: 0 });
      const rolled = await rows(sql`select sum(turns)::text t from daily_rollups where company_id = ${co.companyId} and day = '2026-09-04'`);
      expect(rolled).toEqual([{ t: '1' }]);
    });

    it('runs once per UTC day unless forced', async (ctx) => {
      if (skip) return ctx.skip();
      const c = makeCtx();
      expect((await runRetention(c)).skipped).toBeUndefined(); // 12:00 UTC, after the default hour 3
      expect((await runRetention(c)).skipped).toBe(true);
      expect((await runRetention(c, { force: true })).skipped).toBeUndefined();
      const early = makeCtx({ now: new Date('2026-10-06T01:00:00Z') });
      early.state.set('retention.lastDay', '2026-10-05');
      expect((await runRetention(early)).skipped).toBe(true);
    });

    it('adds turns that arrive after their day expired to the rollup instead of losing or overwriting it', async (ctx) => {
      if (skip) return ctx.skip();
      const x = await seedCompany(owner, { slug: 'late-turns', retentionDays: 30 });
      // 08-10: 1 turn / 1000 input (a late turn would overwrite it); 08-11: 2 turns / 3000 (a late turn would be lost)
      await addTurn(owner, x.companyId, { key: 'o1', at: '2026-08-10T10:00:00Z', user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 1000, 0, 0, 0]] });
      await addTurn(owner, x.companyId, { key: 'o2', at: '2026-08-11T10:00:00Z', user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 1000, 0, 0, 0]] });
      await addTurn(owner, x.companyId, { key: 'o3', at: '2026-08-11T11:00:00Z', user: x.dave, team: x.teamB, usage: [[OPUS, 'high', 2000, 0, 0, 0]] });
      // rolled up while the days were inside the window, then expired
      await recomputeDay(worker, x.companyId, '2026-08-10');
      await recomputeDay(worker, x.companyId, '2026-08-11');
      await runRetention(makeCtx(), { force: true });
      expect(await rows(sql`select 1 from turns where company_id = ${x.companyId}`)).toHaveLength(0);
      const rolled = () =>
        rows<{ day: string; turns: number; i: number }>(sql`select day::text, sum(turns)::int turns, sum(input_tokens)::int i
          from daily_rollups where company_id = ${x.companyId} group by 1 order by 1`);
      expect(await rolled()).toEqual([{ day: '2026-08-10', turns: 1, i: 1000 }, { day: '2026-08-11', turns: 2, i: 3000 }]);

      // An offline queue delivers turns for those expired days later (created after the rollups were written).
      const later = new Date(Date.now() + 60_000).toISOString();
      await addTurn(owner, x.companyId, { key: 'l1', at: '2026-08-10T12:00:00Z', stamp: later, user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 77, 0, 0, 0]] });
      await addTurn(owner, x.companyId, { key: 'l2', at: '2026-08-11T12:00:00Z', stamp: later, user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 77, 0, 0, 0]] });
      await runRollups(makeCtx()); // outside the window: the rollups job leaves them alone
      expect(await rolled()).toEqual([{ day: '2026-08-10', turns: 1, i: 1000 }, { day: '2026-08-11', turns: 2, i: 3000 }]);
      const s = await runRetention(makeCtx(), { force: true });
      expect(s.turns).toBeGreaterThanOrEqual(2);
      expect(await rows(sql`select 1 from turns where company_id = ${x.companyId}`)).toHaveLength(0);
      expect(await rolled()).toEqual([{ day: '2026-08-10', turns: 2, i: 1077 }, { day: '2026-08-11', turns: 3, i: 3077 }]);
      // and nothing is added twice
      await runRetention(makeCtx(), { force: true });
      expect(await rolled()).toEqual([{ day: '2026-08-10', turns: 2, i: 1077 }, { day: '2026-08-11', turns: 3, i: 3077 }]);
    });

    it('never rebuilds a rollup from partly deleted raw rows, even when the day is recomputed directly', async (ctx) => {
      if (skip) return ctx.skip();
      const x = await seedCompany(owner, { slug: 'partial', retentionDays: 90 });
      await addTurn(owner, x.companyId, { key: 'p1', at: '2026-09-01T10:00:00Z', user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 100, 0, 0, 0]] });
      await addTurn(owner, x.companyId, { key: 'p2', at: '2026-09-01T11:00:00Z', user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 200, 0, 0, 0]] });
      expect(await recomputeDay(worker, x.companyId, '2026-09-01')).toEqual({ turns: 2, rows: 1 });
      // an interrupted retention pass (or a window that was widened again) left one of the two raw turns
      await ownerTx(owner, (tx) => tx.execute(sql`delete from turns where company_id = ${x.companyId} and external_id = 't-p1'`));
      expect(await recomputeDay(worker, x.companyId, '2026-09-01')).toBeNull();
      const [r] = await rows<{ turns: number; i: number }>(sql`select sum(turns)::int turns, sum(input_tokens)::int i from daily_rollups where company_id = ${x.companyId}`);
      expect(r).toEqual({ turns: 2, i: 300 });
    });

    it('honours each company\'s own window and the plan maximum (free plan = 30 days max)', async (ctx) => {
      if (skip) return ctx.skip();
      const free = await seedCompany(owner, { slug: 'free-co', plan: 'free', retentionDays: 90 });
      await addTurn(owner, free.companyId, { key: 'f-old', at: '2026-08-20T10:00:00Z', user: free.carol, team: free.teamA, usage: [[OPUS, 'high', 1, 1, 0, 0]] });
      const pro = await seedCompany(owner, { slug: 'pro-co', plan: 'team', retentionDays: 90 });
      await addTurn(owner, pro.companyId, { key: 'p-old', at: '2026-08-20T10:00:00Z', user: pro.carol, team: pro.teamA, usage: [[OPUS, 'high', 1, 1, 0, 0]] });
      await runRetention(makeCtx(), { force: true });
      expect(await rows(sql`select 1 from turns where company_id = ${free.companyId}`)).toHaveLength(0);
      expect(await rows(sql`select 1 from turns where company_id = ${pro.companyId}`)).toHaveLength(1);
    });
  });

  describe('runaways', () => {
    /** 50 ordinary turns of `user` over the 25 days before NOW (1000 tokens each), stamped long ago (not candidates). */
    async function history(x: Seeded, user: string, team: string) {
      for (let i = 0; i < 50; i++) {
        const at = new Date(NOW.getTime() - (2 + i * 0.5) * 86_400_000).toISOString();
        await addTurn(owner, x.companyId, { key: `h-${user}-${i}`, at, stamp: '2026-09-01T00:00:00Z', user, team, usage: [[OPUS, 'high', 1000, 0, 0, 0]] });
      }
    }
    const alerts = (companyId: string) =>
      rows<{ external_id: string; reasons: string[]; notified: boolean }>(sql`
        select t.external_id, a.reasons, a.notified_at is not null as notified from runaway_alerts a join turns t on t.id = a.turn_id
        where a.company_id = ${companyId} order by t.external_id`);

    it('flags tokens far above the user\'s normal and turns over the cost threshold, once per turn', async (ctx) => {
      if (skip) return ctx.skip();
      const x = await seedCompany(owner, { slug: 'run-agg', retentionDays: 90 });
      await history(x, x.carol, x.teamA);
      await addTurn(owner, x.companyId, { key: 'carol-big', at: '2026-10-05T10:00:00Z', user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 10_000, 0, 0, 0]] });
      await addTurn(owner, x.companyId, { key: 'carol-ok', at: '2026-10-05T10:30:00Z', user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 1200, 0, 0, 0]] });
      await addTurn(owner, x.companyId, { key: 'dave-huge', at: '2026-10-05T11:00:00Z', user: x.dave, team: x.teamB, usage: [[OPUS, 'high', 30_000_000, 0, 0, 0]] });
      expect(await detectRunaways(makeCtx())).toBe(2);
      expect(await alerts(x.companyId)).toEqual([
        { external_id: 't-carol-big', reasons: ['tokens'], notified: false },
        { external_id: 't-dave-huge', reasons: ['tokens', 'cost'], notified: false }, // 30 M input × $4 / Mtok = $120
      ]);
      expect(await detectRunaways(makeCtx())).toBe(0); // one alert per turn
    });

    it('aggregates-only: each user gets their own turns, admins an anonymous digest; at most one digest per hour', async (ctx) => {
      if (skip) return ctx.skip();
      const [co] = await rows<{ id: string }>(sql`select id from companies where slug = 'run-agg'`);
      const mails: MailMessage[] = [];
      expect(await sendRunawayDigests(makeCtx({ mails }))).toEqual({ sent: 3, failed: 0 });
      const to = (who: string) => mails.filter((m) => m.to === `${who}@run-agg.test`);
      expect(to('carol')).toHaveLength(1);
      expect(to('carol')[0]!.text).toContain('/turns/');
      expect(to('dave')).toHaveLength(1);
      expect(to('bob')).toHaveLength(0); // leads are not mailed in aggregates-only mode
      const admin = to('alice')[0]!;
      expect(admin.subject).toContain('2 runaway turns');
      expect(admin.text).not.toMatch(/carol|dave|\/turns\//);
      expect((await alerts(co!.id)).every((a) => a.notified)).toBe(true);

      // a new runaway within the hour waits for the next digest
      await addTurn(owner, co!.id, { key: 'dave-huge-2', at: '2026-10-05T11:30:00Z', stamp: AFTER_NOW, user: (await rows<{ id: string }>(sql`select id from users where email = 'dave@run-agg.test'`))[0]!.id, team: (await rows<{ id: string }>(sql`select id from teams where company_id = ${co!.id} and name = 'B'`))[0]!.id, usage: [[OPUS, 'high', 25_000_000, 0, 0, 0]] });
      expect(await detectRunaways(makeCtx())).toBe(1);
      const later: MailMessage[] = [];
      expect(await sendRunawayDigests(makeCtx({ mails: later }))).toEqual({ sent: 0, failed: 0 });
      expect(await sendRunawayDigests(makeCtx({ mails: later, now: new Date(NOW.getTime() + 61 * 60_000) }))).toEqual({ sent: 2, failed: 0 });
      expect(later.map((m) => m.to).sort()).toEqual(['alice@run-agg.test', 'dave@run-agg.test']);
    });

    it('full mode: the user and the leads of the turn\'s team (named); a failed send is retried', async (ctx) => {
      if (skip) return ctx.skip();
      const x = await seedCompany(owner, { slug: 'run-full', retentionDays: 90, visibility: 'full' });
      await addTurn(owner, x.companyId, { key: 'carol-huge', at: '2026-10-05T10:00:00Z', user: x.carol, team: x.teamA, usage: [[OPUS, 'high', 30_000_000, 0, 0, 0]] });
      expect(await detectRunaways(makeCtx())).toBe(1);
      expect(await sendRunawayDigests(makeCtx({ failMail: true }))).toEqual({ sent: 0, failed: 1 });
      expect((await alerts(x.companyId))[0]!.notified).toBe(false); // released
      const mails: MailMessage[] = [];
      expect(await sendRunawayDigests(makeCtx({ mails }))).toEqual({ sent: 2, failed: 0 });
      expect(mails.map((m) => m.to).sort()).toEqual(['bob@run-full.test', 'carol@run-full.test']);
      expect(mails.find((m) => m.to === 'bob@run-full.test')!.text).toContain('carol');
    });
  });

  describe('budgets', () => {
    it('mails once at 80 % and once at 100 %, resets next month, and retries after a failed send', async (ctx) => {
      if (skip) return ctx.skip();
      co = await seedCompany(owner, { slug: 'budgets', retentionDays: 90 });
      const budgetId = await addBudget(owner, co.companyId, { teamId: co.teamA, kind: 'cost', limit: 100 });
      await addBudget(owner, co.companyId, { teamId: co.teamB, kind: 'tokens', limit: 1_000_000 });
      // team A: Oct 2 (via rollups) 10M input @ $4 = $40 ; Oct 5 (raw, today) 10M input = $40  => $80 = 80 %
      await addTurn(owner, co.companyId, { key: 'b1', at: '2026-10-02T09:00:00Z', user: co.carol, team: co.teamA, usage: [[OPUS, 'high', 10_000_000, 0, 0, 0]] });
      await addTurn(owner, co.companyId, { key: 'b2', at: '2026-10-05T09:00:00Z', stamp: AFTER_NOW, user: co.carol, team: co.teamA, usage: [[OPUS, 'high', 10_000_000, 0, 0, 0]] });
      // team B: 500k tokens = 50 %, and a September turn that must not count
      await addTurn(owner, co.companyId, { key: 'b3', at: '2026-10-05T08:00:00Z', stamp: AFTER_NOW, user: co.dave, team: co.teamB, usage: [[OPUS, 'high', 300_000, 200_000, 0, 0]] });
      await addTurn(owner, co.companyId, { key: 'b4', at: '2026-09-30T08:00:00Z', user: co.dave, team: co.teamB, usage: [[OPUS, 'high', 900_000, 0, 0, 0]] });
      await runRollups(makeCtx());

      const mails: MailMessage[] = [];
      const c = makeCtx({ mails });
      expect(await runBudgets(c)).toEqual({ budgets: 2, sent: 1, failed: 0 });
      // recipients: company admin alice + team A lead bob, individually, de-duplicated
      expect(mails.map((m) => m.to).sort()).toEqual(['alice@budgets.test', 'bob@budgets.test']);
      expect(mails[0]!.subject).toContain('Budget at 80 %');
      expect(mails[0]!.text).toContain('$80.00 of $100.00');
      expect(mails[0]!.text).toContain('https://obs.test/overview');
      const marks = () => rows<{ p: string; n80: boolean; n100: boolean }>(sql`select notified_period::text p, notified_80_at is not null n80, notified_100_at is not null n100 from budgets where id = ${budgetId}`).then((r) => r[0]!);
      expect(await marks()).toEqual({ p: '2026-10-01', n80: true, n100: false });

      // exactly once: more passes send nothing
      expect(await runBudgets(c)).toMatchObject({ sent: 0 });
      expect(mails).toHaveLength(2);

      // cross 100 %
      await addTurn(owner, co.companyId, { key: 'b5', at: '2026-10-05T10:00:00Z', stamp: AFTER_NOW, user: co.carol, team: co.teamA, usage: [[OPUS, 'high', 5_000_000, 0, 0, 0]] });
      mails.length = 0;
      expect(await runBudgets(c)).toMatchObject({ sent: 1 });
      expect(mails[0]!.subject).toContain('Budget reached');
      expect(await marks()).toEqual({ p: '2026-10-01', n80: true, n100: true });
      expect(await runBudgets(c)).toMatchObject({ sent: 0 });

      // next month: marks reset, usage is zero so nothing is sent
      mails.length = 0;
      const nov = makeCtx({ mails, now: new Date('2026-11-02T12:00:00Z') });
      expect(await runBudgets(nov)).toMatchObject({ sent: 0 });
      expect(await marks()).toEqual({ p: '2026-11-01', n80: false, n100: false });

      // SMTP failure: the claim is released so the next pass retries
      await addTurn(owner, co.companyId, { key: 'b6', at: '2026-11-02T09:00:00Z', stamp: '2026-11-02T12:01:00Z', user: co.carol, team: co.teamA, usage: [[OPUS, 'high', 30_000_000, 0, 0, 0]] });
      const failing = makeCtx({ now: new Date('2026-11-02T12:00:00Z'), failMail: true });
      expect(await runBudgets(failing)).toMatchObject({ sent: 0, failed: 1 });
      expect(await marks()).toEqual({ p: '2026-11-01', n80: false, n100: false });
      expect(await runBudgets(nov)).toMatchObject({ sent: 1 }); // $120 of $100 -> only the 100 % mail
      expect(mails[0]!.subject).toContain('Budget reached');
      expect(await marks()).toEqual({ p: '2026-11-01', n80: true, n100: true });
    });

    it('skips plans without budgets and suspended companies, and mails the user for a user budget', async (ctx) => {
      if (skip) return ctx.skip();
      const free = await seedCompany(owner, { slug: 'free-budgets', plan: 'free' });
      await addBudget(owner, free.companyId, { teamId: free.teamA, kind: 'tokens', limit: 10 });
      await addTurn(owner, free.companyId, { key: 'fb', at: '2026-10-05T09:00:00Z', stamp: AFTER_NOW, user: free.carol, team: free.teamA, usage: [[OPUS, 'high', 100, 0, 0, 0]] });
      const solo = await seedCompany(owner, { slug: 'user-budget', plan: 'business' });
      await addBudget(owner, solo.companyId, { userId: solo.carol, kind: 'tokens', limit: 1000 });
      await addTurn(owner, solo.companyId, { key: 'ub', at: '2026-10-05T09:00:00Z', stamp: AFTER_NOW, user: solo.carol, team: solo.teamA, usage: [[OPUS, 'high', 900, 0, 0, 0]] });
      // another user's usage in the same team must not count for carol
      await addTurn(owner, solo.companyId, { key: 'ub2', at: '2026-10-05T09:30:00Z', stamp: AFTER_NOW, user: solo.bob, team: solo.teamA, usage: [[OPUS, 'high', 5000, 0, 0, 0]] });
      const mails: MailMessage[] = [];
      await runBudgets(makeCtx({ mails }));
      expect(mails.map((m) => m.to).filter((t) => t.endsWith('@free-budgets.test'))).toEqual([]);
      // user budget in aggregates-only mode (default): only carol herself, never the admins (ADR-0008)
      expect(mails.map((m) => m.to).filter((t) => t.endsWith('@user-budget.test')).sort()).toEqual(['carol@user-budget.test']);
    });

    it('sends user-budget mails with a person\'s usage to admins and leads only in full visibility mode', async (ctx) => {
      if (skip) return ctx.skip();
      const mk = async (slug: string, visibility: 'aggregates-only' | 'full') => {
        const x = await seedCompany(owner, { slug, plan: 'team', visibility });
        // a tiny user budget for dave, scoped to his team as well, and his usage
        await addBudget(owner, x.companyId, { userId: x.dave, teamId: x.teamB, kind: 'cost', limit: 0.01 });
        await ownerTx(owner, (tx) => tx.execute(sql`insert into team_memberships (company_id, team_id, user_id, role) values (${x.companyId}, ${x.teamB}, ${x.bob}, 'lead')`));
        await addTurn(owner, x.companyId, { key: `${slug}-d`, at: '2026-10-05T09:00:00Z', stamp: AFTER_NOW, user: x.dave, team: x.teamB, usage: [[OPUS, 'high', 1_000_000, 0, 0, 0]] });
      };
      await mk('vis-agg', 'aggregates-only');
      await mk('vis-full', 'full');
      const mails: MailMessage[] = [];
      await runBudgets(makeCtx({ mails }));
      const to = (domain: string) => mails.filter((m) => m.to.endsWith(domain));
      expect(to('@vis-agg.test').map((m) => m.to)).toEqual(['dave@vis-agg.test']);
      expect(to('@vis-agg.test')[0]!.text).toContain('$4.00');
      expect(to('@vis-full.test').map((m) => m.to).sort()).toEqual(['alice@vis-full.test', 'bob@vis-full.test', 'dave@vis-full.test']);
    });

    it('counts only this month up to now + 1 day: future-dated turns (clock skew, bad clients) do not count', async (ctx) => {
      if (skip) return ctx.skip();
      const x = await seedCompany(owner, { slug: 'future', plan: 'team' });
      const at = (key: string, iso: string, input: number) =>
        addTurn(owner, x.companyId, { key, at: iso, user: x.carol, team: x.teamA, usage: [[OPUS, 'high', input, 0, 0, 0]] });
      await at('f1', '2026-10-05T09:00:00Z', 100);
      await at('f2', '2026-10-06T06:00:00Z', 10); // 18 h ahead of NOW: tolerated skew
      await at('f3', '2026-10-09T09:00:00Z', 1000); // days ahead
      await at('f4', '2026-11-02T09:00:00Z', 10_000); // next month
      await at('f5', '2099-01-01T00:00:00Z', 123_456);
      await at('f6', '2026-10-31T23:30:00Z', 1);
      await at('f7', '2026-11-01T00:10:00Z', 100_000); // next month, though within the skew allowance at month end
      const scope = { companyId: x.companyId, teamId: x.teamA, userId: null };
      const sum = (u: Array<{ input: number }>) => u.reduce((a, r) => a + r.input, 0);
      expect(sum(await monthToDate(makeCtx(), scope, '2026-10-01', '2026-10-04'))).toBe(110);
      expect(sum(await monthToDate(makeCtx({ now: new Date('2026-10-31T23:00:00Z') }), scope, '2026-10-01', '2026-10-30'))).toBe(1);
    });
  });
});
