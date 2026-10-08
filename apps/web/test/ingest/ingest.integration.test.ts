import { gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database, Tx } from '@ai-obs/db';
import { schemas, validateBatch, type IngestBatchInput, type IngestEventInput, type IngestResponse } from '@ai-obs/protocol';
import { handleCollectorConfig, handleIngest } from '../../src/lib/ingest/handler';
import { lookupToken } from '../../src/lib/ingest/context';
import { EVENTS_PER_SAVEPOINT, processBatch } from '../../src/lib/ingest/process-batch';
import { AuthGuard, TokenBucketLimiter } from '../../src/lib/ingest/rate-limit';
import { hashProjectKey } from '../../src/lib/ingest/resolve';
import { withIngestContext, withRlsContext } from '@ai-obs/db';
import { recomputeDay } from '../../../worker/src/jobs/rollups';
import { defaultFilters, type Filters } from '../../src/lib/filters';
import { getKpis } from '../../src/lib/queries/kpis';
import { createQueryContext, type Viewer } from '../../src/lib/queries/scope';
import { generateToken, hashToken } from '../../src/lib/ingest/tokens';
import { INT4_MAX, timeWindowProblem, MAX_TOKENS_PER_ENTRY } from '../../src/lib/ingest/limits';
import { connectIngest, connectOwner, connectRole, dropIngestTestDb, prepareIngestTestDb } from './db-harness';
import { batch, createWorld, ev, insertMember, insertToken, insertUser, protocolFixture, ulid, type World } from './fixtures';

const skip = await prepareIngestTestDb();

