import { fileURLToPath } from 'node:url';
import postgres, { type Sql, type TransactionSql } from 'postgres';

/**
 * One-off dev merge (brief "single-deployment-per-user-tokens", Appendix G): collapses every company into one
 * survivor on the 0017 schema, before migration 0018 drops the company concept. Not a migration: it is run once by
 * hand, rehearsed on a pg_dump copy first.
 *
 * Everything happens in one transaction. DDL (dropping and re-adding the composite (company_id, …) foreign keys,
 * which are ON UPDATE NO ACTION) runs as the connecting owner; every data change runs as app_definer, like migration
 * 0014 section 4 (FORCE RLS binds the owner). Collision rules (brief, architect defaults):
 *
 * - a user in several companies keeps one membership: admin if any was admin, the primary team of the company where
 *   the user has more turns (survivor wins a tie);
 * - machines rows with the same machine_id are merged (sessions re-pointed, first/last seen widened);
 * - projects with the same key are merged (turns, sessions, rollups, alerts re-pointed);
 * - duplicate team names get a " (<old company name>)" suffix;
 * - duplicate ingest_events and pending patches are deleted (ingest_events keep the survivor's / oldest row, patches
 *   keep the newest);
 * - rollup rows are kept as they are and re-pointed, so per-day totals add up (sums asserted equal);
 * - any other cross-company duplicate of a unique key (turn, run, session external ids, …) aborts;
 * - platform audit rows (company_id null) and super admins without a membership are deleted;
 * - absorbed companies are deleted last, after asserting no row of any company table still points at them.
 *
 * Row counts of every table are taken before and after; any change not explained by the rules above aborts.
 */

export interface MergeSettings {
  individualVisibility?: 'full' | 'aggregates-only';
  retentionDays?: number;
  runawayCostUsd?: number;
  projectNaming?: 'plain' | 'hashed';
  [key: string]: unknown;
}

export interface MergeOptions {
  /** Slug of the company that survives (e.g. 'spectado-c7faa0'). */
  survivor: string;
  /** New name and slug of the survivor. */
  name: string;
  slug: string;
  /** Merged over the survivor's settings (keys not given are kept). */
  settings: MergeSettings;
  /** Roll back at the end instead of committing. */
  dryRun?: boolean;
  /** Output sink (default console.log). */
  log?: (line: string) => void;
}

export interface MergeReport {
  dryRun: boolean;
  survivorId: string;
  absorbed: Array<{ id: string; slug: string; name: string }>;
  before: Record<string, number>;
  after: Record<string, number>;
  actions: {
    teamsRenamed: Array<{ from: string; to: string }>;
    membershipsCollapsed: Array<{ email: string; kept: number; removed: number; role: string; primaryTeam: string | null }>;
    machinesMerged: number;
    sessionsRepointedToMachine: number;
    projectsMerged: number;
    ingestEventsDeleted: number;
    pendingTurnPatchesDeleted: number;
    pendingSessionPatchesDeleted: number;
    platformAuditDeleted: number;
    superAdminsDeleted: string[];
    authSessionsRepointed: number;
  };
  summary: string;
}

/** Thrown when the merge refuses or a check fails; the transaction is rolled back. */
export class MergeAbort extends Error {
  override name = 'MergeAbort';
}

class DryRunRollback extends Error {
  constructor(readonly report: MergeReport) {
    super('dry run');
  }
}

/** Every table that has company_id at 0017 (enumerated from migrations 0000-0017). */
export const COMPANY_TABLES = [
  'agent_sessions', 'audit_log', 'budgets', 'company_memberships', 'daily_rollups', 'daily_skill_mcp_rollups',
  'flow_flags', 'identity_providers', 'ingest_events', 'ingest_tokens', 'invitations', 'machines',
  'pending_session_patches', 'pending_turn_patches', 'projects', 'run_links', 'runaway_alerts', 'runs',
  'team_memberships', 'teams', 'turns', 'usage',
] as const;

/** Company-scoped unique keys that the collision rules resolve; every other one must not collide. */
const RESOLVED_UNIQUE = new Set([
  'teams_company_name_uq', 'machines_company_machine_uq', 'projects_company_key_uq', 'ingest_events_company_event_uq',
  'pending_turn_patches_company_turn_uq', 'pending_session_patches_company_session_uq',
  'company_memberships_company_user_uq',
]);

