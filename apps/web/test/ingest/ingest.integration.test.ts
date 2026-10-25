import { gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database, Tx } from '@ai-obs/db';
import { schemas, validateBatch, type IngestBatchInput, type IngestEventInput, type IngestResponse } from '@ai-obs/protocol';
import { handleCollectorConfig, handleIngest, TOKEN_REJECTED, TOKEN_RETIRED } from '../../src/lib/ingest/handler';
import { batchSessionKeys } from '../../src/lib/ingest/apply-events';
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
import { batch, createWorld, ev, insertMember, insertTeam, insertToken, insertUser, protocolFixture, setSettings, ulid, type World } from './fixtures';

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
      expect(res).toEqual({ status: 200, body: { accepted: 8, duplicates: 0, rejected: [] } });

      const [s] = await q(sql`select s.*, p.key from agent_sessions s join projects p on p.id = s.project_id
        where s.external_id = 'claude-code:sess-1'`);
      expect(s).toMatchObject({
        key: 'github.com/acme/billing', harness_version: '2.1.0', end_reason: 'exit', user_id: w.users.alice,
        title: 'Auth middleware JWT refresh', title_source: 'custom',
      });
      expect(s!.ended_at).not.toBeNull();
      // Live status (ADR-0027): the turn and session_end cleared the turn start; last seen = session_end.
      expect(
        await q(sql`select current_turn_started_at is null as idle, last_seen_at = '2026-10-05T10:30:00Z'::timestamptz as seen
          from agent_sessions where external_id = 'claude-code:sess-1'`),
      ).toEqual([{ idle: true, seen: true }]);
      expect(
        await q(sql`select type from ingest_events where event_id = ${`${w.users.alice}:01J9ZQ8Y3N4X5V6W7Z8A9B0C1B`}`),
      ).toEqual([{ type: 'turn_started' }]);

      const [t] = await q(sql`select *, input_tokens::int, output_tokens::int, cache_read_tokens::int,
        cache_write_tokens::int, reasoning_tokens::int, requests::int, duration_ms::int
        from turns where external_id = 'claude-code:turn-1'`);
      expect(t).toMatchObject({
        user_id: w.users.alice,
        attribution: 'verified',
        team_id: w.teams.mobile, // the admin's project mapping wins over alice's primary team (project.team is ignored)
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
      expect(res).toEqual({ status: 200, body: { accepted: 0, duplicates: 8, rejected: [] } });
      expect(await snapshot()).toEqual(before);
    });

    it('accepts gzip bodies', async () => {
      const b = batch([ev.sessionStart('gz-1')]);
      const res = await post(w.tokens.alice, gzipSync(JSON.stringify(b)), { 'content-encoding': 'gzip' });
      expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    });
  });

  describe('attribution and team resolution (ADR-0029, ADR-0035)', () => {
    const teamOf = async (table: 'turns' | 'agent_sessions', id: string) =>
      (await q<{ team_id: string | null; user_id: string | null; attribution?: string }>(
        table === 'turns'
          ? sql`select team_id, user_id, attribution from turns where external_id = ${`claude-code:${id}`}`
          : sql`select team_id, user_id from agent_sessions where external_id = ${`claude-code:${id}`}`,
      ))[0];

    it("every row belongs to the token's user and is verified; the git e-mail is ignored", async () => {
      const b = batch([ev.sessionStart('at-1', 'github.com/acme/unmapped', 'unmapped'), ev.turn('at-1', 'at-turn-1')], {
        identity: { git_email: 'alice@acme.test' },
      });
      expect((await post(w.tokens.bob, b)).body).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
      expect(await teamOf('turns', 'at-turn-1')).toEqual({ user_id: w.users.bob, attribution: 'verified', team_id: w.teams.mobile });
      const [p] = await q(sql`select display_name from projects where key = 'github.com/acme/unmapped'`);
      expect(p!.display_name).toBe('unmapped');
    });

    it('a service-user token reports as that service user, with its primary team', async () => {
      const res = await post(w.tokens.svc, batch([ev.sessionStart('svc-s'), ev.turn('svc-s', 'svc-t')]));
      expect(res.body).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
      expect(await teamOf('turns', 'svc-t')).toEqual({ user_id: w.users.svc, attribution: 'verified', team_id: w.teams.mobile });
    });

    it('the admin mapping sets the team; a project.team from an older collector is ignored', async () => {
      for (const [id, team] of [['tr-map-1', 'design'], ['tr-map-2', 'nope'], ['tr-map-3', 'mobile']] as const) {
        const res = await post(w.tokens.alice, batch([ev.sessionStart(id, 'github.com/acme/billing', undefined, team), ev.turn(id, `${id}-t`)]));
        expect(res.body).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
        expect((await teamOf('agent_sessions', id))!.team_id).toBe(w.teams.mobile);
        expect((await teamOf('turns', `${id}-t`))!.team_id).toBe(w.teams.mobile);
      }
    });

    it("an unmapped project reports to the user's primary team whatever project.team says, without warnings", async () => {
      const res = await post(w.tokens.alice, batch([
        ev.sessionStart('tr-dot', 'github.com/acme/web', 'web', 'design'),
        ev.turn('tr-dot', 'tr-dot-t'),
        ev.run('tr-dot-t', 'tr-dot-r', null, 1),
        ev.sessionStart('tr-nm', 'github.com/acme/web', undefined, 'mobile'),
        ev.sessionStart('tr-unk', 'github.com/acme/web', undefined, 'no-such-team'),
      ]));
      expect(res).toEqual({ status: 200, body: { accepted: 5, duplicates: 0, rejected: [] } });
      expect(schemas.ingestResponse.safeParse(res.body).success).toBe(true);
      for (const id of ['tr-dot', 'tr-nm', 'tr-unk']) expect((await teamOf('agent_sessions', id))!.team_id).toBe(w.teams.platform);
      expect((await teamOf('turns', 'tr-dot-t'))!.team_id).toBe(w.teams.platform);
      expect(await q(sql`select team_id from runs where external_id = 'tr-dot-r'`)).toEqual([{ team_id: w.teams.platform }]);
      expect(await q(sql`select distinct u.team_id from usage u join turns t on t.id = u.turn_id where t.external_id = 'claude-code:tr-dot-t'`))
        .toEqual([{ team_id: w.teams.platform }]);
    });

    it('without a mapping or a primary team a session has no team, even when project.team names one of the user\'s teams', async () => {
      const res = await post(w.tokens.nora, batch([
        ev.sessionStart('tr-nora', 'github.com/acme/web', undefined, 'design'),
        ev.turn('tr-nora', 'tr-nora-t'),
        ev.sessionStart('tr-nora2', 'github.com/acme/web'),
      ]));
      expect(res.body).toEqual({ accepted: 3, duplicates: 0, rejected: [] });
      expect(await teamOf('turns', 'tr-nora-t')).toEqual({ user_id: w.users.nora, attribution: 'verified', team_id: null });
      expect((await teamOf('agent_sessions', 'tr-nora2'))!.team_id).toBeNull();
    });

    it('the team is pinned at session_start: a later mapping does not move the running session, a new session follows it', async () => {
      await post(w.tokens.alice, batch([ev.sessionStart('tr-pin', 'github.com/acme/pinned'), ev.turn('tr-pin', 'tr-pin-1')]));
      expect((await teamOf('turns', 'tr-pin-1'))!.team_id).toBe(w.teams.platform);
      await q(sql`update projects set team_id = ${w.teams.mobile} where key = 'github.com/acme/pinned'`);
      await post(w.tokens.alice, batch([ev.turn('tr-pin', 'tr-pin-2'), ev.run('tr-pin-2', 'tr-pin-r', null, 1)]));
      expect((await teamOf('turns', 'tr-pin-2'))!.team_id).toBe(w.teams.platform);
      expect(await q(sql`select team_id from runs where external_id = 'tr-pin-r'`)).toEqual([{ team_id: w.teams.platform }]);
      await post(w.tokens.alice, batch([ev.sessionStart('tr-pin-new', 'github.com/acme/pinned'), ev.turn('tr-pin-new', 'tr-pin-3')]));
      expect((await teamOf('turns', 'tr-pin-3'))!.team_id).toBe(w.teams.mobile);
    });

    it('a later session_start of the same session keeps the pinned team, so its turns never split across teams', async () => {
      await post(w.tokens.alice, batch([ev.sessionStart('tr-rr', 'github.com/acme/repin'), ev.turn('tr-rr', 'tr-rr-1')]));
      await q(sql`update projects set team_id = ${w.teams.mobile} where key = 'github.com/acme/repin'`);
      // A lost collector state sends a fresh session_start for the running session.
      const res = await post(w.tokens.alice, batch([ev.sessionStart('tr-rr', 'github.com/acme/repin'), ev.turn('tr-rr', 'tr-rr-2')]));
      expect(res.body).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
      expect((await teamOf('agent_sessions', 'tr-rr'))!.team_id).toBe(w.teams.platform);
      expect((await teamOf('turns', 'tr-rr-1'))!.team_id).toBe(w.teams.platform);
      expect((await teamOf('turns', 'tr-rr-2'))!.team_id).toBe(w.teams.platform);
      // A re-sent old turn stays on the pinned team as well.
      await post(w.tokens.alice, batch([ev.turn('tr-rr', 'tr-rr-1')]));
      expect((await teamOf('turns', 'tr-rr-1'))!.team_id).toBe(w.teams.platform);
    });

    it('turns, runs and usage that arrived before session_start move to the resolved (mapped) team when it arrives', async () => {
      await post(w.tokens.alice, batch([ev.turn('tr-late', 'tr-late-t'), ev.run('tr-late-t', 'tr-late-r', null, 1)]));
      expect((await teamOf('turns', 'tr-late-t'))!.team_id).toBe(w.teams.platform); // primary team meanwhile
      const res = await post(w.tokens.alice, batch([ev.sessionStart('tr-late', 'github.com/acme/billing')]));
      expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
      expect((await teamOf('agent_sessions', 'tr-late'))!.team_id).toBe(w.teams.mobile);
      expect((await teamOf('turns', 'tr-late-t'))!.team_id).toBe(w.teams.mobile);
      expect(await q(sql`select team_id from runs where external_id = 'tr-late-r'`)).toEqual([{ team_id: w.teams.mobile }]);
      expect(await q(sql`select distinct team_id from usage where turn_id = (select id from turns where external_id = 'claude-code:tr-late-t')
        or run_id = (select id from runs where external_id = 'tr-late-r')`)).toEqual([{ team_id: w.teams.mobile }]);
    });

    it('a session_start without a project keeps the team the session already has', async () => {
      await post(w.tokens.alice, batch([ev.sessionStart('tr-keep', 'github.com/acme/billing')]));
      await post(w.tokens.alice, batch([ev.sessionStart('tr-keep')]));
      expect((await teamOf('agent_sessions', 'tr-keep'))!.team_id).toBe(w.teams.mobile);
    });

    describe('hashed project naming', () => {
      beforeAll(() => owner.run((tx) => setSettings(tx, { projectNaming: 'hashed' })));
      afterAll(() => owner.run((tx) => setSettings(tx, { projectNaming: 'plain' })));

      it('plain keys are hashed and names dropped', async () => {
        const b = batch([ev.sessionStart('h-1', 'github.com/hush/secret', 'secret')]);
        expect((await post(w.tokens.alice, b)).body).toMatchObject({ accepted: 1 });
        const rows = await q(sql`select key, display_name from projects where key like 'sha256:%' or key = 'github.com/hush/secret'`);
        expect(rows).toEqual([{ key: hashProjectKey('github.com/hush/secret'), display_name: null }]);
      });

      it('plain skill and MCP names are hashed before they are stored', async () => {
        const turn = { ...ev.turn('h-2', 'h-turn-2'), skills: { 'secret-skill': { model: 1, user: 0 } }, mcp: { 'internal-db': { drop_table: 1 } } };
        expect((await post(w.tokens.alice, batch([turn as never]))).body).toMatchObject({ accepted: 1, rejected: [] });
        const [t] = await q(sql`select skills, mcp from turns where external_id = 'claude-code:h-turn-2'`);
        expect(JSON.stringify(t)).not.toMatch(/secret-skill|internal-db|drop_table/);
        expect(Object.keys(t!.skills as object)[0]).toMatch(/^sha256:[0-9a-f]{64}$/);
      });
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
      const [parked] = await q(sql`select user_id, outcome, outcome_provisional, summary from pending_turn_patches
        where turn_external_id = ${key}`);
      expect(parked).toEqual({ user_id: w.users.alice, outcome: 'failed', outcome_provisional: false, summary: 'Fixed flaky test' });

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
          await tx.execute(sql`select set_config('app.user_id', ${w.users.alice}, true)`);
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
    it('401 for missing, malformed, unknown, revoked and expired tokens', async () => {
      const b = batch([ev.sessionStart('e-1')]);
      for (const token of [null, 'ghp_nope', 'aiobs_u_doesnotexist', w.tokens.revoked, w.tokens.expired]) {
        const res = await post(token, b);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe(TOKEN_REJECTED);
      }
      expect(TOKEN_REJECTED).toMatch(/expired or revoked, run `ai-obs login`/);
    });

    it('401 explicitly for the retired company and team prefixes, even with a secret that exists as a user token', async () => {
      const b = batch([ev.sessionStart('e-2')]);
      for (const token of [w.tokens.alice.replace('aiobs_u_', 'aiobs_c_'), w.tokens.alice.replace('aiobs_u_', 'aiobs_t_'), `aiobs_c_${'x'.repeat(43)}`]) {
        const res = await post(token, b);
        expect(res).toEqual({ status: 401, body: { error: TOKEN_RETIRED } });
      }
    });

    it('a token stops working the moment it expires; one with a future expiry works', async () => {
      const token = await owner.run((tx) => insertToken(tx, w.users.dave, { expiresAt: '2099-01-01T00:00:00Z' }));
      expect((await post(token, batch([ev.sessionStart('exp-1')]))).status).toBe(200);
      await q(sql`update ingest_tokens set expires_at = now() - interval '1 second' where hash = ${hashToken(token)}`);
      expect((await post(token, batch([ev.sessionStart('exp-2')]))).status).toBe(401);
      expect(await lookupToken(db, hashToken(token))).toBeNull();
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

  describe('GET /api/v1/collector-config (Appendix A)', () => {
    const get = (token: string | null) =>
      handleCollectorConfig(
        new Request('http://test/api/v1/collector-config', { headers: token ? { authorization: `Bearer ${token}` } : {} }),
        { db, limiter: limiter(), env: { MIN_COLLECTOR_VERSION: '1.2.3' } },
      );

    it("returns naming mode, minimum version, the deployment's salt, the deployment, user, teams, primary team and token", async () => {
      const res = await get(w.tokens.device);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, max-age=300');
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        project_naming: 'plain',
        min_collector_version: '1.2.3',
        project_salt: expect.stringMatching(/^[0-9a-f]{64}$/),
        deployment: { name: 'SPECTADO', slug: 'spectado' },
        user: { email: 'alice@acme.test', name: 'Alice', kind: 'person' },
        teams: [{ slug: 'design', name: 'Design' }, { slug: 'platform', name: 'Platform' }],
        primary_team: 'platform',
        token: { expires_at: '2027-01-22T10:00:00.000Z', label: 'mac-alice', source: 'device' },
      });
      expect(schemas.collectorConfigResponse.safeParse(body).success).toBe(true);
      expect('company' in body).toBe(false);
      // Stable: every token gets the same deployment salt.
      const other = (await (await get(w.tokens.bob)).json()) as Record<string, unknown>;
      expect(other.project_salt).toBe(body.project_salt);
    });

    it('a manual token without expiry or label, a service user, and a user without teams', async () => {
      const a = (await (await get(w.tokens.alice)).json()) as Record<string, unknown>;
      expect(a.token).toEqual({ expires_at: null, label: null, source: 'manual' });
      const svc = (await (await get(w.tokens.svc)).json()) as Record<string, unknown>;
      expect(svc).toMatchObject({
        user: { email: null, name: 'CI runner', kind: 'service' },
        teams: [{ slug: 'mobile', name: 'Mobile' }],
        primary_team: 'mobile',
        token: { expires_at: '2099-01-01T00:00:00.000Z', label: 'ci', source: 'manual' },
      });
      const nora = (await (await get(w.tokens.nora)).json()) as Record<string, unknown>;
      expect(nora).toMatchObject({ user: { email: 'nora@acme.test', name: 'Nora', kind: 'person' }, teams: [], primary_team: null });
      for (const body of [a, svc, nora]) expect(schemas.collectorConfigResponse.safeParse(body).success).toBe(true);
    });

    it('requires a valid, unexpired user token', async () => {
      expect((await get(null)).status).toBe(401);
      expect((await get(w.tokens.revoked)).status).toBe(401);
      expect((await get(w.tokens.expired)).status).toBe(401);
      expect((await get(w.tokens.alice.replace('aiobs_u_', 'aiobs_c_'))).status).toBe(401);
    });
  });

  describe('patch before turn: KPIs and rollups count one real turn', () => {
    it('counts nothing while only patches and runs exist, then exactly the real turn', async () => {
      // A day no other test writes to, and an own user and team, so other tests' turns do not affect the counts.
      const DAY = '2026-09-20';
      const at = (hms: string) => `${DAY}T${hms}Z`;
      const pat = await owner.run(async (tx) => {
        const teamId = await insertTeam(tx, 'Patch', 'patch');
        const userId = await insertUser(tx, 'pat@patch.test', 'Pat');
        await insertMember(tx, userId, { role: 'admin', primaryTeamId: teamId, teamRole: 'lead' });
        return { teamId, userId, token: await insertToken(tx, userId) };
      });
      const web = connectRole('web');
      const worker = connectRole('worker');
      const filters: Filters = { ...defaultFilters(), range: 'custom', from: DAY, to: DAY };
      const kpis = (mode: 'full' | 'aggregates-only', source: 'raw' | 'rollup') => {
        const viewer: Viewer = { id: pat.userId, role: 'admin', teams: [], deployment: { settings: { individualVisibility: mode } } };
        return withRlsContext(web, { userId: pat.userId, role: 'admin' }, async (tx) =>
          getKpis({ ...(await createQueryContext(tx, viewer, new Date(`${DAY}T23:00:00Z`))), forceSource: source }, filters),
        );
      };
      const turnCount = async () =>
        (await q<{ n: number }>(sql`select count(*)::int n from turns where user_id = ${pat.userId}`))[0]!.n;
      const run = { ...ev.run('pt-1', 'r-1', null, 1, 70), started_at: at('09:01:10'), ended_at: at('09:01:40') } as IngestEventInput;
      const turn = { ...ev.turn('pt-s', 'pt-1', 900, 'success'), started_at: at('09:01:00'), ended_at: at('09:03:00') } as IngestEventInput;

      const early = await post(pat.token, batch([ev.outcome('pt-1', 'failed'), ev.summary('pt-1', 'Patched first'), run]));
      expect(early.body).toMatchObject({ accepted: 3, rejected: [] });
      expect(await turnCount()).toBe(0);
      for (const mode of ['full', 'aggregates-only'] as const) expect((await kpis(mode, 'raw')).turns).toBe(0);
      expect(await recomputeDay(worker, DAY)).toBeNull();

      await post(pat.token, batch([{ ...ev.sessionStart('pt-s', 'github.com/patch/app'), at: at('09:00:00') } as IngestEventInput, turn]));
      expect(await turnCount()).toBe(1);
      expect(await recomputeDay(worker, DAY)).toEqual({ turns: 1, rows: 1 });
      const [roll] = await q<{ turns: number; failed: number; runs: number; input: number }>(sql`select sum(turns)::int turns,
        sum(failed)::int failed, sum(runs)::int runs, sum(input_tokens)::int input from daily_rollups where day = ${DAY}`);
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
      const overwrites = [
        ev.turn('own-s', 'own-t', 1),
        ev.run('own-t', 'own-r', null, 1, 1),
        ev.sessionStart('own-s'),
        { ...ev.sessionStart('own-s'), type: 'session_end', reason: 'x' } as unknown as IngestEventInput,
      ];
      // Another user's rows are invisible to the ingest role (RLS): these find nothing, so they are parked or stored
      // unlinked under bob, and never reach alice's turn.
      const strays = [ev.run('own-t', 'own-r2', null, 1), ev.outcome('own-t', 'failed'), ev.summary('own-t', 'overwritten by bob')];
      const res = await post(w.tokens.bob, batch([...overwrites, ...strays]));
      expect(res.body.accepted).toBe(strays.length);
      expect(res.body.rejected).toHaveLength(overwrites.length);
      expect(res.body.rejected.every((r) => r.reason === OWNED)).toBe(true);

      // Alice re-sends her turn: still hers, bob's parked patches are dropped instead of applied.
      await post(w.tokens.alice, batch([ev.turn('own-s', 'own-t', 111)]));
      expect(await external('turns', 'claude-code:own-t')).toEqual([{ user_id: w.users.alice, input_tokens: 111, summary: null }]);
      expect(await external('runs', 'own-r')).toEqual([{ user_id: w.users.alice }]);
      expect(await external('agent_sessions', 'claude-code:own-s')).toEqual([{ user_id: w.users.alice }]);
      expect(await q(sql`select user_id, turn_id from runs where external_id = 'own-r2'`)).toEqual([{ user_id: w.users.bob, turn_id: null }]);
      expect(await q(sql`select 1 from pending_turn_patches where turn_external_id = 'claude-code:own-t'`)).toEqual([]);
      const [t] = await q(sql`select outcome from turns where external_id = 'claude-code:own-t'`);
      expect(t!.outcome).toBe('success');
    });

    it('the owner can re-send from another token or machine, and an ownerless (pre-ADR-0029) row can be claimed', async () => {
      // Same user through her device token, from another machine.
      const viaDevice = batch([ev.turn('own-s', 'own-t', 222)], { machine: { id: 'ffffffff-7d4b-4c1a-9b5e-3f2d1c0b9a87', os: 'darwin' } });
      expect((await post(w.tokens.device, viaDevice)).body).toMatchObject({ accepted: 1, rejected: [] });
      expect(await external('turns', 'claude-code:own-t')).toEqual([{ user_id: w.users.alice, input_tokens: 222, summary: null }]);

      // An old company-token row has no owner: the first user who sends it claims it.
      await post(w.tokens.alice, batch([ev.turn('claim-s', 'claim-t', 5)]));
      await q(sql`update turns set user_id = null, attribution = 'unverified' where external_id = 'claude-code:claim-t'`);
      await q(sql`update agent_sessions set user_id = null where external_id = 'claude-code:claim-s'`);
      await q(sql`update usage set user_id = null where turn_id = (select id from turns where external_id = 'claude-code:claim-t')`);
      expect((await external('turns', 'claude-code:claim-t'))[0]!.user_id).toBeNull();
      expect((await post(w.tokens.bob, batch([ev.turn('claim-s', 'claim-t', 6)]))).body).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
      expect((await external('turns', 'claude-code:claim-t'))[0]!.user_id).toBe(w.users.bob);
    });

    it('every write claims an ownerless row (patch, title, turn_started, session_end, run, session_start back-fill)', async () => {
      const orphan = async (sid: string, tid: string, rid: string) => {
        await post(w.tokens.alice, batch([ev.turn(sid, tid, 5), ev.run(tid, rid, null, 1)]));
        await q(sql`update turns set user_id = null, attribution = 'unverified' where external_id = ${`claude-code:${tid}`}`);
        await q(sql`update agent_sessions set user_id = null where external_id = ${`claude-code:${sid}`}`);
        await q(sql`update runs set user_id = null where turn_external_id = ${`claude-code:${tid}`}`);
        await q(sql`update usage set user_id = null where turn_id = (select id from turns where external_id = ${`claude-code:${tid}`})
          or run_id in (select id from runs where turn_external_id = ${`claude-code:${tid}`})`);
      };
      const owners = async (sid: string, tid: string) =>
        q(sql`select (select user_id from agent_sessions where external_id = ${`claude-code:${sid}`}) as session,
          (select user_id from turns where external_id = ${`claude-code:${tid}`}) as turn,
          (select attribution from turns where external_id = ${`claude-code:${tid}`}) as attribution`);

      await orphan('cl-1', 'cl-1-t', 'cl-1-r');
      const res = await post(w.tokens.bob, batch([
        ev.summary('cl-1-t', 'claimed by a patch'),
        ev.title('cl-1', 'claimed by a title'),
        ev.turnStarted('cl-1', '2026-10-05T09:10:00Z'),
        ev.run('cl-1-t', 'cl-1-r', null, 1, 9),
      ]));
      expect(res.body).toEqual({ accepted: 4, duplicates: 0, rejected: [] });
      expect(await owners('cl-1', 'cl-1-t')).toEqual([{ session: w.users.bob, turn: w.users.bob, attribution: 'verified' }]);
      expect(await q(sql`select user_id from runs where external_id = 'cl-1-r'`)).toEqual([{ user_id: w.users.bob }]);

      await orphan('cl-2', 'cl-2-t', 'cl-2-r');
      await q(sql`update turns set project_id = null where external_id = 'claude-code:cl-2-t'`);
      const end = { event_id: ulid(), type: 'session_end', harness: 'claude-code', session_id: 'cl-2', reason: 'exit', at: '2026-10-05T09:30:00Z' } as IngestEventInput;
      expect((await post(w.tokens.bob, batch([ev.sessionStart('cl-2', 'github.com/acme/web'), end]))).body).toEqual({ accepted: 2, duplicates: 0, rejected: [] });
      expect(await owners('cl-2', 'cl-2-t')).toEqual([{ session: w.users.bob, turn: w.users.bob, attribution: 'verified' }]);
    });

    it('a turn cannot take over runs another user filed under the same key', async () => {
      await post(w.tokens.alice, batch([ev.run('early-t', 'early-r', null, 1)]));
      // Bob's turn is his own row; alice's run is invisible to him and stays hers, unlinked.
      expect((await post(w.tokens.bob, batch([ev.turn('takeover-s', 'early-t')]))).body).toMatchObject({ accepted: 1, rejected: [] });
      expect(await q(sql`select user_id, turn_id from runs where external_id = 'early-r'`)).toEqual([{ user_id: w.users.alice, turn_id: null }]);
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

  describe('session titles (ADR-0026)', () => {
    const session = (id: string) =>
      q(sql`select user_id, title, title_source from agent_sessions where external_id = ${`claude-code:${id}`}`);
    const parked = (id: string) =>
      q(sql`select user_id, title, title_source from pending_session_patches where session_external_id = ${`claude-code:${id}`}`);

    it('sets the title of a known session; the latest patch wins', async () => {
      await post(w.tokens.alice, batch([ev.sessionStart('ti-s')]));
      expect((await post(w.tokens.alice, batch([ev.title('ti-s', 'Generated name')]))).body).toMatchObject({ accepted: 1, rejected: [] });
      expect(await session('ti-s')).toEqual([{ user_id: w.users.alice, title: 'Generated name', title_source: 'ai' }]);
      await post(w.tokens.alice, batch([ev.title('ti-s', 'My rename', 'custom')]));
      expect(await session('ti-s')).toEqual([{ user_id: w.users.alice, title: 'My rename', title_source: 'custom' }]);
    });

    it('parks a title that arrives before its session (no session created) and applies it when any event creates it', async () => {
      for (const [id, create] of [
        ['ti-early-start', ev.sessionStart('ti-early-start')],
        ['ti-early-turn', ev.turn('ti-early-turn', 'ti-early-turn-t')],
        ['ti-early-ts', ev.turnStarted('ti-early-ts')],
        ['ti-early-end', { ...ev.sessionStart('ti-early-end'), type: 'session_end', reason: 'exit' } as unknown as IngestEventInput],
      ] as const) {
        expect((await post(w.tokens.alice, batch([ev.title(id, `Title of ${id}`)]))).body).toMatchObject({ accepted: 1, rejected: [] });
        expect(await session(id)).toEqual([]);
        expect(await parked(id)).toEqual([{ user_id: w.users.alice, title: `Title of ${id}`, title_source: 'ai' }]);
        expect((await post(w.tokens.alice, batch([create]))).body).toMatchObject({ accepted: 1, rejected: [] });
        expect(await session(id)).toEqual([{ user_id: w.users.alice, title: `Title of ${id}`, title_source: 'ai' }]);
        expect(await parked(id)).toEqual([]);
      }
    });

    it('a title and its session in one batch: the session is applied first', async () => {
      const res = await post(w.tokens.alice, batch([ev.title('ti-same', 'Same batch', 'custom'), ev.sessionStart('ti-same')]));
      expect(res.body).toMatchObject({ accepted: 2, rejected: [] });
      expect(await session('ti-same')).toEqual([{ user_id: w.users.alice, title: 'Same batch', title_source: 'custom' }]);
      expect(await parked('ti-same')).toEqual([]);
    });

    it("another user cannot set or overwrite the title of someone else's session or parked title", async () => {
      await post(w.tokens.alice, batch([ev.sessionStart('ti-own'), ev.title('ti-own', 'Alice', 'custom')]));
      // Alice's session is invisible to bob's token: his title is parked under him and dropped, never applied.
      expect((await post(w.tokens.bob, batch([ev.title('ti-own', 'Bob')]))).body).toMatchObject({ accepted: 1, rejected: [] });
      expect(await session('ti-own')).toEqual([{ user_id: w.users.alice, title: 'Alice', title_source: 'custom' }]);
      await post(w.tokens.alice, batch([ev.sessionStart('ti-own')]));
      expect(await session('ti-own')).toEqual([{ user_id: w.users.alice, title: 'Alice', title_source: 'custom' }]);
      expect(await parked('ti-own')).toEqual([]);

      await post(w.tokens.alice, batch([ev.title('ti-pp', "Alice's parked")]));
      expect((await post(w.tokens.bob, batch([ev.title('ti-pp', 'Bob')]))).body.rejected).toEqual([expect.objectContaining({ reason: OWNED })]);
      // Bob's own session with that key does not inherit Alice's parked title (it is dropped).
      expect((await post(w.tokens.bob, batch([ev.sessionStart('ti-pp')]))).body.accepted).toBe(1);
      expect(await session('ti-pp')).toEqual([{ user_id: w.users.bob, title: null, title_source: null }]);
      expect(await parked('ti-pp')).toEqual([]);
    });

    it('app_ingest cannot read titles or parked title values, nor delete parked titles', async () => {
      await post(w.tokens.alice, batch([ev.title('ti-never', 'Parked')]));
      const denied = (query: ReturnType<typeof sql>) =>
        db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.user_id', ${w.users.alice}, true)`);
          await tx.execute(query);
        });
      const denial = { cause: expect.objectContaining({ code: '42501' }) };
      await expect(denied(sql`select title from agent_sessions`)).rejects.toMatchObject(denial);
      await expect(denied(sql`select title from pending_session_patches`)).rejects.toMatchObject(denial);
      await expect(denied(sql`delete from pending_session_patches`)).rejects.toMatchObject(denial);
    });
  });

  describe('live session status (ADR-0027)', () => {
    const T = (hms: string) => `2026-10-05T${hms}Z`;
    const utc = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ${col}`);
    const live = async (id: string) =>
      (
        await q<{
          current_turn_started_at: string | null;
          last_seen_at: string | null;
          ended_at: string | null;
          end_reason: string | null;
          started_at: string;
        }>(sql`select ${utc('current_turn_started_at')}, ${utc('last_seen_at')}, ${utc('ended_at')}, end_reason,
            ${utc('started_at')}
          from agent_sessions where external_id = ${`claude-code:${id}`}`)
      )[0];
    const turnAt = (sessionId: string, turnId: string, startedAt: string, endedAt: string) =>
      ({ ...ev.turn(sessionId, turnId), started_at: startedAt, ended_at: endedAt }) as IngestEventInput;
    const sessionEnd = (sessionId: string, at: string): IngestEventInput => ({
      event_id: ulid(), type: 'session_end', harness: 'claude-code', session_id: sessionId, reason: 'exit', at,
    });
    const accepted = async (token: string, events: IngestEventInput[]) =>
      expect((await post(token, batch(events))).body).toEqual({ accepted: events.length, duplicates: 0, rejected: [] });

    it('a turn_started marks the session working; its turn (started before the hook) clears it', async () => {
      await accepted(w.tokens.alice, [ev.sessionStart('lv-a')]);
      expect(await live('lv-a')).toMatchObject({ current_turn_started_at: null, last_seen_at: T('09:00:00') });
      await accepted(w.tokens.alice, [ev.turnStarted('lv-a', T('09:01:05'), 'lv-a-t')]);
      expect(await live('lv-a')).toMatchObject({ current_turn_started_at: T('09:01:05'), last_seen_at: T('09:01:05') });
      await accepted(w.tokens.alice, [turnAt('lv-a', 'lv-a-t', T('09:01:00'), T('09:03:00'))]);
      expect(await live('lv-a')).toMatchObject({ current_turn_started_at: null, last_seen_at: T('09:03:00') });
    });

    it('an earlier turn arriving after a newer turn_started does not clear it (separate batches or one)', async () => {
      await accepted(w.tokens.alice, [ev.turnStarted('lv-b1', T('09:05:00'))]);
      await accepted(w.tokens.alice, [turnAt('lv-b1', 'lv-b1-t', T('09:01:00'), T('09:03:00'))]);
      expect(await live('lv-b1')).toMatchObject({ current_turn_started_at: T('09:05:00'), last_seen_at: T('09:05:00') });

      await accepted(w.tokens.alice, [turnAt('lv-b2', 'lv-b2-t', T('09:01:00'), T('09:03:00')), ev.turnStarted('lv-b2', T('09:05:00'))]);
      expect(await live('lv-b2')).toMatchObject({ current_turn_started_at: T('09:05:00'), last_seen_at: T('09:05:00') });
    });

    it('in one batch the turn_started is applied before the turn that ends it', async () => {
      await accepted(w.tokens.alice, [turnAt('lv-c', 'lv-c-t', T('09:04:00'), T('09:06:00')), ev.turnStarted('lv-c', T('09:05:00'))]);
      expect(await live('lv-c')).toMatchObject({ current_turn_started_at: null, last_seen_at: T('09:06:00') });
    });

    it('the newest start wins; a replay is a duplicate with one ledger row per event', async () => {
      const first = ev.turnStarted('lv-d', T('09:05:00'));
      const older = ev.turnStarted('lv-d', T('09:04:00'));
      await accepted(w.tokens.alice, [first]);
      await accepted(w.tokens.alice, [older]);
      expect(await live('lv-d')).toMatchObject({ current_turn_started_at: T('09:05:00'), last_seen_at: T('09:05:00') });

      const ledger = () =>
        q(sql`select event_id, type from ingest_events
          where event_id in (${`${w.users.alice}:${first.event_id}`}, ${`${w.users.alice}:${older.event_id}`}) order by event_id`);
      const before = await ledger();
      expect(before.map((r) => r.type)).toEqual(['turn_started', 'turn_started']);
      expect((await post(w.tokens.alice, batch([older]))).body).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
      expect(await ledger()).toEqual(before);
      expect(await live('lv-d')).toMatchObject({ current_turn_started_at: T('09:05:00') });
    });

    it('creates an unknown session on the fly with its parked title; another user cannot touch it', async () => {
      await accepted(w.tokens.alice, [ev.title('lv-e', 'Parked live')]);
      await accepted(w.tokens.alice, [ev.turnStarted('lv-e', T('09:07:00'))]);
      const created = await live('lv-e');
      expect(created).toEqual({
        current_turn_started_at: T('09:07:00'), last_seen_at: T('09:07:00'), ended_at: null, end_reason: null,
        started_at: T('09:07:00'),
      });
      expect(await q(sql`select user_id, title from agent_sessions where external_id = 'claude-code:lv-e'`)).toEqual([
        { user_id: w.users.alice, title: 'Parked live' },
      ]);

      const res = await post(w.tokens.bob, batch([ev.turnStarted('lv-e', T('09:08:00'))]));
      expect(res.body.rejected).toEqual([expect.objectContaining({ reason: OWNED })]);
      expect(await live('lv-e')).toEqual(created);
    });

    it('session_end clears the turn start; a later turn_started re-opens a resumed session', async () => {
      await accepted(w.tokens.alice, [ev.turnStarted('lv-f', T('09:01:00'))]);
      await accepted(w.tokens.alice, [sessionEnd('lv-f', T('09:10:00'))]);
      expect(await live('lv-f')).toMatchObject({
        current_turn_started_at: null, last_seen_at: T('09:10:00'), ended_at: T('09:10:00'), end_reason: 'exit',
      });
      // A late start from before the end does not re-open it.
      await accepted(w.tokens.alice, [ev.turnStarted('lv-f', T('09:05:00'))]);
      expect(await live('lv-f')).toMatchObject({ ended_at: T('09:10:00'), end_reason: 'exit', last_seen_at: T('09:10:00') });
      // Resume (same session id, no new session_start).
      await accepted(w.tokens.alice, [ev.turnStarted('lv-f', T('09:20:00'))]);
      expect(await live('lv-f')).toMatchObject({
        current_turn_started_at: T('09:20:00'), last_seen_at: T('09:20:00'), ended_at: null, end_reason: null,
      });
    });

    it('an older session_end in the same batch as a resume turn_started does not end the resumed session', async () => {
      await accepted(w.tokens.alice, [ev.turnStarted('lv-resume', T('09:01:00'))]);
      // Backlog flush: the server orders turn_started before session_end, so the older end is applied last.
      await accepted(w.tokens.alice, [ev.turnStarted('lv-resume', T('09:20:00')), sessionEnd('lv-resume', T('09:10:00'))]);
      expect(await live('lv-resume')).toMatchObject({
        current_turn_started_at: T('09:20:00'), last_seen_at: T('09:20:00'), ended_at: null, end_reason: null,
      });
      // A newer end still ends it.
      await accepted(w.tokens.alice, [sessionEnd('lv-resume', T('09:30:00'))]);
      expect(await live('lv-resume')).toMatchObject({
        current_turn_started_at: null, last_seen_at: T('09:30:00'), ended_at: T('09:30:00'), end_reason: 'exit',
      });
    });

    it('last_seen_at ignores runs and patches and is capped at the server clock', async () => {
      await accepted(w.tokens.alice, [
        ev.sessionStart('lv-g'),
        turnAt('lv-g', 'lv-g-t', T('09:01:00'), T('09:03:00')),
        ev.run('lv-g-t', 'lv-g-r', null, 1),
        ev.title('lv-g', 'Live title'),
        ev.summary('lv-g-t', 'Did a thing'),
      ]);
      expect(await live('lv-g')).toMatchObject({ current_turn_started_at: null, last_seen_at: T('09:03:00') });

      const future = new Date(Date.now() + 3_600_000).toISOString();
      await accepted(w.tokens.alice, [ev.turnStarted('lv-g', future)]);
      expect(
        await q(sql`select last_seen_at <= now() as capped, last_seen_at > '2026-10-05T09:03:00Z'::timestamptz as bumped,
            current_turn_started_at = ${future}::timestamptz as raw
          from agent_sessions where external_id = 'claude-code:lv-g'`),
      ).toEqual([{ capped: true, bumped: true, raw: true }]);
    });

    it('rejects a turn_started more than a day in the future', async () => {
      const far = ev.turnStarted('lv-h', new Date(Date.now() + 2 * 86_400_000).toISOString());
      expect((await post(w.tokens.alice, batch([far]))).body).toEqual({
        accepted: 0, duplicates: 0, rejected: [{ event_id: far.event_id, reason: 'timestamp is more than a day in the future' }],
      });
      expect(await live('lv-h')).toBeUndefined();
    });

    it('app_ingest can read the liveness columns and ended_at only', async () => {
      const run = (query: ReturnType<typeof sql>) =>
        db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.user_id', ${w.users.alice}, true)`);
          await tx.execute(query);
        });
      const denial = { cause: expect.objectContaining({ code: '42501' }) };
      await expect(run(sql`select current_turn_started_at, last_seen_at, ended_at from agent_sessions`)).resolves.toBeUndefined();
      await expect(run(sql`select started_at from agent_sessions`)).rejects.toMatchObject(denial);
      await expect(run(sql`select title from agent_sessions`)).rejects.toMatchObject(denial);
    });
  });

  describe('event time window (DP-05, DP-08)', () => {
    const at = (iso: string) => ({ started_at: iso, ended_at: iso });
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

    it("the cutoff follows the deployment's retention setting", async () => {
      expect(timeWindowProblem(ev.turn('x', 'y'), 30, Date.parse('2026-10-06T12:00:00Z'))).toBeNull(); // 2026-10-05: inside 30 days
      const t = { ...ev.turn('x', 'y'), started_at: '2026-09-06T23:59:00Z', ended_at: '2026-09-07T00:01:00Z' } as IngestEventInput;
      // cutoff = 00:00 UTC of 2026-10-06 minus 30 days = 2026-09-06T00:00Z
      expect(timeWindowProblem(t, 30, Date.parse('2026-10-06T12:00:00Z'))).toBeNull();
      expect(timeWindowProblem({ ...t, started_at: '2026-09-05T23:59:00Z' } as IngestEventInput, 30, Date.parse('2026-10-06T12:00:00Z'))).toMatch(/retention/);

      const day = 86_400_000;
      const fortyDaysOld = () => ({ ...ev.turn('win-s', 'win-40'), started_at: new Date(Date.now() - 40 * day).toISOString(), ended_at: new Date(Date.now() - 40 * day).toISOString() }) as IngestEventInput;
      await owner.run((tx) => setSettings(tx, { retentionDays: 30 })); // the minimum
      try {
        expect((await post(w.tokens.alice, batch([fortyDaysOld()]))).body.rejected).toEqual([
          expect.objectContaining({ reason: 'started_at is before the retention window' }),
        ]);
      } finally {
        await owner.run((tx) => setSettings(tx, { retentionDays: 395 }));
      }
      expect((await post(w.tokens.alice, batch([fortyDaysOld()]))).body).toMatchObject({ accepted: 1, rejected: [] });
    });
  });

  describe('user tokens need a live membership (SEC-4, defence in depth)', () => {
    it('stop resolving once the user is no longer a member; their data stays', async () => {
      expect((await post(w.tokens.bob, batch([ev.sessionStart('mem-s')]))).status).toBe(200);
      // Removal deletes the membership (team memberships cascade); bob's identity and data stay (D1).
      await q(sql`delete from memberships where user_id = ${w.users.bob}`);
      expect((await post(w.tokens.bob, batch([ev.sessionStart('mem-s2')]))).status).toBe(401);
      expect(await lookupToken(db, hashToken(w.tokens.bob))).toBeNull();
      expect(await q(sql`select user_id from agent_sessions where external_id = 'claude-code:mem-s'`)).toEqual([{ user_id: w.users.bob }]);
      await owner.run((tx) => insertMember(tx, w.users.bob, { primaryTeamId: w.teams.mobile }));
      expect((await post(w.tokens.bob, batch([ev.sessionStart('mem-s5')]))).status).toBe(200);
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

    it("a stray patch from another user does not freeze the owner's outcome (markers carry the sender)", async () => {
      await post(w.tokens.alice, batch([ev.turn('mk-s', 'mk-t'), ev.turn('mk-s', 'mk-t2')]));
      // Bob cannot see alice's turns: his final patches are parked under him and never applied.
      const stray = await post(w.tokens.bob, batch([patch('mk-t', 'success', false), patch('mk-t2', 'success', false)]));
      expect(stray.body).toMatchObject({ accepted: 2, rejected: [] });
      expect(await q(sql`select event_id from ingest_events where event_id like ${'%:claude-code:mk-t%'} order by event_id`)).toEqual([
        { event_id: `outcome-final:${w.users.bob}:claude-code:mk-t` },
        { event_id: `outcome-final:${w.users.bob}:claude-code:mk-t2` },
        { event_id: `outcome-patch:${w.users.bob}:claude-code:mk-t` },
        { event_id: `outcome-patch:${w.users.bob}:claude-code:mk-t2` },
      ]);
      // Alice's provisional patch still applies, and so does her re-sent turn's outcome.
      expect((await post(w.tokens.alice, batch([patch('mk-t', 'failed', true)]))).body).toMatchObject({ accepted: 1, rejected: [] });
      expect(await outcomeOf('mk-t')).toEqual({ outcome: 'failed', p: true });
      await post(w.tokens.alice, batch([ev.turn('mk-s', 'mk-t2', 1000, 'failed')]));
      expect(await outcomeOf('mk-t2')).toEqual({ outcome: 'failed', p: true });
    });

    it('a marker written before 0018 (no user part) is still honoured', async () => {
      await post(w.tokens.alice, batch([ev.turn('lg-s', 'lg-t')]));
      await q(sql`insert into ingest_events (event_id, type) values ('outcome-patch:claude-code:lg-t', 'marker'),
        ('outcome-final:claude-code:lg-t', 'marker')`);
      await post(w.tokens.alice, batch([ev.turn('lg-s', 'lg-t', 1000, 'failed'), patch('lg-t', 'failed', true)]));
      expect(await outcomeOf('lg-t')).toEqual({ outcome: 'success', p: true });
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
      const a = withIngestContext(db, token.userId, async (tx) => {
        const res = await processBatch(tx, token, runBatch.header, runBatch.events);
        runApplied();
        await gate;
        return res;
      });
      await applied;
      let turnDone = false;
      const b = withIngestContext(db, token.userId, (tx) => processBatch(tx, token, turnBatch.header, turnBatch.events)).then((r) => {
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

    it('takes the session locks of a batch before any turn lock (no deadlock with a concurrent batch, ADR-0026)', async () => {
      const token = (await lookupToken(db, hashToken(w.tokens.alice)))!;
      const first = parsed([ev.turn('lock-s', 'lock-t1')]);
      const second = parsed([ev.turn('lock-s', 'lock-t2')], { machine: { id: 'bbbbbbbb-7d4b-4c1a-9b5e-3f2d1c0b9a87', os: 'linux' } });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let firstApplied!: () => void;
      const applied = new Promise<void>((r) => (firstApplied = r));

      // Transaction A holds the session lock of lock-s and stays open.
      const a = withIngestContext(db, token.userId, async (tx) => {
        const res = await processBatch(tx, token, first.header, first.events);
        firstApplied();
        await gate;
        return res;
      });
      await applied;
      const b = withIngestContext(db, token.userId, (tx) => processBatch(tx, token, second.header, second.events));
      await new Promise((r) => setTimeout(r, 400));
      // B waits for the session lock without holding its turn lock: a batch of A that went on to lock-t2 could not
      // deadlock with it (before, B took turn:lock-t2 first and then waited for the session).
      const turnLock = 'turn:claude-code:lock-t2';
      const [free] = await q(sql`select pg_try_advisory_lock(hashtextextended(${turnLock}, 0)) as free`);
      expect(free).toEqual({ free: true });
      await q(sql`select pg_advisory_unlock(hashtextextended(${turnLock}, 0))`);
      release();
      expect((await Promise.all([a, b])).map((r) => r.accepted)).toEqual([1, 1]);
    });

    it('batchSessionKeys: the sessions a batch writes, once each, sorted', () => {
      const b = parsed([
        ev.turn('k-b', 'k-t1'),
        ev.sessionStart('k-a'),
        ev.turn('k-b', 'k-t2'),
        ev.run('k-t1', 'k-r', null, 1),
        ev.turnStarted('k-c'),
      ]);
      expect(batchSessionKeys(b.events)).toEqual(['claude-code:k-a', 'claude-code:k-b', 'claude-code:k-c']);
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
      const res = await withIngestContext(db, token.userId, (tx) => {
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
      await withIngestContext(db, token.userId, (tx) => {
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

  it("app_ingest cannot write a row for another user (WITH CHECK user_id = app_user())", async () => {
    const write = withIngestContext(db, w.users.bob, (tx) =>
      tx.execute(sql`insert into agent_sessions (user_id, external_id, harness, started_at)
        values (${w.users.alice}, 'claude-code:forged', 'claude-code', now())`),
    );
    await expect(write).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
