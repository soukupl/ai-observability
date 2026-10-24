import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MERGE_SETTINGS, MergeAbort, mergeCompanies, parseMergeArgs } from '../src/merge-companies.js';

/**
 * The one-off dev merge (brief "single-deployment-per-user-tokens", Appendix G) on a four-company fixture at the
 * 0017 schema that mirrors the dev DB: acme (Mobile, Platform), globex (a second "Platform"), spectado (SPECTADO,
 * PLAY.cz), plg (PLG); alice in acme + globex, the owner in spectado + plg; one machine and one project key shared by
 * spectado and plg; a company-less super admin and platform audit rows.
 */
const TEST_URL = process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_merge_test';
const dbName = new URL(TEST_URL).pathname.slice(1);
const adminUrl = new URL(TEST_URL);
adminUrl.pathname = '/postgres';

async function prepare(): Promise<string | null> {
  if (!/_test$/.test(dbName)) return `refusing to reset database "${dbName}" (name must end in _test)`;
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await admin`select 1`;
    await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
    await admin.unsafe(`create database "${dbName}"`);
    return null;
  } catch (err) {
    return `Postgres not reachable (${(err as { code?: string }).code || (err as Error).message})`;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}

/**
 * Same as ./migrate-to.ts but without the Drizzle schema: the merge targets the 0017 schema, so the test must not
 * depend on the schema TS (which moves on with migration 0018). Model prices are irrelevant here.
 */
async function migrateTo0017(url: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-obs-merge-'));
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    cpSync(fileURLToPath(new URL('../migrations', import.meta.url)), dir, { recursive: true });
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const last = journal.entries.findIndex((e) => e.tag === '0017_live_session_status');
    if (last < 0) throw new Error('no migration tagged 0017_live_session_status');
    journal.entries = journal.entries.slice(0, last + 1);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(drizzle(client), { migrationsFolder: dir });
  } finally {
    await client.end({ timeout: 1 });
    rmSync(dir, { recursive: true, force: true });
  }
}

const skip = await prepare();
const SETTINGS = { individualVisibility: 'full', retentionDays: 395, runawayCostUsd: 20, projectNaming: 'plain' } as const;
const OPTS = { survivor: 'spectado-c7faa0', name: 'SPECTADO', slug: 'spectado', settings: SETTINGS };
const quiet = () => {};

describe('parseMergeArgs', () => {
  it('reads the flags, skips pnpm\'s "--" and defaults the settings to the brief values', () => {
    const { url, options } = parseMergeArgs(['--', '--survivor', 'spectado-c7faa0', '--name=SPECTADO', '--slug', 'spectado', '--dry-run']);
    expect(url).toBeUndefined();
    expect(options).toEqual({ survivor: 'spectado-c7faa0', name: 'SPECTADO', slug: 'spectado', settings: DEFAULT_MERGE_SETTINGS, dryRun: true });
    expect(DEFAULT_MERGE_SETTINGS).toEqual(SETTINGS);
  });
  it('lets flags override the settings and rejects bad input', () => {
    const { options } = parseMergeArgs(['--survivor', 'a', '--name', 'A', '--slug', 'a', '--retention-days', '400', '--visibility', 'aggregates-only']);
    expect(options.settings).toMatchObject({ retentionDays: 400, individualVisibility: 'aggregates-only', runawayCostUsd: 20 });
    expect(options.dryRun).toBe(false);
    expect(() => parseMergeArgs(['--survivor', 'a'])).toThrow(MergeAbort);
    expect(() => parseMergeArgs(['--survivor', 'a', '--name', 'A', '--slug', 'a', '--bogus', '1'])).toThrow(/unknown flag/);
  });
});