/** Summed before and after: rollup rows are kept, so these totals must not move. */
const SUMS: Record<string, string[]> = {
  daily_rollups: ['turns', 'runs', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'requests', 'duration_ms'],
  daily_skill_mcp_rollups: ['calls', 'turns', 'errors'],
  turns: ['input_tokens', 'output_tokens'],
  usage: ['input_tokens', 'output_tokens', 'requests'],
};

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
type Row = Record<string, unknown>;

export async function mergeCompanies(url: string, opts: MergeOptions): Promise<MergeReport> {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(opts.slug)) throw new MergeAbort(`invalid slug "${opts.slug}"`);
  if (!opts.name.trim()) throw new MergeAbort('name must not be empty');
  const sql: Sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return (await sql.begin((tx) => run(tx, opts, log))) as MergeReport;
  } catch (err) {
    if (err instanceof DryRunRollback) {
      log('dry run: rolled back, nothing changed');
      return err.report;
    }
    throw err;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function run(tx: TransactionSql, opts: MergeOptions, log: (line: string) => void): Promise<MergeReport> {
  const q = async <T extends Row = Row>(text: string, params: unknown[] = []) =>
    [...(await tx.unsafe(text, params as never[]))] as unknown as T[];
  const definer = () => q('set local role app_definer');
  const owner = () => q('reset role');

  // ---------- schema guard ----------
  const hasCompanies = await q(`select to_regclass('public.companies') is not null as ok`);
  if (!hasCompanies[0]?.ok) throw new MergeAbort('no companies table: this script only runs on the 0017 schema, before migration 0018');
  const companyTables = (await q<{ t: string }>(
    `select c.table_name as t from information_schema.columns c join information_schema.tables t
       on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'company_id' order by 1`)).map((r) => r.t);
  const expected = [...COMPANY_TABLES].sort();
  if (companyTables.join(',') !== expected.join(',')) {
    throw new MergeAbort(`unexpected schema: tables with company_id are [${companyTables.join(', ')}], expected the 0017 set [${expected.join(', ')}]`);
  }
  const allTables = (await q<{ t: string }>(
    `select relname as t from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by 1`)).map((r) => r.t);

  await definer();
  // ---------- survivor ----------
  const companies = await q<{ id: string; slug: string; name: string; settings: Row; created_at: Date }>(
    `select id, slug, name, settings, created_at from companies order by created_at, slug`);
  const survivor = companies.find((c) => c.slug === opts.survivor);
  if (!survivor) {
    throw new MergeAbort(`survivor "${opts.survivor}" not found; companies: ${companies.map((c) => c.slug).join(', ') || '(none)'}`);
  }
  const S = survivor.id;
  const absorbed = companies.filter((c) => c.id !== S);
  const absorbedIds = absorbed.map((c) => c.id);
  const companyName = new Map(companies.map((c) => [c.id, c.name]));
  const companyRank = new Map(companies.map((c, i) => [c.id, c.id === S ? -1 : i]));
  for (const c of absorbed) {
    if ((c.settings as Row).projectNaming === 'hashed') {
      log(`warning: ${c.slug} uses hashed project naming; its project keys were hashed with its own salt, which is dropped`);
    }
  }

  const before = await countAll(q, allTables);
  const sumsBefore = await sumAll(q);

  // ---------- refusals that need no change: cross-company duplicates of unresolved unique keys ----------
  await owner();
  const uniques = await q<{ tbl: string; conname: string; cols: string[]; nnd: boolean; nullable: boolean }>(
    `select c.conrelid::regclass::text as tbl, c.conname,
            array(select a.attname::text from unnest(c.conkey) with ordinality k(n, o)
                  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.o) as cols,
            coalesce(i.indnullsnotdistinct, false) as nnd,
            exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey) and not a.attnotnull) as nullable
     from pg_constraint c left join pg_index i on i.indexrelid = c.conindid
     where c.contype = 'u' and c.connamespace = 'public'::regnamespace
       and exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey) and a.attname = 'company_id')
     order by 1, 2`);
  await definer();
  for (const u of uniques) {
    if (RESOLVED_UNIQUE.has(u.conname)) continue;
    const rest = u.cols.filter((c) => c !== 'company_id');
    if (rest.length === 1 && rest[0] === 'id') continue; // (company_id, id): ids are globally unique
    const cols = rest.map(ident).join(', ');
    const where = u.nullable && !u.nnd ? `where ${rest.map((c) => `${ident(c)} is not null`).join(' and ')}` : '';
    const dups = await q<{ k: string; n: number }>(
      `select concat_ws(' / ', ${cols}) as k, count(*)::int as n from ${ident(u.tbl)} ${where}
       group by ${cols} having count(*) > 1 order by 1 limit 5`);
    if (dups.length) {
      throw new MergeAbort(`duplicate external id across companies in ${u.tbl} (${u.conname}: ${rest.join(', ')}): ` +
        `${dups.map((d) => `${d.k} x${d.n}`).join('; ')}; nothing was changed`);
    }
  }

  // Super admins without a membership go (the company-less platform identity). Refuse if they own telemetry.
  const doomedUsers = await q<{ id: string; email: string }>(
    `select u.id, u.email from users u
     where u.is_super_admin and not exists (select 1 from company_memberships m where m.user_id = u.id) order by u.email`);
  const doomedIds = doomedUsers.map((u) => u.id);
  await owner();
  const userRefs = await q<{ tbl: string; col: string; del: string }>(
    `select c.conrelid::regclass::text as tbl, a.attname::text as col, c.confdeltype::text as del
     from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.confrelid = 'public.users'::regclass and array_length(c.conkey, 1) = 1 order by 1, 2`);
  await definer();
  const cascadeLoss: Record<string, number> = {};
  if (doomedIds.length) {
    for (const r of userRefs.filter((r) => r.del === 'c')) {
      const [{ n } = { n: 0 }] = await q<{ n: number }>(
        `select count(*)::int as n from ${ident(r.tbl)} where ${ident(r.col)} = any($1::uuid[])`, [doomedIds]);
      if (!n) continue;
      if (r.tbl !== 'auth_sessions' && r.tbl !== 'auth_accounts') {
        throw new MergeAbort(`super admin(s) ${doomedUsers.map((u) => u.email).join(', ')} own ${n} row(s) in ${r.tbl}; refusing to delete them`);
      }
      cascadeLoss[r.tbl] = (cascadeLoss[r.tbl] ?? 0) + n;
    }
  }

  // ---------- DDL: drop the composite (company_id, …) foreign keys (re-added unchanged at the end) ----------
  await owner();
  const compositeFks = await q<{ tbl: string; conname: string; def: string }>(
    `select c.conrelid::regclass::text as tbl, c.conname, pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) > 1
       and exists (select 1 from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any(c.conkey) and a.attname = 'company_id')
     order by 1, 2`);
  const repointRefs = async (target: 'projects' | 'machines') => {
    const refs = await q<{ tbl: string; col: string; n: number }>(
      `select c.conrelid::regclass::text as tbl, a.attname::text as col, array_length(c.conkey, 1) as n
       from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.confrelid = $1::regclass order by 1, 2`, [`public.${target}`]);
    if (refs.some((r) => r.n !== 1)) throw new MergeAbort(`unexpected schema: a composite foreign key references ${target}`);
    return refs;
  };
  const projectRefs = await repointRefs('projects');
  const machineRefs = await repointRefs('machines');
  for (const fk of compositeFks) await q(`alter table ${ident(fk.tbl)} drop constraint ${ident(fk.conname)}`);

  // ---------- data (as app_definer) ----------
  await definer();
  const actions: MergeReport['actions'] = {
    teamsRenamed: [], membershipsCollapsed: [], machinesMerged: 0, sessionsRepointedToMachine: 0, projectsMerged: 0,
    ingestEventsDeleted: 0, pendingTurnPatchesDeleted: 0, pendingSessionPatchesDeleted: 0, platformAuditDeleted: 0,
    superAdminsDeleted: doomedUsers.map((u) => u.email), authSessionsRepointed: 0,
  };
  const byRank = (a: { company_id: string }, b: { company_id: string }) =>
    (companyRank.get(a.company_id) ?? 0) - (companyRank.get(b.company_id) ?? 0);

  // Teams: duplicate names (case as stored) get " (<old company name>)"; the survivor's (else the oldest company's) keeps it.
  const teams = await q<{ id: string; company_id: string; name: string; created_at: Date }>(
    `select id, company_id, name, created_at from teams order by created_at, id`);
  const taken = new Set<string>();
  for (const t of [...teams].sort((a, b) => byRank(a, b) || +a.created_at - +b.created_at)) {
    if (!taken.has(t.name)) {
      taken.add(t.name);
      continue;
    }
    let to = `${t.name} (${companyName.get(t.company_id)})`;
    for (let i = 2; taken.has(to); i++) to = `${t.name} (${companyName.get(t.company_id)} ${i})`;
    taken.add(to);
    await q(`update teams set name = $1 where id = $2`, [to, t.id]);
    actions.teamsRenamed.push({ from: t.name, to });
  }

  // Machines: one row per machine_id; the survivor's (else the first seen) is kept.
  const machines = await q<{ id: string; company_id: string; machine_id: string; user_id: string | null; os: string | null; first_seen_at: Date; last_seen_at: Date }>(
    `select id, company_id, machine_id, user_id, os, first_seen_at, last_seen_at from machines
     where machine_id in (select machine_id from machines group by machine_id having count(*) > 1) order by machine_id`);
  for (const group of groupBy(machines, (m) => m.machine_id)) {
    group.sort((a, b) => byRank(a, b) || +a.first_seen_at - +b.first_seen_at);
    const [keep, ...drop] = group as [typeof group[number], ...typeof group];
    const dropIds = drop.map((m) => m.id);
    for (const r of machineRefs) {
      const res = await q<{ n: number }>(
        `with u as (update ${ident(r.tbl)} set ${ident(r.col)} = $1 where ${ident(r.col)} = any($2::uuid[]) returning 1)
         select count(*)::int as n from u`, [keep.id, dropIds]);
      if (r.tbl === 'agent_sessions') actions.sessionsRepointedToMachine += res[0]?.n ?? 0;
    }
    await q(`delete from machines where id = any($1::uuid[])`, [dropIds]);
    await q(
      `update machines set first_seen_at = $2, last_seen_at = $3, user_id = coalesce(user_id, $4), os = coalesce(os, $5) where id = $1`,
      [keep.id, new Date(Math.min(...group.map((m) => +m.first_seen_at))), new Date(Math.max(...group.map((m) => +m.last_seen_at))),
        drop.find((m) => m.user_id)?.user_id ?? null, drop.find((m) => m.os)?.os ?? null]);
    actions.machinesMerged += drop.length;
  }

  // Projects: one row per key; the survivor's (else the oldest) is kept; everything pointing at the others moves.
  const projects = await q<{ id: string; company_id: string; key: string; display_name: string | null; team_id: string | null; created_at: Date; last_seen_at: Date }>(
    `select id, company_id, key, display_name, team_id, created_at, last_seen_at from projects
     where key in (select key from projects group by key having count(*) > 1) order by key`);
  for (const group of groupBy(projects, (p) => p.key)) {
    group.sort((a, b) => byRank(a, b) || +a.created_at - +b.created_at);
    const [keep, ...drop] = group as [typeof group[number], ...typeof group];
    const dropIds = drop.map((p) => p.id);
    for (const r of projectRefs) {
      await q(`update ${ident(r.tbl)} set ${ident(r.col)} = $1 where ${ident(r.col)} = any($2::uuid[])`, [keep.id, dropIds]);
    }
    await q(`delete from projects where id = any($1::uuid[])`, [dropIds]);
    await q(
      `update projects set created_at = $2, last_seen_at = $3, team_id = coalesce(team_id, $4), display_name = coalesce(display_name, $5) where id = $1`,
      [keep.id, new Date(Math.min(...group.map((p) => +p.created_at))), new Date(Math.max(...group.map((p) => +p.last_seen_at))),
        drop.find((p) => p.team_id)?.team_id ?? null, drop.find((p) => p.display_name)?.display_name ?? null]);
    actions.projectsMerged += drop.length;
  }

  // Duplicate ingest_events (idempotency keys) and pending patches.
  const dedupe = async (table: string, part: string, order: string) =>
    (await q<{ n: number }>(
      `with d as (delete from ${ident(table)} where id in (
         select id from (select id, row_number() over (partition by ${ident(part)} order by ${order}) as rn from ${ident(table)}) x
         where rn > 1) returning 1)
       select count(*)::int as n from d`, [S]))[0]?.n ?? 0;
  actions.ingestEventsDeleted = await dedupe('ingest_events', 'event_id', '(company_id = $1) desc, received_at, id');
  actions.pendingTurnPatchesDeleted = await dedupe('pending_turn_patches', 'turn_external_id', 'received_at desc, (company_id = $1) desc, id');
  actions.pendingSessionPatchesDeleted = await dedupe('pending_session_patches', 'session_external_id', 'received_at desc, (company_id = $1) desc, id');

  // Memberships: one per user. Admin if any was admin; primary team from the company where the user has more turns.
  const memberships = await q<{ id: string; company_id: string; user_id: string; email: string; company_role: string; primary_team_id: string | null; last_active_at: Date | null; created_at: Date; turns: number }>(
    `select m.id, m.company_id, m.user_id, u.email, m.company_role::text as company_role, m.primary_team_id, m.last_active_at, m.created_at,
            (select count(*)::int from turns t where t.user_id = m.user_id and t.company_id = m.company_id) as turns
     from company_memberships m join users u on u.id = m.user_id
     where m.user_id in (select user_id from company_memberships group by user_id having count(*) > 1)
     order by u.email`);
  for (const group of groupBy(memberships, (m) => m.user_id)) {
    group.sort((a, b) => b.turns - a.turns || byRank(a, b) || +a.created_at - +b.created_at);
    const [keep, ...drop] = group as [typeof group[number], ...typeof group];
    const role = group.some((m) => m.company_role === 'admin') ? 'admin' : keep.company_role;
    const primary = keep.primary_team_id ?? drop.find((m) => m.primary_team_id)?.primary_team_id ?? null;
    const lastActive = group.map((m) => m.last_active_at).filter((d): d is Date => !!d).sort((a, b) => +b - +a)[0] ?? null;
    await q(`delete from company_memberships where id = any($1::uuid[])`, [drop.map((m) => m.id)]);
    await q(
      `update company_memberships set company_role = $2::company_role, primary_team_id = $3, last_active_at = $4, created_at = $5 where id = $1`,
      [keep.id, role, primary, lastActive, new Date(Math.min(...group.map((m) => +m.created_at)))]);
    actions.membershipsCollapsed.push({
      email: keep.email, kept: 1, removed: drop.length, role,
      primaryTeam: primary ? teams.find((t) => t.id === primary)?.name ?? primary : null,
    });
  }

  // Move every company-scoped row to the survivor.
  for (const t of COMPANY_TABLES) {
    if (absorbedIds.length) await q(`update ${ident(t)} set company_id = $1 where company_id = any($2::uuid[])`, [S, absorbedIds]);
  }
  actions.authSessionsRepointed = (await q<{ n: number }>(
    `with u as (update auth_sessions set active_company_id = $1 where active_company_id = any($2::uuid[]) returning 1)
     select count(*)::int as n from u`, [S, absorbedIds]))[0]?.n ?? 0;

  // Platform rows: audit rows without a company, the company-less super-admin identity.
  actions.platformAuditDeleted = (await q<{ n: number }>(
    `with d as (delete from audit_log where company_id is null returning 1) select count(*)::int as n from d`))[0]?.n ?? 0;
  if (doomedIds.length) await q(`delete from users where id = any($1::uuid[])`, [doomedIds]);

  // Nothing may still point at an absorbed company, then the absorbed companies go (their FKs cascade).
  for (const t of COMPANY_TABLES) {
    const [{ n } = { n: 0 }] = await q<{ n: number }>(
      `select count(*)::int as n from ${ident(t)} where company_id is distinct from $1${t === 'audit_log' ? ' and company_id is not null' : ''}`, [S]);
    if (n) throw new MergeAbort(`${n} row(s) of ${t} still point at an absorbed company`);
  }
  const deleted = await q(`delete from companies where id = any($1::uuid[]) returning id`, [absorbedIds]);
  if (deleted.length !== absorbedIds.length) throw new MergeAbort(`deleted ${deleted.length} companies, expected ${absorbedIds.length}`);
  await q(`update companies set name = $2, slug = $3, settings = settings || $4::jsonb, updated_at = now() where id = $1`,
    [S, opts.name.trim(), opts.slug, opts.settings]); // postgres.js serializes objects for a jsonb parameter
  await q(`insert into audit_log (company_id, actor_user_id, action, target, meta) values ($1, null, 'deployment.merge_companies', $2, $3::jsonb)`, [
    S, opts.slug, { survivor: opts.survivor, absorbed: absorbed.map((c) => c.slug), settings: opts.settings },
  ]);

  // ---------- DDL: re-add the composite foreign keys unchanged (this validates every row) ----------
  await owner();
  for (const fk of compositeFks) await q(`alter table ${ident(fk.tbl)} add constraint ${ident(fk.conname)} ${fk.def}`);

  // ---------- verify ----------
  await definer();
  const after = await countAll(q, allTables);
  const sumsAfter = await sumAll(q);
  const membershipLoss = actions.membershipsCollapsed.reduce((n, m) => n + m.removed, 0);
  const expectedLoss: Record<string, number> = {
    companies: absorbedIds.length,
    company_memberships: membershipLoss,
    machines: actions.machinesMerged,
    projects: actions.projectsMerged,
    ingest_events: actions.ingestEventsDeleted,
    pending_turn_patches: actions.pendingTurnPatchesDeleted,
    pending_session_patches: actions.pendingSessionPatchesDeleted,
    audit_log: actions.platformAuditDeleted - 1, // + the merge's own audit row
    users: doomedIds.length,
    ...Object.fromEntries(Object.entries(cascadeLoss).map(([t, n]) => [t, n])),
  };
  const mismatches = allTables.filter((t) => (before[t] ?? 0) - (expectedLoss[t] ?? 0) !== after[t]);
  if (mismatches.length) {
    throw new MergeAbort(`row counts changed unexpectedly: ${mismatches.map((t) =>
      `${t} ${before[t]} -> ${after[t]} (expected ${(before[t] ?? 0) - (expectedLoss[t] ?? 0)})`).join('; ')}`);
  }
  const sumDiff = Object.keys(sumsBefore).filter((k) => sumsBefore[k] !== sumsAfter[k]);
  if (sumDiff.length) throw new MergeAbort(`totals changed: ${sumDiff.map((k) => `${k} ${sumsBefore[k]} -> ${sumsAfter[k]}`).join('; ')}`);
  const [{ n: teamCount } = { n: 0 }] = await q<{ n: number }>(`select count(*)::int as n from teams`);

  // ---------- report ----------
  const w = Math.max(...allTables.map((t) => t.length));
  log(`${'table'.padEnd(w)}  ${'before'.padStart(7)}  ${'after'.padStart(7)}  delta`);
  for (const t of allTables) {
    const d = (after[t] ?? 0) - (before[t] ?? 0);
    log(`${t.padEnd(w)}  ${String(before[t]).padStart(7)}  ${String(after[t]).padStart(7)}  ${d ? (d > 0 ? `+${d}` : String(d)) : ''}`);
  }
  for (const r of actions.teamsRenamed) log(`team renamed: ${r.from} -> ${r.to}`);
  for (const m of actions.membershipsCollapsed) log(`membership collapsed: ${m.email} -> ${m.role}, primary team ${m.primaryTeam ?? '(none)'} (${m.removed} removed)`);
  if (actions.superAdminsDeleted.length) log(`super admin(s) deleted: ${actions.superAdminsDeleted.join(', ')}`);
  const summary = `${opts.dryRun ? '[dry run] ' : ''}merged ${absorbed.length} compan${absorbed.length === 1 ? 'y' : 'ies'} ` +
    `(${absorbed.map((c) => c.slug).join(', ') || 'none'}) into ${opts.name} (${opts.slug}): ${teamCount} teams, ` +
    `${after.company_memberships} memberships (${membershipLoss} collapsed), ${actions.machinesMerged} machine(s) merged ` +
    `(${actions.sessionsRepointedToMachine} sessions re-pointed), ${actions.projectsMerged} project(s) merged, ` +
    `${actions.teamsRenamed.length} team(s) renamed, ${actions.ingestEventsDeleted + actions.pendingTurnPatchesDeleted + actions.pendingSessionPatchesDeleted} duplicate event/patch row(s) deleted, ` +
    `${actions.platformAuditDeleted} platform audit row(s) and ${doomedIds.length} super admin(s) deleted, ${after.turns} turns`;
  log(summary);

  const report: MergeReport = {
    dryRun: !!opts.dryRun, survivorId: S, absorbed: absorbed.map(({ id, slug, name }) => ({ id, slug, name })),
    before, after, actions, summary,
  };
  if (opts.dryRun) throw new DryRunRollback(report);
  return report;
}

type Query = <T extends Row = Row>(text: string, params?: unknown[]) => Promise<T[]>;

async function countAll(q: Query, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (await q<{ n: number }>(`select count(*)::int as n from ${ident(t)}`))[0]?.n ?? 0;
  return out;
}

async function sumAll(q: Query): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [t, cols] of Object.entries(SUMS)) {
    const [row = {}] = await q(`select ${cols.map((c) => `coalesce(sum(${ident(c)}), 0)::text as ${ident(c)}`).join(', ')} from ${ident(t)}`);
    for (const c of cols) out[`${t}.${c}`] = String(row[c]);
  }
  return out;
}

