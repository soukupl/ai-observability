import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberships, turns, usage, users } from '@ai-obs/db';

import { recomputeDay } from '../../../worker/src/jobs/rollups';
import { defaultFilters, type Filters } from '../../src/lib/filters';
import { addDays, buildExportTable, effectiveRetentionDays, getKpis, getModelsEffort, getTurnDetail, listTurns, loadFilterOptions, resolveRange, type QueryCtx } from '../../src/lib/queries';
import { asPerson, dropShellDatabase, NOW, prepareShellDatabase, seedDeployment, type Fixture, type Person } from './harness';

const skipReason = await prepareShellDatabase();
if (skipReason) console.warn(`[web/shell] query-fix tests skipped: ${skipReason}`);

const f = (over: Partial<Filters> = {}): Filters => ({ ...defaultFilters(), ...over });
const R30 = f({ range: '30d' });
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

describe('DP-04: raw / rollup source honours retention (no database)', () => {
  const now = new Date('2026-10-06T10:00:00Z');
  const custom = (days: number, to = '2026-10-05') => ({ range: 'custom' as const, from: addDays(to, -(days - 1)), to });

  it('a 35-day custom range reads rollups when retention is 30 days', () => {
    expect(resolveRange(custom(35), now).source).toBe('raw'); // retention unknown: unchanged
    expect(resolveRange(custom(35), now, undefined, 30).source).toBe('rollup');
    expect(resolveRange(custom(35), now, undefined, 395).source).toBe('raw');
  });
  it('the edge: a range starting exactly at today - retention is still raw', () => {
    expect(resolveRange({ range: 'custom', from: '2026-09-06', to: '2026-10-05' }, now, undefined, 30).source).toBe('raw');
    expect(resolveRange({ range: 'custom', from: '2026-09-05', to: '2026-10-05' }, now, undefined, 30).source).toBe('rollup');
  });
  it('30d / 7d presets stay raw at 30 days of retention; forceSource still wins', () => {
    expect(resolveRange({ range: '30d', from: null, to: null }, now, undefined, 30).source).toBe('raw');
    expect(resolveRange({ range: '7d', from: null, to: null }, now, 'rollup', 30).source).toBe('rollup');
  });
  it('rawCovers says whether a median can still come from raw rows', () => {
    expect(resolveRange({ range: '90d', from: null, to: null }, now, undefined, 395).rawCovers).toBe(true);
    expect(resolveRange({ range: '90d', from: null, to: null }, now, undefined, 30).rawCovers).toBe(false);
  });
  it('effective retention mirrors the worker: the deployment setting bounded to 30..730 days', () => {
    const v = (retentionDays?: number) =>
      effectiveRetentionDays({ id: 'u', role: 'admin', teams: [], deployment: { settings: { individualVisibility: 'full', retentionDays } } });
    expect(v(395)).toBe(395);
    expect(v(900)).toBe(730);
    expect(v(5)).toBe(30);
    expect(v(90)).toBe(90);
    expect(v(undefined)).toBeNull();
  });
});