describe.skipIf(skip !== null)(skip ? `merge-companies - SKIPPED: ${skip}` : 'merge-companies (real Postgres, 0017 schema)', () => {
  let sql: Sql;
  const id: Record<string, string> = {};

  const definer = <T>(fn: (tx: TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx`set local role app_definer`;
      return fn(tx);
    }) as Promise<T>;
  const one = async (q: Promise<readonly { id: string }[]> | postgres.PendingQuery<postgres.Row[]>) => ((await q) as unknown as { id: string }[])[0]!.id;

  const allCounts = () =>
    definer(async (tx) => {
      const tables = await tx<{ t: string }[]>`select relname as t from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`;
      const out: Record<string, number> = {};
      for (const { t } of tables) out[t] = (await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from "${t}"`))[0]!.n;
      return out;
    });
  const fkCount = async () =>
    (await sql<{ n: number }[]>`select count(*)::int as n from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`)[0]!.n;

  beforeAll(async () => {
    await migrateTo0017(TEST_URL);
    sql = postgres(TEST_URL, { max: 1, onnotice: () => {} });
    await definer(async (tx) => {
      const co = async (name: string, slug: string, created: string) =>
        one(tx`insert into companies (name, slug, plan, settings, created_at) values (${name}, ${slug}, 'team',
          ${tx.json({ individualVisibility: 'aggregates-only', retentionDays: 30, projectNaming: 'plain', runawayHours: 2 })}, ${created}) returning id`);
      id.acme = await co('Acme', 'acme', '2026-10-08T18:00:00Z');
      id.globex = await co('Globex', 'globex', '2026-10-08T18:00:01Z');
      id.spectado = await co('SPECTADO', 'spectado-c7faa0', '2026-10-08T18:08:00Z');
      id.plg = await co('PLG', 'plg-eb2d65', '2026-10-08T18:11:00Z');

      const team = async (c: string, name: string) => one(tx`insert into teams (company_id, name) values (${id[c]!}, ${name}) returning id`);
      id.mobile = await team('acme', 'Mobile');
      id.platform = await team('acme', 'Platform');
      id.gPlatform = await team('globex', 'Platform'); // duplicate name -> "Platform (Globex)"
      id.spectadoTeam = await team('spectado', 'SPECTADO');
      id.play = await team('spectado', 'PLAY.cz');
      id.plgTeam = await team('plg', 'PLG');

      const user = async (email: string, superAdmin = false) =>
        one(tx`insert into users (email, name, is_super_admin) values (${email}, ${email.split('@')[0]!}, ${superAdmin}) returning id`);
      id.alice = await user('alice@acme.example');
      id.bob = await user('bob@acme.example');
      id.gina = await user('gina@globex.example');
      id.owner = await user('owner@gmail.example');
      id.tp = await user('owner@ticketportal.example');
      id.root = await user('admin@example.com', true);

      const member = async (c: string, u: string, role: 'admin' | 'member', primary: string, teamRole: 'lead' | 'member' = 'member') => {
        await tx`insert into company_memberships (company_id, user_id, company_role, primary_team_id, last_active_at)
          values (${id[c]!}, ${id[u]!}, ${role}, ${id[primary]!}, ${'2026-10-1' + (role === 'admin' ? '2' : '0') + 'T00:00:00Z'})`;
        await tx`insert into team_memberships (company_id, team_id, user_id, role) values (${id[c]!}, ${id[primary]!}, ${id[u]!}, ${teamRole})`;
      };
      await member('acme', 'alice', 'admin', 'platform', 'lead');
      await member('globex', 'alice', 'member', 'gPlatform');
      await member('acme', 'bob', 'member', 'mobile');
      await member('globex', 'gina', 'admin', 'gPlatform', 'lead');
      await member('spectado', 'owner', 'admin', 'spectadoTeam', 'lead');
      await member('plg', 'owner', 'member', 'plgTeam');
      await member('plg', 'tp', 'admin', 'plgTeam', 'lead');
      await tx`insert into team_memberships (company_id, team_id, user_id, role) values (${id.spectado!}, ${id.play!}, ${id.owner!}, 'member')`;

      // The shared machine and the shared project key (spectado + plg).
      const machine = async (c: string, u: string, first: string, last: string) =>
        one(tx`insert into machines (company_id, user_id, machine_id, os, first_seen_at, last_seen_at)
          values (${id[c]!}, ${id[u]!}, 'mach-shared', ${c === 'plg' ? 'darwin' : null}, ${first}, ${last}) returning id`);
      id.mSpectado = await machine('spectado', 'owner', '2026-10-09T00:00:00Z', '2026-10-15T00:00:00Z');
      id.mPlg = await machine('plg', 'tp', '2026-10-08T00:00:00Z', '2026-10-20T00:00:00Z');
      id.mAcme = await one(tx`insert into machines (company_id, user_id, machine_id) values (${id.acme!}, ${id.alice!}, 'mach-alice') returning id`);
      const project = async (c: string, key: string, teamId: string | null) =>
        one(tx`insert into projects (company_id, key, team_id) values (${id[c]!}, ${key}, ${teamId}) returning id`);
      id.pSpectado = await project('spectado', 'web', null);
      id.pPlg = await project('plg', 'web', id.plgTeam!);
      id.pAcme = await project('acme', 'acme-app', id.platform!);

      // Sessions, turns, runs, usage, alerts, flags, links.
      let n = 0;
      const turn = async (c: string, u: string, teamKey: string, projectKey: string, machineKey: string, day: string) => {
        n += 1;
        const s = await one(tx`insert into agent_sessions (company_id, user_id, team_id, machine_id, project_id, external_id, harness, started_at)
          values (${id[c]!}, ${id[u]!}, ${id[teamKey]!}, ${id[machineKey]!}, ${id[projectKey]!}, ${'sess-' + n}, 'claude-code', ${day}) returning id`);
        const t = await one(tx`insert into turns (company_id, user_id, team_id, attribution, session_id, project_id, external_id, harness, model,
            started_at, ended_at, input_tokens, output_tokens)
          values (${id[c]!}, ${id[u]!}, ${id[teamKey]!}, 'verified', ${s}, ${id[projectKey]!}, ${'turn-' + n}, 'claude-code', 'claude-opus',
            ${day}, ${day}, ${100 * n}, ${10 * n}) returning id`);
        const r = await one(tx`insert into runs (company_id, user_id, team_id, turn_id, turn_external_id, external_id, agent_type, started_at, ended_at)
          values (${id[c]!}, ${id[u]!}, ${id[teamKey]!}, ${t}, ${'turn-' + n}, 'main', 'main', ${day}, ${day}) returning id`);
        await tx`insert into usage (company_id, user_id, team_id, turn_id, started_at, model, input_tokens, output_tokens, requests)
          values (${id[c]!}, ${id[u]!}, ${id[teamKey]!}, ${t}, ${day}, 'claude-opus', ${100 * n}, ${10 * n}, 1)`;
        await tx`insert into usage (company_id, user_id, team_id, run_id, started_at, model, input_tokens, requests)
          values (${id[c]!}, ${id[u]!}, ${id[teamKey]!}, ${r}, ${day}, 'claude-haiku', ${n}, 1)`;
        return { t, r };
      };
      const day = '2026-10-15T10:00:00Z';
      id.aliceAcme = (await turn('acme', 'alice', 'platform', 'pAcme', 'mAcme', day)).t;
      await turn('globex', 'alice', 'gPlatform', 'pAcme', 'mAcme', day); // pAcme is acme's: only a cross-tenant pointer for the fixture
      await turn('globex', 'alice', 'gPlatform', 'pAcme', 'mAcme', day);
      await turn('acme', 'bob', 'mobile', 'pAcme', 'mAcme', day);
      const own1 = await turn('spectado', 'owner', 'spectadoTeam', 'pSpectado', 'mSpectado', day);
      await turn('spectado', 'owner', 'play', 'pSpectado', 'mSpectado', day);
      await turn('spectado', 'owner', 'spectadoTeam', 'pSpectado', 'mSpectado', day);
      const plg1 = await turn('plg', 'owner', 'plgTeam', 'pPlg', 'mPlg', day);
      await turn('plg', 'tp', 'plgTeam', 'pPlg', 'mPlg', day);
      await turn('plg', 'tp', 'plgTeam', 'pPlg', 'mPlg', day);

      await tx`insert into runaway_alerts (company_id, turn_id, team_id, user_id, project_id, harness, started_at, reasons)
        values (${id.plg!}, ${plg1.t}, ${id.plgTeam!}, ${id.owner!}, ${id.pPlg!}, 'claude-code', ${day}, '[]'),
               (${id.spectado!}, ${own1.t}, ${id.spectadoTeam!}, ${id.owner!}, ${id.pSpectado!}, 'claude-code', ${day}, '[]')`;
      await tx`insert into flow_flags (company_id, user_id, turn_id, flow_key, flow_name)
        values (${id.plg!}, ${id.owner!}, ${plg1.t}, 'wf:1', 'Flow'), (${id.acme!}, ${id.alice!}, ${id.aliceAcme!}, 'wf:2', 'Flow 2')`;
      await tx`insert into run_links (company_id, turn_id, turn_external_id, from_run_id, to_run_id, from_external_id, to_external_id, kind)
        values (${id.plg!}, ${plg1.t}, 'turn-8', ${plg1.r}, ${plg1.r}, 'main', 'main', 'sequence')`;

      // Rollups: a row per company for the same day and dimensions, two pointing at the shared project key.
      const rollup = async (c: string, teamKey: string, u: string, projectKey: string, turns: number) => {
        await tx`insert into daily_rollups (company_id, day, team_id, user_id, project_id, harness, model, turns, input_tokens)
          values (${id[c]!}, '2026-10-15', ${id[teamKey]!}, ${id[u]!}, ${id[projectKey]!}, 'claude-code', 'claude-opus', ${turns}, ${turns * 1000})`;
        await tx`insert into daily_skill_mcp_rollups (company_id, day, team_id, user_id, project_id, harness, model, kind, name, calls, turns)
          values (${id[c]!}, '2026-10-15', ${id[teamKey]!}, ${id[u]!}, ${id[projectKey]!}, 'claude-code', 'claude-opus', 'skill', 'adr', ${turns}, ${turns})`;
      };
      await rollup('spectado', 'spectadoTeam', 'owner', 'pSpectado', 3);
      await rollup('plg', 'plgTeam', 'owner', 'pPlg', 1);
      await rollup('acme', 'platform', 'alice', 'pAcme', 2);

      // Tokens, budgets, invitations, audit, ingest events, pending patches, auth sessions.
      await tx`insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
        values (${id.spectado!}, ${id.owner!}, 'user', 'mac', 'aiobs_u_a', 'h1', ${id.owner!}),
               (${id.plg!}, ${id.tp!}, 'user', 'mac', 'aiobs_u_b', 'h2', ${id.tp!})`;
      await tx`insert into ingest_tokens (company_id, kind, name, prefix, hash, revoked_at)
        values (${id.acme!}, 'company', 'ci', 'aiobs_c_c', 'h3', now())`;
      await tx`insert into budgets (company_id, team_id, kind, limit_value) values (${id.plg!}, ${id.plgTeam!}, 'cost', 100)`;
      await tx`insert into budgets (company_id, user_id, kind, limit_value) values (${id.globex!}, ${id.alice!}, 'tokens', 1000000)`;
      await tx`insert into invitations (company_id, email, team_id, expires_at, invited_by_user_id)
        values (${id.acme!}, 'new@acme.example', ${id.mobile!}, now() + interval '7 days', ${id.alice!}),
               (${id.plg!}, 'new@plg.example', ${id.plgTeam!}, now() + interval '7 days', ${id.tp!})`;
      await tx`insert into audit_log (company_id, actor_user_id, action) values
        (${id.acme!}, ${id.alice!}, 'member.invite'), (${id.plg!}, ${id.tp!}, 'token.create'),
        (null, ${id.root!}, 'platform.company.create'), (null, ${id.root!}, 'platform.plan.change')`;
      await tx`insert into ingest_events (company_id, event_id, type, received_at) values
        (${id.spectado!}, 'ev-dup', 'turn', '2026-10-15T00:00:00Z'), (${id.plg!}, 'ev-dup', 'turn', '2026-10-14T00:00:00Z'),
        (${id.plg!}, 'ev-2', 'turn', now()), (${id.acme!}, 'ev-3', 'turn', now())`;
      await tx`insert into pending_turn_patches (company_id, turn_external_id, summary, received_at, user_id) values
        (${id.spectado!}, 'turn-late', 'old', '2026-10-15T00:00:00Z', ${id.owner!}),
        (${id.plg!}, 'turn-late', 'new', '2026-10-16T00:00:00Z', ${id.owner!}),
        (${id.acme!}, 'turn-other', 'x', now(), ${id.alice!})`;
      await tx`insert into pending_session_patches (company_id, session_external_id, title, title_source) values
        (${id.plg!}, 'sess-late', 'Title', 'ai')`;
      await tx`insert into auth_sessions (user_id, token_hash, expires_at, active_company_id) values
        (${id.owner!}, 'sess-a', now() + interval '1 day', ${id.plg!}),
        (${id.alice!}, 'sess-b', now() + interval '1 day', ${id.globex!}),
        (${id.root!}, 'sess-root', now() + interval '1 day', null)`;
    });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
  });

  it('refuses when the survivor is missing', async () => {
    await expect(mergeCompanies(TEST_URL, { ...OPTS, survivor: 'nope', log: quiet })).rejects.toThrow(/survivor "nope" not found/);
  });

  it('aborts on a duplicate external id and changes nothing', async () => {
    const before = await allCounts();
    const fks = await fkCount();
    await definer((tx) => tx`insert into turns (company_id, attribution, external_id, harness, started_at, ended_at)
      values (${id.acme!}, 'unverified', 'turn-5', 'codex', now(), now())`); // turn-5 already exists in spectado
    await expect(mergeCompanies(TEST_URL, { ...OPTS, log: quiet })).rejects.toThrow(/duplicate external id across companies in turns .*turn-5/);
    expect(await allCounts()).toEqual({ ...before, turns: before.turns! + 1 });
    expect(await fkCount()).toBe(fks);
    await definer((tx) => tx`delete from turns where company_id = ${id.acme!} and external_id = 'turn-5'`);
  });

  it('a dry run reports the merge and rolls it back', async () => {
    const before = await allCounts();
    const fks = await fkCount();
    const lines: string[] = [];
    const report = await mergeCompanies(TEST_URL, { ...OPTS, dryRun: true, log: (l) => lines.push(l) });
    expect(report.dryRun).toBe(true);
    expect(report.after.companies).toBe(1);
    expect(lines.at(-1)).toMatch(/rolled back/);
    expect(lines.some((l) => /^\[dry run\] merged 3 companies/.test(l))).toBe(true);
    expect(await allCounts()).toEqual(before);
    expect(await fkCount()).toBe(fks);
  });

  it('merges the four companies into SPECTADO', async () => {
    const before = await allCounts();
    const fks = await fkCount();
    const lines: string[] = [];
    const report = await mergeCompanies(TEST_URL, { ...OPTS, log: (l) => lines.push(l) });
    const after = await allCounts();
    expect(report.after).toEqual(after);
    expect(lines.some((l) => /^companies\s+4\s+1\s+-3$/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^merged 3 companies \(acme, globex, plg-eb2d65\) into SPECTADO \(spectado\): 6 teams/);

    // Counts: preserved except where a rule collapses or deletes rows.
    const changed = Object.fromEntries(Object.keys(before).filter((t) => before[t] !== after[t]).map((t) => [t, after[t]! - before[t]!]));
    expect(changed).toEqual({
      companies: -3,
      company_memberships: -2, // alice, owner
      machines: -1,
      projects: -1,
      ingest_events: -1,
      pending_turn_patches: -1,
      audit_log: -1, // -2 platform rows, +1 merge audit row
      users: -1, // the super admin
      auth_sessions: -1, // the super admin's session
    });
    expect(await fkCount()).toBe(fks);

    const rows = await definer(async (tx) => ({
      companies: await tx`select id, name, slug, settings from companies`,
      teams: await tx`select name, company_id from teams order by name`,
      memberships: await tx`select u.email, m.company_role, t.name as primary_team, m.last_active_at
        from company_memberships m join users u on u.id = m.user_id left join teams t on t.id = m.primary_team_id order by u.email`,
      machines: await tx`select id, user_id, os, first_seen_at, last_seen_at from machines where machine_id = 'mach-shared'`,
      sessionsOnMachine: await tx`select count(*)::int as n from agent_sessions where machine_id = ${id.mSpectado!}`,
      projects: await tx`select id, team_id from projects where key = 'web'`,
      refsToDroppedProject: await tx`select
        (select count(*) from turns where project_id = ${id.pPlg!}) + (select count(*) from agent_sessions where project_id = ${id.pPlg!})
        + (select count(*) from daily_rollups where project_id = ${id.pPlg!}) + (select count(*) from runaway_alerts where project_id = ${id.pPlg!}) as n`,
      onWeb: await tx`select (select count(*)::int from turns where project_id = ${id.pSpectado!}) as turns,
        (select count(*)::int from daily_rollups where project_id = ${id.pSpectado!}) as rollups,
        (select count(*)::int from runaway_alerts where project_id = ${id.pSpectado!}) as alerts`,
      rollupTurns: await tx`select sum(turns)::int as n from daily_rollups`,
      pending: await tx`select summary from pending_turn_patches where turn_external_id = 'turn-late'`,
      events: await tx`select company_id, received_at from ingest_events where event_id = 'ev-dup'`,
      audit: await tx`select count(*) filter (where company_id is null)::int as platform, count(*) filter (where action = 'deployment.merge_companies')::int as merge from audit_log`,
      users: await tx`select email from users order by email`,
      sessions: await tx`select token_hash, active_company_id from auth_sessions order by token_hash`,
      liveTokens: await tx`select count(*)::int as n from ingest_tokens where revoked_at is null`,
    }));

    expect(rows.companies).toHaveLength(1);
    const [company] = rows.companies as unknown as { id: string; name: string; slug: string; settings: Record<string, unknown> }[];
    expect(company).toMatchObject({ id: id.spectado, name: 'SPECTADO', slug: 'spectado' });
    expect(company!.settings).toEqual({ ...SETTINGS, runawayHours: 2 });
    expect(rows.teams.map((t) => t.name)).toEqual(['Mobile', 'PLAY.cz', 'PLG', 'Platform', 'Platform (Globex)', 'SPECTADO']);
    expect(new Set(rows.teams.map((t) => t.company_id))).toEqual(new Set([id.spectado]));

    // One membership per user: admin wins; primary team from the company where the user has more turns.
    expect(rows.memberships.map((m) => [m.email, m.company_role, m.primary_team])).toEqual([
      ['alice@acme.example', 'admin', 'Platform (Globex)'], // 1 turn in acme (admin), 2 in globex
      ['bob@acme.example', 'member', 'Mobile'],
      ['gina@globex.example', 'admin', 'Platform (Globex)'],
      ['owner@gmail.example', 'admin', 'SPECTADO'], // 3 turns in spectado, 1 in plg (member)
      ['owner@ticketportal.example', 'admin', 'PLG'],
    ]);
    expect(rows.memberships.length).toBe(rows.users.length);
    // last_active_at: the latest of the collapsed rows (the auth_sessions trigger bumps it to now() when alice's
    // session is re-pointed from globex to the survivor); untouched members keep theirs.
    expect(+new Date(rows.memberships[0]!.last_active_at as string)).toBeGreaterThanOrEqual(+new Date('2026-10-12T00:00:00Z'));
    expect(new Date(rows.memberships[2]!.last_active_at as string).toISOString()).toBe('2026-10-12T00:00:00.000Z');

    // The shared machine: one row (the survivor's), sessions re-pointed, first/last seen widened, os filled in.
    expect(rows.machines).toHaveLength(1);
    expect(rows.machines[0]).toMatchObject({ id: id.mSpectado, user_id: id.owner, os: 'darwin' });
    expect(new Date(rows.machines[0]!.first_seen_at as string).toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(new Date(rows.machines[0]!.last_seen_at as string).toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(rows.sessionsOnMachine[0]!.n).toBe(6);
    expect(report.actions.sessionsRepointedToMachine).toBe(3);

    // The shared project key: one row, everything re-pointed, the team mapping carried over.
    expect(rows.projects).toEqual([{ id: id.pSpectado, team_id: id.plgTeam }]);
    expect(Number(rows.refsToDroppedProject[0]!.n)).toBe(0);
    expect(rows.onWeb[0]).toEqual({ turns: 6, rollups: 2, alerts: 2 });
    expect(rows.rollupTurns[0]!.n).toBe(6);

    expect(rows.pending.map((p) => p.summary)).toEqual(['new']);
    expect(rows.events).toHaveLength(1);
    expect(rows.events[0]!.company_id).toBe(id.spectado);
    expect(rows.audit[0]).toEqual({ platform: 0, merge: 1 });
    expect(rows.users.map((u) => u.email)).not.toContain('admin@example.com');
    expect(rows.sessions.map((s) => [s.token_hash, s.active_company_id])).toEqual([['sess-a', id.spectado], ['sess-b', id.spectado]]);
    expect(rows.liveTokens[0]!.n).toBe(2);
    expect(report.actions.teamsRenamed).toEqual([{ from: 'Platform', to: 'Platform (Globex)' }]);
  });

  it('is a no-op re-run once only the survivor is left', async () => {
    const before = await allCounts();
    const report = await mergeCompanies(TEST_URL, { ...OPTS, survivor: 'spectado', log: quiet });
    expect(report.absorbed).toEqual([]);
    expect(await allCounts()).toEqual({ ...before, audit_log: before.audit_log! + 1 });
  });

  it('the merged database migrates to head (0018), also after a `pg_restore --no-owner` restore', async () => {
    const before = await allCounts();
    // --no-owner leaves every function owned by the restoring role; 0018 must hand them back to app_definer.
    await sql.unsafe(`do $$ declare r record; begin
      for r in select p.oid::regprocedure as f from pg_proc p where p.pronamespace = 'public'::regnamespace loop
        execute format('alter function %s owner to %I', r.f, current_user);
      end loop; end $$`);
    await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
    const after = await allCounts();
    const telemetry = ['agent_sessions', 'turns', 'runs', 'usage', 'run_links', 'daily_rollups', 'daily_skill_mcp_rollups',
      'runaway_alerts', 'flow_flags', 'machines', 'projects', 'budgets', 'invitations', 'pending_turn_patches', 'pending_session_patches'];
    expect(Object.fromEntries(telemetry.map((t) => [t, after[t]]))).toEqual(Object.fromEntries(telemetry.map((t) => [t, before[t]])));
    expect(after.memberships).toBe(before.company_memberships);
    const rows = await definer(async (tx) => ({
      deployment: await tx`select name, slug, settings from deployment`,
      teams: await tx`select name, slug from teams order by slug collate "C"`,
      memberships: await tx`select count(*)::int as n from memberships`,
      tokens: await tx`select hash, source, expires_at is not null as expires from ingest_tokens order by hash`,
      owners: await tx`select p.proowner::regrole::text as owner, count(*)::int as n from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prosecdef group by 1`,
    }));
    expect(rows.deployment).toEqual([{ name: 'SPECTADO', slug: 'spectado', settings: { ...SETTINGS, runawayHours: 2 } }]);
    expect(rows.teams.map((t) => [t.name, t.slug])).toEqual([
      ['Mobile', 'mobile'], ['Platform', 'platform'], ['Platform (Globex)', 'platform-globex'], ['PLAY.cz', 'play-cz'],
      ['PLG', 'plg'], ['SPECTADO', 'spectado'],
    ]);
    expect(rows.memberships[0]!.n).toBe(5);
    // The company token (revoked, no owner) is gone; the two user tokens are manual tokens with an expiry.
    expect(rows.tokens).toEqual([{ hash: 'h1', source: 'manual', expires: true }, { hash: 'h2', source: 'manual', expires: true }]);
    expect(rows.owners).toEqual([{ owner: 'app_definer', n: expect.any(Number) }]);
  }, 120_000);
});