function groupBy<T>(rows: T[], key: (r: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const g = m.get(k);
    if (g) g.push(r);
    else m.set(k, [r]);
  }
  return [...m.values()];
}

/** Brief Q2 values; CLI flags override. */
export const DEFAULT_MERGE_SETTINGS: MergeSettings = {
  individualVisibility: 'full', retentionDays: 395, runawayCostUsd: 20, projectNaming: 'plain',
};

export function parseMergeArgs(argv: string[]): { url: string | undefined; options: MergeOptions } {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (!a.startsWith('--')) throw new MergeAbort(`unexpected argument "${a}"`);
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (k === 'dry-run') flags.set(k, true);
    else {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith('--')) throw new MergeAbort(`--${k} needs a value`);
      flags.set(k, v);
    }
  }
  const known = ['survivor', 'name', 'slug', 'dry-run', 'url', 'visibility', 'retention-days', 'runaway-cost-usd', 'project-naming'];
  for (const k of flags.keys()) if (!known.includes(k)) throw new MergeAbort(`unknown flag --${k}`);
  const str = (k: string) => (typeof flags.get(k) === 'string' ? (flags.get(k) as string) : undefined);
  const survivor = str('survivor'), name = str('name'), slug = str('slug');
  if (!survivor || !name || !slug) {
    throw new MergeAbort('usage: db:merge-companies -- --survivor <slug> --name <name> --slug <slug> [--dry-run] [--url <postgres url>] ' +
      '[--visibility full|aggregates-only] [--retention-days N] [--runaway-cost-usd N] [--project-naming plain|hashed]');
  }
  const settings: MergeSettings = { ...DEFAULT_MERGE_SETTINGS };
  const vis = str('visibility');
  if (vis) {
    if (vis !== 'full' && vis !== 'aggregates-only') throw new MergeAbort('--visibility must be full or aggregates-only');
    settings.individualVisibility = vis;
  }
  const naming = str('project-naming');
  if (naming) {
    if (naming !== 'plain' && naming !== 'hashed') throw new MergeAbort('--project-naming must be plain or hashed');
    settings.projectNaming = naming;
  }
  for (const [flag, key] of [['retention-days', 'retentionDays'], ['runaway-cost-usd', 'runawayCostUsd']] as const) {
    const v = str(flag);
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new MergeAbort(`--${flag} must be a number`);
    settings[key] = n;
  }
  return { url: str('url'), options: { survivor, name, slug, settings, dryRun: flags.get('dry-run') === true } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  (async () => {
    const { url: flagUrl, options } = parseMergeArgs(process.argv.slice(2));
    const url = flagUrl || process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new MergeAbort('no database: pass --url or set MIGRATE_DATABASE_URL / DATABASE_URL');
    const where = new URL(url);
    console.log(`merge-companies: database "${where.pathname.slice(1)}" on ${where.host}${options.dryRun ? ' (dry run)' : ''}`);
    await mergeCompanies(url, options);
  })().catch((err: unknown) => {
    console.error(err instanceof MergeAbort ? `merge-companies: ${err.message}` : err);
    process.exit(1);
  });
}