describe.skipIf(skip !== null)(`ingest API against Postgres${skip ? ` (skipped: ${skip})` : ''}`, () => {
  let db: Database;
  let owner: ReturnType<typeof connectOwner>;
  let w: World;
  const limiter = () => new TokenBucketLimiter({ burst: 1000, perMinute: 6000 });

  beforeAll(async () => {
    db = connectIngest();
    owner = connectOwner();
    w = await owner.run((tx) => createWorld(tx));
  });
  afterAll(async () => {
    await dropIngestTestDb();
  });

  const q = <T = Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    owner.run(async (tx: Tx) => [...(await tx.execute(query))] as T[]);

  async function post(token: string | null, body: IngestBatchInput | string | Buffer, headers: Record<string, string> = {}) {
    const res = await handleIngest(
      new Request('http://test/api/v1/ingest', {
        method: 'POST',
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
      }),
      { db, limiter: limiter() },
    );
    return { status: res.status, body: (await res.json()) as IngestResponse & { error?: string } };
  }

  describe('protocol fixture', () => {
    it('accepts a valid batch and stores the turn, run, patches and session', async () => {
      const res = await post(w.tokens.alice, protocolFixture());
      expect(res).toEqual({ status: 200, body: { accepted: 6, duplicates: 0, rejected: [] } });

      const [s] = await q(sql`select s.*, p.key from agent_sessions s join projects p on p.id = s.project_id
        where s.external_id = 'claude-code:sess-1'`);
      expect(s).toMatchObject({ key: 'github.com/acme/billing', harness_version: '2.1.0', end_reason: 'exit', user_id: w.users.alice });
      expect(s!.ended_at).not.toBeNull();

      const [t] = await q(sql`select *, input_tokens::int, output_tokens::int, cache_read_tokens::int,
        cache_write_tokens::int, reasoning_tokens::int, requests::int, duration_ms::int
        from turns where external_id = 'claude-code:turn-1'`);
      expect(t).toMatchObject({
        company_id: w.companyId,
        user_id: w.users.alice,
        attribution: 'verified',
        team_id: w.teams.mobile, // project mapping wins over alice's primary team (Platform)
        session_id: s!.id,
        project_id: w.projects.billing,
        model: 'claude-opus-5-5',
        input_tokens: 1500,
        output_tokens: 3520,
        cache_read_tokens: 52000,
        cache_write_tokens: 8000,
        reasoning_tokens: 900,
        requests: 16,
        duration_ms: 240000,
        files_touched: 4,
        outcome: 'failed',
        outcome_signals: ['next_prompt_correction'],
        outcome_provisional: false,
        summary: 'Added JWT refresh to auth middleware',
        skills: { 'code-review': { model: 1, user: 0 }, 'ship-check': { model: 0, user: 1 } },
        mcp: { github: { create_pull_request: 1, search_code: 3 } },
        mcp_stats: { github: { search_code: { errors: 1, denied: 0, ms: 1500, buckets: [3, 0, 0, 0, 0] }, create_pull_request: { errors: 0, denied: 0, ms: 2300, buckets: [0, 1, 0, 0, 0] } } },
      });

      const [r] = await q(sql`select *, input_tokens::int from runs where external_id = 'agent-a1'`);
      expect(r).toMatchObject({
        turn_id: t!.id, team_id: w.teams.mobile, user_id: w.users.alice, depth: 1, input_tokens: 300, skills: {},
        agent_group: 'Explore', orchestration_id: 'batch-1', stage_index: 1, flow_key: 'data',
      });
      expect(Object.keys(r!.mcp as object)).toHaveLength(1);
      // Its source (agent-a0) is not in the batch: the link waits with from_run_id NULL (ADR-0020).
      expect(await q(sql`select turn_id, from_run_id, from_external_id, to_external_id, kind from run_links where to_run_id = ${r!.id}`)).toEqual([
        { turn_id: t!.id, from_run_id: null, from_external_id: 'agent-a0', to_external_id: 'agent-a1', kind: 'item' },
      ]);

      const u = await q<{ turn_id: string | null; run_id: string | null; input_tokens: number }>(
        sql`select turn_id, run_id, model, input_tokens::int from usage where turn_id = ${t!.id} or run_id = ${r!.id} order by model`,
      );
      // Turn rows = whole turn (incl. sub-agent); run rows carry run_id only, so sum(turn_id = X) = turn total.
      expect(u.filter((x) => x.turn_id === t!.id).reduce((a, x) => a + Number(x.input_tokens), 0)).toBe(1500);
      expect(u.filter((x) => x.run_id === r!.id)).toEqual([expect.objectContaining({ turn_id: null, input_tokens: 300 })]);

      const [project] = await q(sql`select display_name from projects where id = ${w.projects.billing}`);
      expect(project!.display_name).toBe('Billing (admin name)'); // admin's name is not overwritten
      const [m] = await q(sql`select * from machines where machine_id = '6f1c2b9e-3d4a-4f5b-8c7d-9e0f1a2b3c4d'`);
      expect(m).toMatchObject({ os: 'darwin', user_id: w.users.alice });
      const [tok] = await q(sql`select last_used_at from ingest_tokens where user_id = ${w.users.alice} and revoked_at is null`);
      expect(tok!.last_used_at).not.toBeNull();
    });

    it('replay is all duplicates and changes nothing', async () => {
      const snapshot = () =>
        q(sql`select (select count(*) from turns) t, (select count(*) from runs) r, (select count(*) from usage) u,
          (select count(*) from agent_sessions) s, (select max(updated_at) from turns) tu, (select count(*) from ingest_events) e`);
      const before = await snapshot();
      const res = await post(w.tokens.alice, protocolFixture());
      expect(res).toEqual({ status: 200, body: { accepted: 0, duplicates: 6, rejected: [] } });
      expect(await snapshot()).toEqual(before);
    });

    it('accepts gzip bodies', async () => {
      const b = batch([ev.sessionStart('gz-1')]);
      const res = await post(w.tokens.alice, gzipSync(JSON.stringify(b)), { 'content-encoding': 'gzip' });
      expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    });
  });

  describe('attribution', () => {
    it("company token + git e-mail of a member → matched user, that member's primary team in this company", async () => {
      const b = batch([ev.sessionStart('ct-1', 'github.com/acme/unmapped', 'unmapped'), ev.turn('ct-1', 'ct-turn-1')], {
        identity: { git_email: 'Bob@Acme.test' },
      });
      expect((await post(w.tokens.ci, b)).body).toMatchObject({ accepted: 2, rejected: [] });
      const [t] = await q(sql`select user_id, attribution, team_id from turns where external_id = 'claude-code:ct-turn-1'`);
      expect(t).toEqual({ user_id: w.users.bob, attribution: 'matched', team_id: w.teams.mobile });
      const [p] = await q(sql`select display_name from projects where key = 'github.com/acme/unmapped'`);
      expect(p!.display_name).toBe('unmapped');
    });

    it('company token + member e-mail on a mapped project → matched, the project mapping wins', async () => {
      const b = batch([ev.sessionStart('ct-2', 'github.com/acme/billing'), ev.turn('ct-2', 'ct-turn-2')], {
        identity: { git_email: 'dave@acme.test' },
      });
      expect((await post(w.tokens.ci, b)).body).toMatchObject({ accepted: 2, rejected: [] });
      const [t] = await q(sql`select user_id, attribution, team_id from turns where external_id = 'claude-code:ct-turn-2'`);
      expect(t).toEqual({ user_id: w.users.dave, attribution: 'matched', team_id: w.teams.mobile });
    });

    it('company token + unknown, missing or another company member\'s e-mail → unverified, no user, no team', async () => {
      const cases = [['cu-1', { git_email: 'stranger@else.test' }], ['cu-2', {}], ['cu-3', { git_email: 'hank@hush.test' }]] as const;
      for (const [id, identity] of cases) {
        const res = await post(w.tokens.ci, batch([ev.turn(id, `${id}-turn`), ev.run(`${id}-turn`, 'r', null, 1)], { identity }));
        expect(res.body).toMatchObject({ accepted: 2, rejected: [] });
        const [t] = await q(sql`select user_id, attribution, team_id from turns where external_id = ${`claude-code:${id}-turn`}`);
        expect(t).toEqual({ user_id: null, attribution: 'unverified', team_id: null });
        const [r] = await q(sql`select user_id, team_id from runs where turn_external_id = ${`claude-code:${id}-turn`}`);
        expect(r).toEqual({ user_id: null, team_id: null });
      }
      // On a mapped project the unverified turn still gets the project's team.
      const mapped = batch([ev.sessionStart('cu-4', 'github.com/acme/billing'), ev.turn('cu-4', 'cu-4-turn')], {
        identity: { git_email: 'hank@hush.test' },
      });
      expect((await post(w.tokens.ci, mapped)).body).toMatchObject({ accepted: 2, rejected: [] });
      const [t] = await q(sql`select user_id, attribution, team_id from turns where external_id = 'claude-code:cu-4-turn'`);
      expect(t).toEqual({ user_id: null, attribution: 'unverified', team_id: w.teams.mobile });
      // hank's e-mail never matched across companies.
      expect(await q(sql`select 1 from turns where user_id = ${w.users.hank}`)).toEqual([]);
    });

    it('a user token is verified and ignores the git e-mail', async () => {
      const b = batch([ev.turn('ut-1', 'ut-turn-1')], { identity: { git_email: 'bob@acme.test' } });
      expect((await post(w.tokens.alice, b)).body).toMatchObject({ accepted: 1, rejected: [] });
      const [t] = await q(sql`select user_id, attribution, team_id from turns where external_id = 'claude-code:ut-turn-1'`);
      expect(t).toEqual({ user_id: w.users.alice, attribution: 'verified', team_id: w.teams.platform });
    });

    it('hashed company: plain keys are hashed and names dropped', async () => {
      const b = batch([ev.sessionStart('h-1', 'github.com/hush/secret', 'secret')]);
      expect((await post(w.tokens.hashedCo, b)).body).toMatchObject({ accepted: 1 });
      const rows = await q(sql`select key, display_name from projects where company_id = ${w.hashedCompanyId}`);
      expect(rows).toEqual([{ key: hashProjectKey('github.com/hush/secret'), display_name: null }]);
    });

    it('hashed company: plain skill and MCP names are hashed before they are stored', async () => {
      const turn = { ...ev.turn('h-2', 'h-turn-2'), skills: { 'secret-skill': { model: 1, user: 0 } }, mcp: { 'internal-db': { drop_table: 1 } } };
      expect((await post(w.tokens.hashedCo, batch([turn as never]))).body).toMatchObject({ accepted: 1, rejected: [] });
      const [t] = await q(sql`select skills, mcp from turns where external_id = 'claude-code:h-turn-2'`);
      expect(JSON.stringify(t)).not.toMatch(/secret-skill|internal-db|drop_table/);
      expect(Object.keys(t!.skills as object)[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('ordering', () => {
    it('links runs that arrive before their parent and their turn', async () => {
      const turnId = 'early-turn';
      expect((await post(w.tokens.alice, batch([ev.run(turnId, 'child', 'parent', 2, 7)]))).body.accepted).toBe(1);
      expect((await post(w.tokens.alice, batch([ev.run(turnId, 'parent', null, 1, 11)]))).body.accepted).toBe(1);
      const before = await q(sql`select external_id, turn_id from runs where turn_external_id = ${`claude-code:${turnId}`}`);
      expect(before.every((r) => r.turn_id === null)).toBe(true);

      await post(w.tokens.alice, batch([ev.sessionStart('early-s', 'github.com/acme/billing'), ev.turn('early-s', turnId)]));
      const [t] = await q(sql`select id, team_id from turns where external_id = ${`claude-code:${turnId}`}`);
      const runs = await q<{ id: string; external_id: string; turn_id: string; parent_run_id: string | null; team_id: string }>(
        sql`select id, external_id, turn_id, parent_run_id, team_id from runs where turn_external_id = ${`claude-code:${turnId}`}`,
      );
      const parent = runs.find((r) => r.external_id === 'parent')!;
      const child = runs.find((r) => r.external_id === 'child')!;
      expect(parent).toMatchObject({ turn_id: t!.id, parent_run_id: null, team_id: w.teams.mobile });
      expect(child).toMatchObject({ turn_id: t!.id, parent_run_id: parent.id, team_id: w.teams.mobile });
      const usageTeams = await q(sql`select distinct team_id from usage where run_id in (${sql.raw(runs.map((r) => `'${r.id}'`).join(','))})`);
      expect(usageTeams).toEqual([{ team_id: w.teams.mobile }]);
    });

    it('parks patches that arrive before their turn and applies them when it arrives (no placeholder turn)', async () => {
      const turnId = 'late-turn';
      const key = `claude-code:${turnId}`;
      const res = await post(w.tokens.alice, batch([ev.outcome(turnId, 'failed'), ev.summary(turnId, 'Fixed flaky test')]));
      expect(res.body).toMatchObject({ accepted: 2, rejected: [] });
      expect(await q(sql`select id from turns where external_id = ${key}`)).toEqual([]);
      const [parked] = await q(sql`select company_id, outcome, outcome_provisional, summary from pending_turn_patches
        where turn_external_id = ${key}`);
      expect(parked).toEqual({ company_id: w.companyId, outcome: 'failed', outcome_provisional: false, summary: 'Fixed flaky test' });

      await post(w.tokens.alice, batch([ev.turn('late-s', turnId, 4242, 'success')]));
      const [t] = await q(sql`select session_id, outcome, outcome_provisional, outcome_signals, summary, input_tokens::int from turns
        where external_id = ${key}`);
      expect(t).toMatchObject({
        outcome: 'failed', outcome_provisional: false, outcome_signals: ['next_prompt_correction'],
        summary: 'Fixed flaky test', input_tokens: 4242,
      });
      expect(t!.session_id).not.toBeNull();
      expect(await q(sql`select id from pending_turn_patches where turn_external_id = ${key}`)).toEqual([]);
      const n = await q(sql`select count(*)::int n from turns where external_id = ${key}`);
      expect(n[0]!.n).toBe(1);

      // A re-sent turn keeps the patched outcome; a summary for a known turn is applied directly.
      await post(w.tokens.alice, batch([ev.turn('late-s', turnId, 4242, 'success'), ev.summary(turnId, 'Second summary')]));
      const [again] = await q(sql`select outcome, summary from turns where external_id = ${key}`);
      expect(again).toEqual({ outcome: 'failed', summary: 'Second summary' });
      expect(await q(sql`select id from pending_turn_patches where turn_external_id = ${key}`)).toEqual([]);
    });

    it('app_ingest cannot read parked patch values or delete them', async () => {
      await post(w.tokens.alice, batch([ev.summary('never-turn', 'Parked')]));
      const denied = (query: ReturnType<typeof sql>) =>
        db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.company_id', ${w.companyId}, true)`);
          await tx.execute(query);
        });
      const denial = { cause: expect.objectContaining({ code: '42501' }) };
      await expect(denied(sql`select summary from pending_turn_patches`)).rejects.toMatchObject(denial);
      await expect(denied(sql`delete from pending_turn_patches`)).rejects.toMatchObject(denial);
    });

    it('a later outcome patch overrides the provisional outcome', async () => {
      await post(w.tokens.alice, batch([ev.turn('p-s', 'p-turn', 10, 'success')]));
      await post(w.tokens.alice, batch([ev.outcome('p-turn', 'failed')]));
      const [t] = await q(sql`select outcome from turns where external_id = 'claude-code:p-turn'`);
      expect(t!.outcome).toBe('failed');
    });

    it('a re-sent turn replaces its usage rows instead of adding to them', async () => {
      await post(w.tokens.alice, batch([ev.turn('re-s', 're-turn', 100)]));
      await post(w.tokens.alice, batch([ev.turn('re-s', 're-turn', 300)]));
      const [s] = await q(sql`select sum(u.input_tokens)::int total, max(t.input_tokens)::int turn from usage u
        join turns t on t.id = u.turn_id where t.external_id = 'claude-code:re-turn'`);
      expect(s).toEqual({ total: 300, turn: 300 });
    });

    it('accepts unknown harnesses', async () => {
      const t = { ...ev.turn('x-s', 'x-turn'), harness: 'some-new-agent' };
      expect((await post(w.tokens.alice, batch([t]))).body).toMatchObject({ accepted: 1, rejected: [] });
      const [row] = await q(sql`select harness from turns where external_id = 'some-new-agent:x-turn'`);
      expect(row!.harness).toBe('some-new-agent');
    });
  });

  describe('errors', () => {
    it('401 for missing, malformed, unknown and revoked tokens', async () => {
      const b = batch([ev.sessionStart('e-1')]);
      for (const token of [null, 'ghp_nope', 'aiobs_u_doesnotexist', w.tokens.revoked]) {
        const res = await post(token, b);
        expect(res.status).toBe(401);
      }
      // A company token presented with the user prefix is not accepted either.
      expect((await post(w.tokens.ci.replace('aiobs_c_', 'aiobs_u_'), b)).status).toBe(401);
      // The retired team prefix is refused, even with a secret that exists under another prefix (ADR-0022).
      expect((await post(w.tokens.ci.replace('aiobs_c_', 'aiobs_t_'), b)).status).toBe(401);
      expect((await post(`aiobs_t_${'x'.repeat(43)}`, b)).status).toBe(401);
    });

    it('413 for more than 500 events or more than 1 MB', async () => {
      const many = batch(Array.from({ length: 501 }, () => ev.sessionStart('big')));
      expect((await post(w.tokens.alice, many)).status).toBe(413);
      const huge = JSON.stringify({ ...batch([ev.sessionStart('big')]), pad: 'x'.repeat(1_000_001) });
      expect((await post(w.tokens.alice, huge)).status).toBe(413);
    });

    it('400 for a bad envelope or bad JSON; bad events are rejected one by one', async () => {
      expect((await post(w.tokens.alice, '{"schema":1')).status).toBe(400);
      expect((await post(w.tokens.alice, { ...batch([ev.sessionStart('b')]), schema: 2 } as unknown as IngestBatchInput)).status).toBe(400);
      expect((await post(w.tokens.alice, batch([]))).status).toBe(400);

      const bad = { ...ev.turn('b-s', 'b-turn'), ended_at: '2020-01-01T00:00:00Z' };
      const res = await post(w.tokens.alice, batch([bad, ev.sessionStart('b-ok')]));
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(1);
      expect(res.body.rejected).toEqual([{ event_id: bad.event_id, reason: expect.stringContaining('ended_at') }]);
    });

    it('an event the DB refuses is rejected alone and is not recorded as seen', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Passes the wire schema but violates projects_key_not_path.
      const refused = ev.sessionStart('db-bad', '.hidden/repo');
      const b = batch([refused, ev.sessionStart('db-ok')]);
      const first = await post(w.tokens.alice, b);
      expect(first.body).toEqual({ accepted: 1, duplicates: 0, rejected: [{ event_id: refused.event_id, reason: 'could not be stored' }] });
      const again = await post(w.tokens.alice, b);
      expect(again.body).toEqual({ accepted: 0, duplicates: 1, rejected: [{ event_id: refused.event_id, reason: 'could not be stored' }] });
      expect(await q(sql`select 1 from agent_sessions where external_id = 'claude-code:db-bad'`)).toEqual([]);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('429 when the token exceeds its rate limit', async () => {
      const tight = new TokenBucketLimiter({ burst: 1, perMinute: 1 });
      const call = () =>
        handleIngest(
          new Request('http://test/api/v1/ingest', {
            method: 'POST',
            headers: { authorization: `Bearer ${w.tokens.alice}` },
            body: JSON.stringify(batch([ev.sessionStart('rl')])),
          }),
          { db, limiter: tight },
        );
      expect((await call()).status).toBe(200);
      const limited = await call();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/collector-config', () => {
    const get = (token: string | null) =>
      handleCollectorConfig(
        new Request('http://test/api/v1/collector-config', { headers: token ? { authorization: `Bearer ${token}` } : {} }),
        { db, limiter: limiter(), env: { MIN_COLLECTOR_VERSION: '1.2.3' } },
      );

    it("returns naming mode, minimum collector version and the company's project salt (SEC-11)", async () => {
      const a = (await (await get(w.tokens.alice)).json()) as Record<string, string>;
      const h = (await (await get(w.tokens.hashedCo)).json()) as Record<string, string>;
      expect(a).toMatchObject({ project_naming: 'plain', min_collector_version: '1.2.3' });
      expect(h).toMatchObject({ project_naming: 'hashed', min_collector_version: '1.2.3' });
      expect(a.project_salt).toMatch(/^[0-9a-f]{64}$/);
      expect(h.project_salt).toMatch(/^[0-9a-f]{64}$/);
      expect(h.project_salt).not.toBe(a.project_salt);
      // Stable: a second call returns the same salt.
      expect(((await (await get(w.tokens.alice)).json()) as Record<string, string>).project_salt).toBe(a.project_salt);
    });

    it('names the company, and the user for a user token (null for a company token)', async () => {
      const res = await get(w.tokens.alice);
      expect(res.headers.get('cache-control')).toBe('private, max-age=300');
      const a = (await res.json()) as Record<string, unknown>;
      expect(a).toMatchObject({ company: { name: 'acme', slug: 'acme' }, user: { email: 'alice@acme.test' } });
      const c = (await (await get(w.tokens.ci)).json()) as Record<string, unknown>;
      expect(c).toMatchObject({ company: { name: 'acme', slug: 'acme' }, user: null });
      const h = (await (await get(w.tokens.hashedCo)).json()) as Record<string, unknown>;
      expect(h).toMatchObject({ company: { name: 'hush', slug: 'hush' }, user: null });
      // The body satisfies the protocol schema the collector validates with.
      expect(schemas.collectorConfigResponse.safeParse(a).success).toBe(true);
      expect(schemas.collectorConfigResponse.safeParse(c).success).toBe(true);
    });

    it('requires a valid token', async () => {
      expect((await get(null)).status).toBe(401);
      expect((await get(w.tokens.revoked)).status).toBe(401);
      expect((await get(w.tokens.ci.replace('aiobs_c_', 'aiobs_t_'))).status).toBe(401);
    });
  });

  describe('patch before turn: KPIs and rollups count one real turn', () => {
    it('counts nothing while only patches and runs exist, then exactly the real turn', async () => {
      // Own company so other tests' turns do not affect the counts.
      const co = await owner.run(async (tx) => {
        const one = async <T>(query: ReturnType<typeof sql>) => [...(await tx.execute(query))][0] as T;
        const c = await one<{ id: string }>(sql`insert into companies (name, slug) values ('Patch Co', 'patchco') returning id`);
        const t = await one<{ id: string }>(sql`insert into teams (company_id, name) values (${c.id}, 'Core') returning id`);
        const userId = await insertUser(tx, 'pat@patch.test', 'Pat');
        await insertMember(tx, c.id, userId, { role: 'admin', primaryTeamId: t.id, teamRole: 'lead' });
        return { companyId: c.id, teamId: t.id, userId, token: await insertToken(tx, c.id, userId) };
      });
      const web = connectRole('web');
      const worker = connectRole('worker');
      const DAY = '2026-10-05';
      const filters: Filters = { ...defaultFilters(), range: 'custom', from: DAY, to: DAY };
      const kpis = (mode: 'full' | 'aggregates-only', source: 'raw' | 'rollup') => {
        const viewer: Viewer = { id: co.userId, companyId: co.companyId, companyRole: 'admin', teams: [], company: { settings: { individualVisibility: mode } } };
        return withRlsContext(web, { companyId: co.companyId, userId: co.userId, role: 'admin' }, async (tx) =>
          getKpis({ ...(await createQueryContext(tx, viewer, new Date('2026-10-06T00:00:00Z'))), forceSource: source }, filters),
        );
      };
      const turnCount = async () =>
        (await q<{ n: number }>(sql`select count(*)::int n from turns where company_id = ${co.companyId}`))[0]!.n;

      const early = await post(co.token, batch([ev.outcome('pt-1', 'failed'), ev.summary('pt-1', 'Patched first'), ev.run('pt-1', 'r-1', null, 1, 70)]));
      expect(early.body).toMatchObject({ accepted: 3, rejected: [] });
      expect(await turnCount()).toBe(0);
      for (const mode of ['full', 'aggregates-only'] as const) expect((await kpis(mode, 'raw')).turns).toBe(0);
      expect(await recomputeDay(worker, co.companyId, DAY)).toBeNull();

      await post(co.token, batch([ev.sessionStart('pt-s', 'github.com/patch/app'), ev.turn('pt-s', 'pt-1', 900, 'success')]));
      expect(await turnCount()).toBe(1);
      expect(await recomputeDay(worker, co.companyId, DAY)).toEqual({ turns: 1, rows: 1 });
      const [roll] = await q<{ turns: number; failed: number; runs: number; input: number }>(sql`select sum(turns)::int turns,
        sum(failed)::int failed, sum(runs)::int runs, sum(input_tokens)::int input from daily_rollups where company_id = ${co.companyId}`);
      expect(roll).toEqual({ turns: 1, failed: 1, runs: 1, input: 900 });
      for (const mode of ['full', 'aggregates-only'] as const) {
        const raw = await kpis(mode, 'raw');
        const rolled = await kpis(mode, 'rollup');
        expect(raw).toMatchObject({ turns: 1, outcomes: { success: 0, failed: 1, abandoned: 0, unknown: 0 } });
        expect(raw.tokens.input).toBe(900);
        expect(rolled.turns).toBe(raw.turns);
        expect(rolled.tokens).toEqual(raw.tokens);
        expect(rolled.outcomes).toEqual(raw.outcomes);
      }
    });
  });


  const OWNED = 'conflicts with data owned by another user';

  describe('ownership of existing rows (SEC-3)', () => {
    const external = (kind: 'turns' | 'runs' | 'agent_sessions', id: string) =>
      q<{ user_id: string | null; input_tokens?: number; summary?: string | null }>(
        kind === 'turns'
          ? sql`select user_id, input_tokens::int, summary from turns where external_id = ${id}`
          : kind === 'runs'
            ? sql`select user_id from runs where external_id = ${id}`
            : sql`select user_id from agent_sessions where external_id = ${id}`,
      );

    it("another user's token cannot overwrite, patch or attach to someone else's turn, run or session", async () => {
      await post(w.tokens.alice, batch([ev.sessionStart('own-s'), ev.turn('own-s', 'own-t', 111), ev.run('own-t', 'own-r', null, 1)]));
      const stolen = [
        ev.turn('own-s', 'own-t', 1),
        ev.run('own-t', 'own-r', null, 1, 1),
        ev.run('own-t', 'own-r2', null, 1),
        ev.outcome('own-t', 'failed'),
        ev.summary('own-t', 'overwritten by bob'),
        ev.sessionStart('own-s'),
        { ...ev.sessionStart('own-s'), type: 'session_end', reason: 'x' } as unknown as IngestEventInput,
      ];
      const res = await post(w.tokens.bob, batch(stolen));
      expect(res.body.accepted).toBe(0);
      expect(res.body.rejected).toHaveLength(stolen.length);
      expect(res.body.rejected.every((r) => r.reason === OWNED)).toBe(true);

      expect(await external('turns', 'claude-code:own-t')).toEqual([{ user_id: w.users.alice, input_tokens: 111, summary: null }]);
      expect(await external('runs', 'own-r')).toEqual([{ user_id: w.users.alice }]);
      expect(await external('agent_sessions', 'claude-code:own-s')).toEqual([{ user_id: w.users.alice }]);
      expect(await q(sql`select 1 from runs where external_id = 'own-r2'`)).toEqual([]);
      const [t] = await q(sql`select outcome from turns where external_id = 'claude-code:own-t'`);
      expect(t!.outcome).toBe('success');
    });

    it('an unverified company-token sender cannot overwrite an owned turn either', async () => {
      const res = await post(w.tokens.ci, batch([ev.turn('own-s', 'own-t', 2)]));
      expect(res.body.rejected).toEqual([expect.objectContaining({ reason: OWNED })]);
    });

    it('the owner can re-send from another token or machine, and an unowned row can be claimed', async () => {
      // Same user through a company token + git e-mail (matched), from another machine.
      const viaCompany = batch([ev.turn('own-s', 'own-t', 222)], {
        identity: { git_email: 'alice@acme.test' },
        machine: { id: 'ffffffff-7d4b-4c1a-9b5e-3f2d1c0b9a87', os: 'darwin' },
      });
      expect((await post(w.tokens.ci, viaCompany)).body).toMatchObject({ accepted: 1, rejected: [] });
      expect(await external('turns', 'claude-code:own-t')).toEqual([{ user_id: w.users.alice, input_tokens: 222, summary: null }]);

      // Unverified first, matched/verified later: the row gets its owner.
      await post(w.tokens.ci, batch([ev.turn('claim-s', 'claim-t', 5)]));
      expect((await external('turns', 'claude-code:claim-t'))[0]!.user_id).toBeNull();
      expect((await post(w.tokens.bob, batch([ev.turn('claim-s', 'claim-t', 6)]))).body.accepted).toBe(1);
      expect((await external('turns', 'claude-code:claim-t'))[0]!.user_id).toBe(w.users.bob);
    });

    it('a turn cannot take over runs another user filed under the same key', async () => {
      await post(w.tokens.alice, batch([ev.run('early-t', 'early-r', null, 1)]));
      const res = await post(w.tokens.bob, batch([ev.turn('early-s', 'early-t')]));
      expect(res.body.rejected).toEqual([expect.objectContaining({ reason: OWNED })]);
      expect(await external('runs', 'early-r')).toEqual([{ user_id: w.users.alice }]);
    });

    it("a sender cannot pre-claim another user's event ids", async () => {
      const victim = ev.sessionStart('claim-ev');
      const squat = { ...ev.sessionStart('squat'), event_id: victim.event_id };
      expect((await post(w.tokens.bob, batch([squat]))).body.accepted).toBe(1);
      expect((await post(w.tokens.alice, batch([victim]))).body).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
      // ...while the owner's own retries still de-duplicate, from any of their tokens.
      expect((await post(w.tokens.alice, batch([victim]))).body).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
    });
  });

  describe('parked patches keep their sender (SEC-3 residual)', () => {
    it("another user cannot overwrite a parked patch or have it applied to their own turn", async () => {
      expect((await post(w.tokens.alice, batch([ev.summary('pp-t', "alice's summary")]))).body.accepted).toBe(1);
      // Bob cannot replace Alice's parked patch.
      const over = await post(w.tokens.bob, batch([ev.summary('pp-t', 'bob overwrites')]));
      expect(over.body.rejected).toEqual([expect.objectContaining({ reason: OWNED })]);
      // Bob's own turn with that key does not inherit Alice's parked patch either (it is dropped).
      expect((await post(w.tokens.bob, batch([ev.turn('pp-s', 'pp-t')]))).body.accepted).toBe(1);
      expect(await q(sql`select user_id, summary from turns where external_id = 'claude-code:pp-t'`)).toEqual([{ user_id: w.users.bob, summary: null }]);
      expect(await q(sql`select 1 from pending_turn_patches where turn_external_id = 'claude-code:pp-t'`)).toEqual([]);
    });

    it("the same user's parked patch is applied when the turn arrives", async () => {
      await post(w.tokens.alice, batch([ev.summary('pp-t2', 'mine')]));
      expect((await post(w.tokens.alice, batch([ev.turn('pp-s2', 'pp-t2')]))).body.accepted).toBe(1);
      expect(await q(sql`select user_id, summary from turns where external_id = 'claude-code:pp-t2'`)).toEqual([{ user_id: w.users.alice, summary: 'mine' }]);
    });
  });

  describe('event time window (DP-05, DP-08)', () => {
    const at = (iso: string) => ({ started_at: iso, ended_at: iso });
    // The test company is on the Free plan: its 395-day setting is capped to the plan maximum, 30 days.
    it('rejects turns and runs older than the retention cutoff or more than a day in the future', async () => {
      const day = 86_400_000;
      const old = { ...ev.turn('win-s', 'win-old'), ...at(new Date(Date.now() - 400 * day).toISOString()) } as IngestEventInput;
      const future = { ...ev.turn('win-s', 'win-fut'), ...at(new Date(Date.now() + 3 * day).toISOString()) } as IngestEventInput;
      const oldRun = { ...ev.run('win-t', 'win-run', null, 1), ...at(new Date(Date.now() - 400 * day).toISOString()) } as IngestEventInput;
      const fine = { ...ev.turn('win-s', 'win-ok'), ...at(new Date(Date.now() - 20 * day).toISOString()) } as IngestEventInput;
      const res = await post(w.tokens.alice, batch([old, future, oldRun, fine]));
      expect(res.body.accepted).toBe(1);
      expect(res.body.rejected.map((r) => r.reason).sort()).toEqual([
        'started_at is before the retention window',
        'started_at is before the retention window',
        'timestamp is more than a day in the future',
      ]);
      expect(await q(sql`select external_id from turns where external_id like 'claude-code:win-%'`)).toEqual([{ external_id: 'claude-code:win-ok' }]);
    });

    it('the cutoff is the plan maximum applied to the company retention setting', async () => {
      expect(timeWindowProblem(ev.turn('x', 'y'), 30, Date.parse('2026-10-06T12:00:00Z'))).toBeNull(); // 2026-10-05: inside 30 days
      const t = { ...ev.turn('x', 'y'), started_at: '2026-09-06T23:59:00Z', ended_at: '2026-09-07T00:01:00Z' } as IngestEventInput;
      // cutoff = 00:00 UTC of 2026-10-06 minus 30 days = 2026-09-06T00:00Z
      expect(timeWindowProblem(t, 30, Date.parse('2026-10-06T12:00:00Z'))).toBeNull();
      expect(timeWindowProblem({ ...t, started_at: '2026-09-05T23:59:00Z' } as IngestEventInput, 30, Date.parse('2026-10-06T12:00:00Z'))).toMatch(/retention/);
    });
  });

  describe('user tokens need a live membership (SEC-4, defence in depth)', () => {
    it("stops resolving once the user is no longer a member of the token's company; company tokens are unaffected", async () => {
      expect((await post(w.tokens.bob, batch([ev.sessionStart('mem-s')]))).status).toBe(200);
      // Removal deletes the membership (team memberships cascade); bob's identity and data stay (D1).
      await owner.run(async (tx) => {
        await tx.execute(sql`delete from company_memberships where user_id = ${w.users.bob} and company_id = ${w.companyId}`);
      });
      expect((await post(w.tokens.bob, batch([ev.sessionStart('mem-s2')]))).status).toBe(401);
      expect(await lookupToken(db, hashToken(w.tokens.bob))).toBeNull();
      expect((await post(w.tokens.ci, batch([ev.sessionStart('mem-s3')]))).status).toBe(200);
      // A company token no longer matches the removed member's git e-mail.
      const res = await post(w.tokens.ci, batch([ev.turn('mem-s4', 'mem-t4')], { identity: { git_email: 'bob@acme.test' } }));
      expect(res.body).toMatchObject({ accepted: 1, rejected: [] });
      expect(await q(sql`select user_id, attribution from turns where external_id = 'claude-code:mem-t4'`)).toEqual([
        { user_id: null, attribution: 'unverified' },
      ]);
      expect(await q(sql`select user_id from agent_sessions where external_id = 'claude-code:mem-s'`)).toEqual([{ user_id: w.users.bob }]);
      await owner.run((tx) => insertMember(tx, w.companyId, w.users.bob, { primaryTeamId: w.teams.mobile }));
      expect((await post(w.tokens.bob, batch([ev.sessionStart('mem-s5')]))).status).toBe(200);
    });

    it('a company token whose creator is no longer an admin or lead is refused (D2, also for a racing insert)', async () => {
      // As a token inserted concurrently with the creator's demotion would be left: unrevoked, creator a plain member.
      const stray = await owner.run((tx) => insertToken(tx, w.companyId, null, false, w.users.dave));
      expect((await post(stray, batch([ev.sessionStart('stray-s')]))).status).toBe(401);
      expect(await lookupToken(db, hashToken(stray))).toBeNull();
    });
  });

  describe('one person in two companies (ADR-0022)', () => {
    it("each user token writes only into its own company, and RLS keeps the two apart", async () => {
      const beta = await owner.run(async (tx) => {
        const [c] = [...(await tx.execute(sql`insert into companies (name, slug) values ('Beta', 'beta') returning id`))] as Array<{ id: string }>;
        const [t] = [...(await tx.execute(sql`insert into teams (company_id, name) values (${c!.id}, 'Core') returning id`))] as Array<{ id: string }>;
        await insertMember(tx, c!.id, w.users.dave, { primaryTeamId: t!.id });
        return { companyId: c!.id, teamId: t!.id, daveB: await insertToken(tx, c!.id, w.users.dave) };
      });
      const daveA = await owner.run((tx) => insertToken(tx, w.companyId, w.users.dave));
      const machine = { id: 'dddddddd-7d4b-4c1a-9b5e-3f2d1c0b9a87', os: 'linux' as const };
      const send = (token: string) =>
        post(token, batch([ev.sessionStart('dual-s', 'github.com/dave/side'), ev.turn('dual-s', 'dual-t')], { machine }));
      expect((await send(daveA)).body).toMatchObject({ accepted: 2, rejected: [] });
      expect((await send(beta.daveB)).body).toMatchObject({ accepted: 2, rejected: [] });

      const owned = (table: 'turns' | 'agent_sessions') =>
        q<{ company_id: string; user_id: string; team_id: string | null }>(
          sql`select company_id, user_id, team_id from ${sql.raw(table)} where external_id = ${table === 'turns' ? 'claude-code:dual-t' : 'claude-code:dual-s'}
              order by company_id = ${w.companyId} desc`,
        );
      expect(await owned('turns')).toEqual([
        { company_id: w.companyId, user_id: w.users.dave, team_id: w.teams.mobile },
        { company_id: beta.companyId, user_id: w.users.dave, team_id: beta.teamId },
      ]);
      expect((await owned('agent_sessions')).map((r) => r.company_id)).toEqual([w.companyId, beta.companyId]);
      const machines = await q<{ company_id: string }>(
        sql`select company_id from machines where machine_id = ${machine.id} order by company_id = ${w.companyId} desc`,
      );
      expect(machines.map((m) => m.company_id)).toEqual([w.companyId, beta.companyId]);

      const web = connectRole('web');
      const visible = (companyId: string) =>
        withRlsContext(web, { companyId, userId: w.users.dave, role: 'member' }, async (tx) => ({
          turns: [...(await tx.execute(sql`select company_id from turns where external_id = 'claude-code:dual-t'`))],
          sessions: [...(await tx.execute(sql`select company_id from agent_sessions where external_id = 'claude-code:dual-s'`))],
        }));
      expect(await visible(w.companyId)).toEqual({ turns: [{ company_id: w.companyId }], sessions: [{ company_id: w.companyId }] });
      expect(await visible(beta.companyId)).toEqual({ turns: [{ company_id: beta.companyId }], sessions: [{ company_id: beta.companyId }] });
    });
  });

  describe('value limits and privacy normalisation (DP-07, SEC-12)', () => {
    it('rejects counts the columns or the aggregates cannot hold, with the reason, and stores nothing', async () => {
      const big = ev.turn('lim-s', 'lim-t1') as IngestEventInput & { usage: Array<{ input: number }> };
      big.usage[0]!.input = Number.MAX_SAFE_INTEGER;
      const lines = { ...ev.turn('lim-s', 'lim-t2'), lines_added: 3_000_000_000 } as IngestEventInput;
      const phase = { ...ev.turn('lim-s', 'lim-t3'), phases_ms: { coding: 86_400_001 } } as IngestEventInput;
      const res = await post(w.tokens.alice, batch([big, lines, phase]));
      expect(res.body.accepted).toBe(0);
      expect(res.body.rejected.map((r) => r.reason)).toEqual([
        'usage.input is out of range',
        'lines_added is out of range',
        'phases_ms.coding is out of range',
      ]);
      expect(await q(sql`select 1 from turns where external_id like 'claude-code:lim-t%'`)).toEqual([]);
    });

    it('accepts values exactly at the limits', async () => {
      const t = { ...ev.turn('lim-s', 'lim-edge'), lines_added: INT4_MAX, files_touched: INT4_MAX } as IngestEventInput & { usage: Array<{ input: number }> };
      t.usage[0]!.input = MAX_TOKENS_PER_ENTRY;
      expect((await post(w.tokens.alice, batch([t]))).body).toMatchObject({ accepted: 1, rejected: [] });
      const [row] = await q(sql`select input_tokens::text i, lines_added from turns where external_id = 'claude-code:lim-edge'`);
      expect(row).toEqual({ i: String(MAX_TOKENS_PER_ENTRY), lines_added: INT4_MAX });
    });

    it('collapses odd tool keys and agent types and drops free-text signals before storing', async () => {
      const t = {
        ...ev.turn('priv-s', 'priv-t'),
        tools: { Edit: 2, '/Users/me/secret/tool': 3, 'my internal tool': 4, bash: 1 },
        outcome: { status: 'failed', signals: ['tests_failed', '/home/me/project', 'tests_failed'], provisional: false },
      } as unknown as IngestEventInput;
      const r = { ...ev.run('priv-t', 'priv-r', null, 1), agent_type: '/opt/acme/agents/secret', tools: { 'C:\\x': 1 } } as unknown as IngestEventInput;
      expect((await post(w.tokens.alice, batch([t, r]))).body).toMatchObject({ accepted: 2, rejected: [] });
      const [turn] = await q(sql`select tools, outcome_signals from turns where external_id = 'claude-code:priv-t'`);
      expect(turn).toEqual({ tools: { edit: 2, other: 7, bash: 1 }, outcome_signals: ['tests_failed'] });
      const [run] = await q(sql`select agent_type, tools from runs where external_id = 'priv-r'`);
      expect(run).toEqual({ agent_type: 'other', tools: { other: 1 } });
    });
  });

  describe('agent groups (ADR-0019)', () => {
    const runRow = async (id: string) =>
      (await q(sql`select agent_type, agent_group, orchestration_id from runs where external_id = ${id}`))[0];

    it('stores agent_group / orchestration_id, NULLs without them, and sanitises a path-like group', async () => {
      const t = ev.turn('grp-s', 'grp-t');
      const withFields = {
        ...ev.run('grp-t', 'grp-r1', null, 1),
        agent_type: 'workflow:impl-m08-t02b',
        agent_group: 'workflow:impl',
        orchestration_id: 'wf_01J9ZQ8Y3N4X5V6W7Z8A9B0C',
      } as IngestEventInput;
      const without = ev.run('grp-t', 'grp-r2', null, 1);
      const pathLike = {
        ...ev.run('grp-t', 'grp-r3', null, 1),
        agent_group: '/Users/me/agents/secret',
        orchestration_id: 'C:\\runs\\x',
      } as IngestEventInput;
      expect((await post(w.tokens.alice, batch([t, withFields, without, pathLike]))).body).toMatchObject({
        accepted: 4,
        rejected: [],
      });
      expect(await runRow('grp-r1')).toEqual({
        agent_type: 'workflow:impl-m08-t02b',
        agent_group: 'workflow:impl',
        orchestration_id: 'wf_01J9ZQ8Y3N4X5V6W7Z8A9B0C',
      });
      expect(await runRow('grp-r2')).toEqual({ agent_type: 'Explore', agent_group: null, orchestration_id: null });
      expect(await runRow('grp-r3')).toEqual({ agent_type: 'Explore', agent_group: 'other', orchestration_id: null });
    });

    it('a re-sent run updates the group and clears it when the new event has none', async () => {
      const t = ev.turn('grp2-s', 'grp2-t');
      const first = { ...ev.run('grp2-t', 'grp2-r', null, 1), agent_group: 'Explore', orchestration_id: 'b-1' } as IngestEventInput;
      expect((await post(w.tokens.alice, batch([t, first]))).body).toMatchObject({ accepted: 2, rejected: [] });
      expect(await runRow('grp2-r')).toMatchObject({ agent_group: 'Explore', orchestration_id: 'b-1' });
      const again = { ...ev.run('grp2-t', 'grp2-r', null, 1), agent_group: 'workflow:verify' } as IngestEventInput;
      expect((await post(w.tokens.alice, batch([again]))).body).toMatchObject({ accepted: 1, rejected: [] });
      expect(await runRow('grp2-r')).toMatchObject({ agent_group: 'workflow:verify', orchestration_id: null });
    });
  });

  describe('agent flow links (ADR-0020)', () => {
    type Link = { kind: string; from_external_id: string; from_run_id: string | null; turn_id: string | null };
    const runId = async (ext: string) => (await q<{ id: string }>(sql`select id from runs where external_id = ${ext}`))[0]!.id;
    const linksTo = (ext: string) =>
      q<Link>(sql`select l.kind, l.from_external_id, l.from_run_id, l.turn_id from run_links l
        join runs r on r.id = l.to_run_id where r.external_id = ${ext} order by l.kind, l.from_external_id`);
    const flowRun = (turn: string, id: string, extra: Record<string, unknown> = {}) =>
      ({ ...ev.run(turn, id, null, 1), ...extra }) as IngestEventInput;
    const turnRowId = async (turn: string) =>
      (await q<{ id: string }>(sql`select id from turns where external_id = ${`claude-code:${turn}`}`))[0]!.id;

    it('stores links with resolved ids (deduplicated, no self-link) and resolves a link to a run that arrives later', async () => {
      const b = flowRun('fl-t', 'fl-b', {
        stage_index: 2,
        flow_key: 'bugs',
        links: [
          { from_run_id: 'fl-a', kind: 'item' },
          { from_run_id: 'fl-a', kind: 'item' },
          { from_run_id: 'fl-b', kind: 'item' },
          { from_run_id: 'fl-c', kind: 'sequence' },
        ],
      });
      const res = await post(w.tokens.alice, batch([ev.turn('fl-s', 'fl-t'), flowRun('fl-t', 'fl-a'), b]));
      expect(res.body).toMatchObject({ accepted: 3, rejected: [] });
      const turnId = await turnRowId('fl-t');
      const a = await runId('fl-a');
      expect(await linksTo('fl-b')).toEqual([
        { kind: 'item', from_external_id: 'fl-a', from_run_id: a, turn_id: turnId },
        { kind: 'sequence', from_external_id: 'fl-c', from_run_id: null, turn_id: turnId },
      ]);
      const [row] = await q(sql`select stage_index, flow_key from runs where external_id = 'fl-b'`);
      expect(row).toEqual({ stage_index: 2, flow_key: 'bugs' });

      expect((await post(w.tokens.alice, batch([flowRun('fl-t', 'fl-c')]))).body).toMatchObject({ accepted: 1, rejected: [] });
      const c = await runId('fl-c');
      expect((await linksTo('fl-b')).map((l) => l.from_run_id)).toEqual([a, c]);
    });

    it('a re-sent run replaces its incoming links; one without links clears them', async () => {
      const run = (links?: Array<{ from_run_id: string; kind: 'item' | 'sequence' }>) =>
        flowRun('fl2-t', 'fl2-b', links ? { links } : {});
      await post(w.tokens.alice, batch([ev.turn('fl2-s', 'fl2-t'), flowRun('fl2-t', 'fl2-a'), flowRun('fl2-t', 'fl2-x'),
        run([{ from_run_id: 'fl2-a', kind: 'item' }, { from_run_id: 'fl2-x', kind: 'sequence' }])]));
      expect((await linksTo('fl2-b')).map((l) => `${l.kind}:${l.from_external_id}`)).toEqual(['item:fl2-a', 'sequence:fl2-x']);
      expect((await post(w.tokens.alice, batch([run([{ from_run_id: 'fl2-x', kind: 'item' }])]))).body).toMatchObject({ accepted: 1 });
      expect(await linksTo('fl2-b')).toEqual([
        { kind: 'item', from_external_id: 'fl2-x', from_run_id: await runId('fl2-x'), turn_id: await turnRowId('fl2-t') },
      ]);
      expect((await post(w.tokens.alice, batch([run()]))).body).toMatchObject({ accepted: 1 });
      expect(await linksTo('fl2-b')).toEqual([]);
      // The source run's own links are untouched, and re-sending the source keeps the edge resolved.
      await post(w.tokens.alice, batch([run([{ from_run_id: 'fl2-a', kind: 'item' }])]));
      await post(w.tokens.alice, batch([flowRun('fl2-t', 'fl2-a')]));
      expect((await linksTo('fl2-b')).map((l) => l.from_run_id)).toEqual([await runId('fl2-a')]);
    });

    it('links of runs that arrive before their turn get the turn id when it arrives', async () => {
      const b = flowRun('fl3-t', 'fl3-b', { links: [{ from_run_id: 'fl3-a', kind: 'sequence' }] });
      await post(w.tokens.alice, batch([b]));
      expect(await linksTo('fl3-b')).toEqual([{ kind: 'sequence', from_external_id: 'fl3-a', from_run_id: null, turn_id: null }]);
      await post(w.tokens.alice, batch([flowRun('fl3-t', 'fl3-a')]));
      await post(w.tokens.alice, batch([ev.turn('fl3-s', 'fl3-t')]));
      expect(await linksTo('fl3-b')).toEqual([
        { kind: 'sequence', from_external_id: 'fl3-a', from_run_id: await runId('fl3-a'), turn_id: await turnRowId('fl3-t') },
      ]);
    });

    it('a link from the run to itself is dropped, and flow_key is sanitised (trimmed; path-like or absent → NULL)', async () => {
      const self = flowRun('fl4-t', 'fl4-a', { flow_key: '  data  ', links: [{ from_run_id: 'fl4-a', kind: 'item' }] });
      const pathLike = flowRun('fl4-t', 'fl4-b', { flow_key: '/Users/me/secret' });
      const bare = flowRun('fl4-t', 'fl4-c');
      expect((await post(w.tokens.alice, batch([ev.turn('fl4-s', 'fl4-t'), self, pathLike, bare]))).body).toMatchObject({
        accepted: 4,
        rejected: [],
      });
      expect(await linksTo('fl4-a')).toEqual([]);
      const flow = await q(sql`select external_id, stage_index, flow_key from runs where turn_external_id = 'claude-code:fl4-t'
        order by external_id`);
      expect(flow).toEqual([
        { external_id: 'fl4-a', stage_index: null, flow_key: 'data' },
        { external_id: 'fl4-b', stage_index: null, flow_key: null },
        { external_id: 'fl4-c', stage_index: null, flow_key: null },
      ]);
    });
  });

  describe('outcome ordering (DP-09)', () => {
    const outcomeOf = async (id: string) =>
      (await q(sql`select outcome, outcome_provisional p from turns where external_id = ${`claude-code:${id}`}`))[0];
    const patch = (turnId: string, status: 'failed' | 'success', provisional: boolean) =>
      ({ ...ev.outcome(turnId, status), outcome: { status, signals: [], provisional } }) as IngestEventInput;

    it('a provisional patch arriving after a final one does not replace it', async () => {
      await post(w.tokens.alice, batch([ev.turn('ord-s', 'ord-t')]));
      await post(w.tokens.alice, batch([patch('ord-t', 'failed', false)]));
      const late = await post(w.tokens.alice, batch([patch('ord-t', 'success', true)]));
      expect(late.body).toMatchObject({ accepted: 1, rejected: [] });
      expect(await outcomeOf('ord-t')).toEqual({ outcome: 'failed', p: false });
    });

    it('a final patch still replaces a provisional one, also when the turn has not arrived yet', async () => {
      await post(w.tokens.alice, batch([patch('ord-t2', 'success', true)]));
      await post(w.tokens.alice, batch([patch('ord-t2', 'failed', false)]));
      await post(w.tokens.alice, batch([patch('ord-t2', 'success', true)]));
      await post(w.tokens.alice, batch([ev.turn('ord-s2', 'ord-t2')]));
      expect(await outcomeOf('ord-t2')).toEqual({ outcome: 'failed', p: false });
    });
  });

  describe('batch transactions (DP-13, DP-14)', () => {
    const parsed = (events: IngestEventInput[], over: Partial<IngestBatchInput> = {}) => {
      const r = validateBatch(batch(events, over));
      if (!r.ok) throw new Error(r.error);
      return r;
    };

    it('a run racing its turn is linked: applyRun takes the turn lock', async () => {
      const token = (await lookupToken(db, hashToken(w.tokens.alice)))!;
      const runBatch = parsed([ev.run('race-t', 'race-r', null, 1)]);
      // Another machine: both batches upsert their machine row, and a shared one would serialise them by itself.
      const turnBatch = parsed([ev.turn('race-s', 'race-t')], { machine: { id: 'aaaaaaaa-7d4b-4c1a-9b5e-3f2d1c0b9a87', os: 'linux' } });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let runApplied!: () => void;
      const applied = new Promise<void>((r) => (runApplied = r));

      // Transaction A has inserted the run (turn not visible yet) and stays open.
      const a = withIngestContext(db, token.companyId, async (tx) => {
        const res = await processBatch(tx, token, runBatch.header, runBatch.events);
        runApplied();
        await gate;
        return res;
      });
      await applied;
      let turnDone = false;
      const b = withIngestContext(db, token.companyId, (tx) => processBatch(tx, token, turnBatch.header, turnBatch.events)).then((r) => {
        turnDone = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(turnDone).toBe(false); // waits for A's lock instead of committing past the uncommitted run
      release();
      expect((await Promise.all([a, b])).map((r) => r.accepted)).toEqual([1, 1]);
      const [run] = await q(sql`select turn_id is not null linked from runs where external_id = 'race-r'`);
      expect(run).toEqual({ linked: true });
    });

    it('uses one savepoint per chunk, not per event, and isolates a failing event within its chunk', async () => {
      const token = (await lookupToken(db, hashToken(w.tokens.alice)))!;
      const events: IngestEventInput[] = [];
      for (let i = 0; i < 60; i++) events.push(ev.sessionStart(`chunk-${i}`));
      const bad = ev.sessionStart('chunk-bad', '.hidden/repo'); // refused by projects_key_not_path
      events.splice(30, 0, bad);
      const b = parsed(events);

      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let savepoints = 0;
      const res = await withIngestContext(db, token.companyId, (tx) => {
        const orig = tx.transaction.bind(tx);
        tx.transaction = ((fn: never) => (savepoints++, orig(fn))) as typeof tx.transaction;
        return processBatch(tx, token, b.header, b.events);
      });
      spy.mockRestore();
      expect(res).toEqual({ accepted: 60, duplicates: 0, rejected: [{ event_id: bad.event_id, reason: 'could not be stored' }] });
      expect((await q(sql`select count(*)::int n from agent_sessions where external_id like 'claude-code:chunk-%'`))[0]).toEqual({ n: 60 });

      // Clean batch: ceil(61 / chunk) savepoints instead of 61.
      const clean = parsed(Array.from({ length: 61 }, (_, i) => ev.sessionStart(`chunk2-${i}`)));
      savepoints = 0;
      await withIngestContext(db, token.companyId, (tx) => {
        const orig = tx.transaction.bind(tx);
        tx.transaction = ((fn: never) => (savepoints++, orig(fn))) as typeof tx.transaction;
        return processBatch(tx, token, clean.header, clean.events);
      });
      expect(savepoints).toBe(Math.ceil(61 / EVENTS_PER_SAVEPOINT));
    });
  });

  describe('invalid-token handling (SEC-9)', () => {
    const call = (token: string, deps: Parameters<typeof handleIngest>[1], ip = '203.0.113.9') =>
      handleIngest(
        new Request('http://test/api/v1/ingest', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': `10.9.9.9, ${ip}` },
          body: JSON.stringify(batch([ev.sessionStart(`guard-${Math.random()}`)])),
        }),
        deps,
      );

    it('random bearers spend a per-IP budget, never create or evict per-token buckets, and valid tokens keep working', async () => {
      const limiter = new TokenBucketLimiter({ burst: 5, perMinute: 60, maxKeys: 3 });
      const authGuard = new AuthGuard({ failures: { burst: 3, perMinute: 1 } });
      const deps = { db, limiter, authGuard };

      expect((await call(w.tokens.alice, deps)).status).toBe(200); // seen valid
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await call(generateToken('user').plaintext, deps)).status);
      expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
      expect(limiter.size).toBe(1); // only the real token_id has a bucket
      expect((await call(w.tokens.alice, deps)).status).toBe(200); // not locked out by the same IP's failures
      // Another IP is not affected.
      expect((await call(generateToken('user').plaintext, deps, '198.51.100.7')).status).toBe(401);
    });
  });

  it('never lets one company write into another (RLS)', async () => {
    // The hashed company's token wrote only into its own company.
    const rows = await q(sql`select distinct company_id from agent_sessions where external_id = 'claude-code:h-1'`);
    expect(rows).toEqual([{ company_id: w.hashedCompanyId }]);
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
