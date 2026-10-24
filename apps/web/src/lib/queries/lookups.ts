import { sql } from 'drizzle-orm';
import { rollupFacts, turnsByModel, type Dims } from './providers';
import { addDays, dayString } from './range';
import { canSeeUsers, type QueryCtx } from './scope';
import { rows, userLabel } from './sqlutil';

/** Teams, projects and users are readable by every member of the deployment (RLS); only telemetry is restricted. */
export interface TeamRef {
  id: string;
  name: string;
}
export interface ProjectRef {
  id: string;
  key: string;
  name: string;
  teamId: string | null;
}
export interface UserRef {
  id: string;
  name: string;
}

/** Display name of a project: the admin-given name, else the key (hashed keys are shortened). */
export function projectLabel(key: string, displayName: string | null): string {
  if (displayName) return displayName;
  return key.startsWith('sha256:') && key.length > 15 ? `${key.slice(0, 15)}…` : key;
}

export async function listTeams(ctx: QueryCtx): Promise<TeamRef[]> {
  const out = await rows<{ id: string; name: string }>(ctx.tx, sql`select id, name from teams order by name`);
  return out.map((t) => ({ id: t.id, name: t.name }));
}

export async function listProjects(ctx: QueryCtx): Promise<ProjectRef[]> {
  const out = await rows<{ id: string; key: string; display_name: string | null; team_id: string | null }>(
    ctx.tx,
    sql`select id, key, display_name, team_id from projects`,
  );
  return out
    .map((p) => ({ id: p.id, key: p.key, name: projectLabel(p.key, p.display_name), teamId: p.team_id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Only for viewers who may see individuals (full mode, lead/admin). Null otherwise. Admins get everyone;
 * a lead gets only themselves and the members of the teams they lead (their data is all they can see, so
 * other teams' people would be dead filter choices and a roster leak).
 */
export async function listUsers(ctx: QueryCtx): Promise<UserRef[] | null> {
  if (!canSeeUsers(ctx.viewer)) return null;
  let scope = sql``;
  if (ctx.viewer.role !== 'admin') {
    const led = ctx.viewer.teams.filter((t) => t.role === 'lead').map((t) => sql`${t.id}::uuid`);
    const ledList = sql.join(led, sql`, `);
    scope = sql` where (u.id = ${ctx.viewer.id}::uuid or m.primary_team_id in (${ledList})
      or u.id in (select tm.user_id from team_memberships tm where tm.team_id in (${ledList})))`;
  }
  const out = await rows<{ id: string; label: string | null }>(ctx.tx, sql`select u.id, ${userLabel('u')} as label from memberships m join users u on u.id = m.user_id${scope}`);
  return out.map((u) => ({ id: u.id, name: u.label || u.id })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface FilterOptions {
  teams: TeamRef[];
  projects: ProjectRef[];
  users: UserRef[] | null;
  harnesses: string[];
  models: string[];
  efforts: string[];
}

const BASE_HARNESSES = ['claude-code', 'codex'];
const DISCOVER_DAYS = 400;

/** Distinct harness / model / effort values seen recently (rollups + the last two days of raw rows). */
async function discover(ctx: QueryCtx): Promise<{ harnesses: Set<string>; models: Set<string>; efforts: Set<string> }> {
  const today = dayString(ctx.now.getTime());
  const wide: Dims = {
    fromDay: addDays(today, -DISCOVER_DAYS),
    toDay: addDays(today, 1),
    fromIso: `${addDays(today, -2)}T00:00:00Z`,
    toIso: `${addDays(today, 1)}T00:00:00Z`,
    teamId: null,
    projectId: null,
    userId: null,
    harness: null,
    model: null,
    effort: null,
  };
  const harnesses = new Set(BASE_HARNESSES);
  const models = new Set<string>();
  const efforts = new Set<string>();
  const seen = (h: string | null, m: string | null, e: string | null) => {
    if (h) harnesses.add(h);
    if (m) models.add(m);
    if (e) efforts.add(e);
  };
  if (ctx.agg) {
    for (const x of await rollupFacts(ctx, wide)) seen(x.harness, x.model, x.effort);
    for (const x of await turnsByModel(ctx, wide)) seen(null, x.model ?? null, x.effort ?? null);
  } else {
    const out = await rows<{ harness: string; model: string | null; effort: string | null }>(
      ctx.tx,
      sql`select harness, model, effort from daily_rollups where day >= ${wide.fromDay}::date
            group by 1, 2, 3
          union
          select harness, model, effort from turns
            where started_at >= ${wide.fromIso}::timestamptz group by 1, 2, 3`,
    );
    for (const x of out) seen(x.harness, x.model, x.effort);
  }
  return { harnesses, models, efforts };
}

/** Everything the FilterBar needs. Non-admins only get the teams they belong to. */
export async function loadFilterOptions(ctx: QueryCtx): Promise<FilterOptions> {
  const [allTeams, projects, users, seen] = await Promise.all([listTeams(ctx), listProjects(ctx), listUsers(ctx), discover(ctx)]);
  const mine = new Set(ctx.viewer.teams.map((t) => t.id));
  const teams = ctx.viewer.role === 'admin' ? allTeams : allTeams.filter((t) => mine.has(t.id));
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { teams, projects, users, harnesses: sorted(seen.harnesses), models: sorted(seen.models), efforts: sorted(seen.efforts) };
}