describe.skipIf(skipReason !== null)(skipReason ? `query fixes - SKIPPED: ${skipReason}` : 'query fixes (real Postgres)', () => {
  let C: Fixture; // full detail, mixed-model turns
  let D: Fixture; // aggregates-only, mixed-model turns (same data)
  let B: Fixture; // full detail
  let A: Fixture; // aggregates-only
  let E: Fixture; // full detail, 30-day retention already applied: raw rows older than 30 days deleted
  let F: Fixture; // aggregates-only: zero-token usage rows
  let G: Fixture; // aggregates-only: many turns starting at the same instant
  const TIE_COUNT = 700;
  const TIE_AT = new Date('2026-10-05T17:00:00.123456Z');

  beforeAll(async () => {
    A = await seedDeployment('agg-co', 'aggregates-only');
    B = await seedDeployment('full-co', 'full');
    C = await seedDeployment('mixed-full-co', 'full', { mixed: true });
    D = await seedDeployment('mixed-agg-co', 'aggregates-only', { mixed: true });
    E = await seedDeployment('free-co', 'full');
    F = await seedDeployment('zero-co', 'aggregates-only');
    G = await seedDeployment('ties-co', 'aggregates-only');

    // E: the nightly retention job already ran with 30 days of retention (raw rows before today - 30 are gone, rollups stay).
    await E.worker.transaction(async (tx) => {
      const cutoff = '2026-09-05'; // NOW is 2026-10-05
      await tx.execute(sql`delete from usage where started_at < ${cutoff}::timestamptz`);
      await tx.execute(sql`delete from runs where started_at < ${cutoff}::timestamptz`);
      await tx.execute(sql`delete from turns where started_at < ${cutoff}::timestamptz`);
    });

    // F: a model dropped by a re-sent turn leaves a zero-token usage row (app_ingest cannot delete).
    const target = F.turnIds.find((t) => t.userKey === 'm1')!;
    await F.owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      const [t] = await tx.execute(sql`select team_id, user_id, started_at from turns where id = ${target.id}::uuid`) as unknown as { team_id: string; user_id: string; started_at: Date }[];
      await tx.insert(usage).values({
        teamId: t!.team_id, userId: t!.user_id, turnId: target.id, runId: null, startedAt: new Date(t!.started_at),
        model: 'mystery-model-1', effort: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0,
      });
    });
    await recomputeDay(F.worker, new Date(target.startedMs).toISOString().slice(0, 10));

    // G: TIE_COUNT turns that start at the very same microsecond (tokenless, so no usage rows).
    await G.owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      const admin = G.people.admin!;
      const rows: (typeof turns.$inferInsert)[] = [];
      for (let i = 0; i < TIE_COUNT; i++) {
        rows.push({
          id: randomUUID(), teamId: G.teams.t1!, userId: admin.id, attribution: 'verified', externalId: `tie-${i}`, harness: 'claude-code',
          model: 'claude-opus-5-5', effort: 'high', startedAt: TIE_AT, endedAt: new Date(TIE_AT.getTime() + 1000), durationMs: 1000, outcome: 'success', summary: `tie ${i}`,
        });
      }
      for (let i = 0; i < rows.length; i += 200) await tx.insert(turns).values(rows.slice(i, i + 200));
    });
  }, 300_000);
  afterAll(dropShellDatabase);

  const run = <T>(fx: Fixture, who: string, fn: (ctx: QueryCtx) => Promise<T>, tweak?: (p: Person) => Person) =>
    asPerson(tweak ? tweak(fx.people[who]!) : fx.people[who]!, (ctx) => fn(ctx));

  describe('DP-02: per-turn cost is priced per usage row', () => {
    for (const [name, fx] of [['direct path', () => C], ['aggregate path', () => D]] as const) {
      it(`${name}: the turns of the range add up to the KPI cost, mixed-model turns included`, async () => {
        const { turns: list, kpi, csv } = await run(fx(), 'admin', async (ctx) => ({
          turns: await listTurns(ctx, R30, { pageSize: 500 }),
          kpi: await getKpis(ctx, R30),
          csv: await buildExportTable(ctx, 'turns', R30),
        }));
        expect(list.rows).toHaveLength(120);
        expect(kpi.cost.usd).toBeGreaterThan(0);
        expect(sum(list.rows.map((r) => r.cost.usd))).toBeCloseTo(kpi.cost.usd!, 6);
        const col = csv.headers.indexOf('est_cost_usd');
        expect(sum(csv.rows.map((r) => r[col] as number | null))).toBeCloseTo(kpi.cost.usd!, 4);
        // The old rule (all tokens at the primary model) would not add up: haiku sub-agent tokens are priced differently.
        expect(list.rows.some((r) => r.cost.partial)).toBe(true); // the unpriced 'mystery-1' turns stay flagged
      });
    }

    it('a turn without a primary model bill: one opus turn with haiku sub-agent usage costs opus + haiku, not all-opus', async () => {
      const { row, detail } = await run(C, 'admin', async (ctx) => {
        const l = await listTurns(ctx, R30, { pageSize: 500 });
        const r = l.rows.find((x) => x.model === 'claude-opus-5-5' && x.cost.usd !== null)!;
        return { row: r, detail: await getTurnDetail(ctx, r.id) };
      });
      const d = detail!;
      expect(d.usage!.map((u) => u.model).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-5-5']);
      expect(d.turn.cost.usd).toBeCloseTo(sum(d.usage!.map((u) => u.cost.usd)), 9); // header = sum of its own lines
      expect(row.cost.usd).toBeCloseTo(d.turn.cost.usd!, 9); // list = header
      // All-at-primary pricing would give a different number
      const opus = d.usage!.find((u) => u.model === 'claude-opus-5-5')!;
      expect(d.turn.cost.usd).not.toBeCloseTo(opus.cost.usd! * (d.turn.tokens.total / opus.tokens.total), 6);
    });

    it('aggregate path agrees with the direct path turn by turn (identical data)', async () => {
      const key = (r: { startedMs: number; cost: { usd: number | null } }) => [r.startedMs, r.cost.usd === null ? null : Math.round(r.cost.usd * 1e9) / 1e9];
      const direct = (await run(C, 'admin', (ctx) => listTurns(ctx, R30, { pageSize: 500 }))).rows.map(key);
      const agg = (await run(D, 'admin', (ctx) => listTurns(ctx, R30, { pageSize: 500 }))).rows.map(key);
      expect(agg).toEqual(direct);
    });

    it("another person's turn seen through the aggregate functions has the same cost as the direct path", async () => {
      const other = D.turnIds.find((t) => t.userKey === 'm1')!;
      const viaAgg = await run(D, 'admin', (ctx) => getTurnDetail(ctx, other.id, other.startedMs));
      const sameInC = C.turnIds.find((t) => t.userKey === 'm1' && t.startedMs === other.startedMs)!;
      const viaDirect = await run(C, 'admin', (ctx) => getTurnDetail(ctx, sameInC.id));
      expect(viaAgg!.limited).toBe(true);
      expect(viaAgg!.turn.cost.usd).toBeCloseTo(viaDirect!.turn.cost.usd!, 9);
    });
  });

  describe('DP-04: retention-aware source choice', () => {
    const short = (p: Person): Person => ({ ...p, deployment: { settings: { individualVisibility: 'full', retentionDays: 30 } } });
    const range35 = f({ range: 'custom', from: '2026-09-01', to: '2026-10-05' });

    it('a deployment with 30 days of retention reads a 35-day custom range from rollups, so raw rows already deleted are not missed', async () => {
      const auto = await run(E, 'admin', (ctx) => getKpis(ctx, range35), short);
      const raw = await run(E, 'admin', (ctx) => getKpis({ ...ctx, forceSource: 'raw' }, range35), short);
      const roll = await run(E, 'admin', (ctx) => getKpis({ ...ctx, forceSource: 'rollup' }, range35), short);
      expect(raw.turns).toBe(31 * 4); // the 4 days before the cut-off are gone from raw
      expect(roll.turns).toBe(35 * 4);
      expect(auto.range.source).toBe('rollup');
      expect(auto.turns).toBe(roll.turns);
      expect(auto.tokens).toEqual(roll.tokens);
    });

    it('a deployment with long retention keeps reading raw rows', async () => {
      const k = await run(B, 'admin', (ctx) => getKpis(ctx, range35), (p) => ({ ...p, deployment: { settings: { individualVisibility: 'full', retentionDays: 395 } } }));
      expect(k.range.source).toBe('raw');
      expect(k.turns).toBe(35 * 4);
    });

    it('createQueryContext derives the retention from the deployment setting', async () => {
      expect(await run(E, 'admin', async (ctx) => ctx.retentionDays, short)).toBe(30);
      expect(await run(E, 'admin', async (ctx) => ctx.retentionDays)).toBeUndefined();
    });
  });

  describe('DP-10: zero-token usage rows', () => {
    const modelsOf = (r: { rows: { model: string | null }[] }) => r.rows.map((x) => x.model);
    for (const [name, who, src] of [
      ['aggregate path, raw', 'admin', 'raw'],
      ['direct path (member), raw', 'm1', 'raw'],
      ['rollups', 'admin', 'rollup'],
    ] as const) {
      it(`${name}: no unknown-model flag and no phantom model row`, async () => {
        const { k, m } = await run(F, who, async (ctx) => {
          const c = { ...ctx, forceSource: src } as QueryCtx;
          return { k: await getKpis(c, R30), m: await getModelsEffort(c, R30) };
        });
        // the fixture's own unpriced model (mystery-1, m2's turns) stays flagged for the admin; the zero row never is
        expect(k.cost.unknownModels).toEqual(who === 'admin' ? ['mystery-1'] : []);
        expect(k.cost.partial).toBe(who === 'admin');
        expect(modelsOf(m)).not.toContain('mystery-model-1');
      });
    }
  });

  describe('DP-11: turns export', () => {
    it('is complete under the cap: every turn once, no marker row', async () => {
      for (const [fx, who] of [[B, 'admin'], [A, 'admin']] as const) {
        const t = await run(fx, who, (ctx) => buildExportTable(ctx, 'turns', R30));
        expect(t.truncated).toBe(false);
        expect(t.rows).toHaveLength(120);
      }
    });

    for (const [name, fx] of [['direct path', () => B], ['aggregate path', () => A]] as const) {
      it(`${name}: over the cap it says so (flag + marker row) and keeps the newest turns`, async () => {
        const full = await run(fx(), 'admin', (ctx) => buildExportTable(ctx, 'turns', R30));
        const t = await run(fx(), 'admin', (ctx) => buildExportTable(ctx, 'turns', R30, { maxRows: 50 }));
        expect(t.truncated).toBe(true);
        expect(t.rows).toHaveLength(51);
        expect(String(t.rows[50]![0])).toMatch(/^TRUNCATED: only the newest 50 turns/);
        expect(t.rows.slice(0, 50)).toEqual(full.rows.slice(0, 50));
      });
    }

    it('aggregate path: turns that start at the same instant are neither repeated nor skipped across pages', { timeout: 60_000 }, async () => {
      const t = await run(G, 'admin', (ctx) => buildExportTable(ctx, 'turns', R30));
      expect(t.truncated).toBe(false);
      expect(t.rows).toHaveLength(120 + TIE_COUNT);
      const summaries = t.rows.map((r) => r[t.headers.indexOf('summary')]).filter((s) => String(s).startsWith('tie '));
      expect(new Set(summaries).size).toBe(TIE_COUNT);
    });

    it('tied turns still get a cost (fallback) and nothing throws', { timeout: 60_000 }, async () => {
      const l = await run(G, 'admin', (ctx) => listTurns(ctx, R30, { pageSize: 500 }));
      expect(l.rows.slice(0, TIE_COUNT > 500 ? 500 : TIE_COUNT).every((r) => r.cost.usd === 0)).toBe(true);
    });
  });

  describe('DP-C3: median turn duration on long ranges', () => {
    const R90 = f({ range: '90d' });
    for (const [name, fx] of [['direct path', () => B], ['aggregate path', () => A]] as const) {
      it(`${name}: a 90-day range (rollups) still has a median, equal to the raw one`, async () => {
        const auto = await run(fx(), 'admin', (ctx) => getKpis(ctx, R90));
        const raw = await run(fx(), 'admin', (ctx) => getKpis({ ...ctx, forceSource: 'raw' }, R90));
        expect(auto.range.source).toBe('rollup');
        expect(auto.medianAvailable).toBe(true);
        expect(auto.medianDurationMs).toBeGreaterThan(0);
        expect(auto.medianDurationMs).toBe(raw.medianDurationMs);
        expect(auto.medianApproximate).toBe(false);
        expect(auto.approximate).toBe(false);
      });
      it(`${name}: the models view has per-model medians on a long range`, async () => {
        const auto = await run(fx(), 'admin', (ctx) => getModelsEffort(ctx, R90));
        const raw = await run(fx(), 'admin', (ctx) => getModelsEffort({ ...ctx, forceSource: 'raw' }, R90));
        expect(auto.medianAvailable).toBe(true);
        const med = (r: typeof auto) => r.rows.filter((x) => x.turns > 0).map((x) => [x.model, x.effort, x.medianDurationMs]).sort();
        expect(med(auto)).toEqual(med(raw));
        expect(auto.rows.some((x) => x.medianDurationMs !== null)).toBe(true);
      });
    }

    it('past the retention window it falls back to n/a', async () => {
      const free = (p: Person): Person => ({ ...p, deployment: { settings: { individualVisibility: 'full', retentionDays: 30 } } });
      const k = await run(E, 'admin', (ctx) => getKpis(ctx, R90), free);
      expect(k.range.source).toBe('rollup');
      expect(k.medianAvailable).toBe(false);
      expect(k.medianDurationMs).toBeNull();
      expect((await run(E, 'admin', (ctx) => getModelsEffort(ctx, R90), free)).medianAvailable).toBe(false);
    });

    it('a forced rollup source stays pure (no median)', async () => {
      const k = await run(B, 'admin', (ctx) => getKpis({ ...ctx, forceSource: 'rollup' }, R30));
      expect(k.medianAvailable).toBe(false);
    });
  });

  describe('known issue: lead filter options', () => {
    it('a lead only gets people of the teams they lead (and themselves); an admin gets everyone', async () => {
      const lead = await run(B, 'lead', (ctx) => loadFilterOptions(ctx));
      expect(lead.users?.map((u) => u.name).sort()).toEqual(['admin', 'lead', 'm1']); // m2 is in team 2
      const admin = await run(B, 'admin', (ctx) => loadFilterOptions(ctx));
      expect(admin.users?.map((u) => u.name).sort()).toEqual(['admin', 'lead', 'm1', 'm2']);
    });
  });

  describe('memberships (ADR-0028, ADR-0022 D1)', () => {
    let M: Fixture;
    let serviceId: string;
    beforeAll(async () => {
      M = await seedDeployment('members', 'full');
      await M.owner.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        // m1 is removed: the membership goes, the turns stay (D1).
        await tx.execute(sql`delete from memberships where user_id = ${M.people.m1!.id}::uuid`);
        // One of the admin's turns has no team (unmapped project, no primary team).
        await tx.execute(sql`update turns set team_id = null where id = ${M.turnIds.find((t) => t.userKey === 'admin')!.id}::uuid`);
        // A service user (Q9): no e-mail, a name and a primary team.
        const [svc] = await tx.insert(users).values({ kind: 'service', name: 'ci-bot' }).returning({ id: users.id });
        serviceId = svc!.id;
        await tx.insert(memberships).values({ userId: serviceId, role: 'member', primaryTeamId: M.teams.t2! });
        await tx.insert(turns).values({
          teamId: M.teams.t2!, userId: serviceId, attribution: 'verified', externalId: 'svc-1', harness: 'claude-code', model: 'claude-opus-5-5',
          startedAt: new Date('2026-10-05T08:00:00Z'), endedAt: new Date('2026-10-05T08:01:00Z'), durationMs: 60_000, outcome: 'success', summary: 'ci run',
        });
      });
    }, 300_000);

    it('listUsers reads the current memberships: removed members are gone, service users are marked', async () => {
      const all = (await asPerson(M.people.admin!, (ctx) => loadFilterOptions(ctx))).users;
      expect(all?.map((u) => u.name).sort()).toEqual(['admin', 'ci-bot (service)', 'lead', 'm2']);
      expect(all?.find((u) => u.name === 'ci-bot (service)')?.id).toBe(serviceId);
    });

    it('a service user\'s turns carry the "(service)" label, in the list, the detail and the CSV', async () => {
      const r = await asPerson(M.people.admin!, (ctx) => listTurns(ctx, f({ range: '30d' }), { pageSize: 500 }));
      const svc = r.rows.filter((x) => x.userId === serviceId);
      expect(svc.map((x) => x.userName)).toEqual(['ci-bot (service)']);
      const d = await asPerson(M.people.admin!, (ctx) => getTurnDetail(ctx, svc[0]!.id));
      expect(d?.turn.userName).toBe('ci-bot (service)');
      const csv = await asPerson(M.people.admin!, (ctx) => buildExportTable(ctx, 'turns', f({ range: '30d' })));
      expect(csv.rows.some((row) => row.includes('ci-bot (service)'))).toBe(true);
    });

    it('a lead gets members of the teams they lead through the membership primary team', async () => {
      const lead = (await asPerson(M.people.lead!, (ctx) => loadFilterOptions(ctx))).users?.map((u) => u.name).sort();
      expect(lead).toEqual(['admin', 'lead']); // m1 (removed) is gone; m2 and the service user are in team 2
    });

    it('keeps a removed member\'s turns, with no name; a turn without a team is "No team"', async () => {
      const r = await asPerson(M.people.admin!, (ctx) => listTurns(ctx, f({ range: '30d' }), { pageSize: 500 }));
      const removed = r.rows.filter((x) => x.userId === M.people.m1!.id);
      expect(removed.length).toBeGreaterThan(0);
      expect(removed.every((x) => x.userName == null)).toBe(true);
      expect(r.rows.some((x) => x.teamId === null && x.teamName === 'No team')).toBe(true);
    });

    it('a current member without a name (magic-link invitee) is shown by e-mail, never as a former member', async () => {
      const lead = M.people.lead!;
      const setName = (name: string | null) => M.owner.transaction(async (tx) => {
        await tx.execute(sql`set local role app_definer`);
        await tx.execute(sql`update users set name = ${name} where id = ${lead.id}::uuid`);
      });
      await setName(null);
      try {
        const r = await asPerson(M.people.admin!, (ctx) => listTurns(ctx, f({ range: '30d' }), { pageSize: 500 }));
        const own = r.rows.filter((x) => x.userId === lead.id);
        expect(own.length).toBeGreaterThan(0);
        expect(own.every((x) => x.userName === lead.email)).toBe(true);
        const d = await asPerson(M.people.admin!, (ctx) => getTurnDetail(ctx, own[0]!.id));
        expect(d?.turn.userName).toBe(lead.email);
      } finally {
        await setName('lead');
      }
    });
  });
});

void NOW;
