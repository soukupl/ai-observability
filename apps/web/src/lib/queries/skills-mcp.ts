import { sql, type SQL } from 'drizzle-orm';
import type { Filters } from '../filters';
import { aggArgs, dims, turnConds, type Dims } from './providers';
import { rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { num, rows, where } from './sqlutil';

/*
 * Skill and MCP use (docs/briefs/skills-and-mcp-stats.md). Short ranges read turns.skills / turns.mcp plus
 * the runs of those turns; long ranges read daily_skill_mcp_rollups. Both produce the same rows by `level`:
 *   name  per skill / per MCP server (distinct turns and users at that level)
 *   tool  per MCP server × tool
 *   day   per day × skill / server
 * Names are as stored: plain, or `sha256:…` when the deployment hashes names (project-naming mode).
 */

export interface SkillRow {
  name: string;
  calls: number;
  /** started by the model (Skill tool, or a Codex SKILL.md read) */
  modelCalls: number;
  /** typed by the user as `/name` */
  userCalls: number;
  turns: number;
  users: number;
}

/** MCP errors, denials and latency (docs/briefs/mcp-reliability.md). */
export interface McpReliability {
  errors: number;
  denied: number;
  /** total ms of the calls with a timed result */
  latencyMs: number;
  /** timed results per latency bucket: < 1 s, 1–5 s, 5–30 s, 30–120 s, > 120 s */
  buckets: number[];
}

export interface McpToolRow extends McpReliability {
  tool: string;
  calls: number;
  turns: number;
  users: number;
}

export interface McpServerRow extends McpReliability {
  name: string;
  calls: number;
  turns: number;
  users: number;
  /** most-called first */
  tools: McpToolRow[];
}

export interface SkillMcpDay {
  day: string;
  kind: 'skill' | 'mcp';
  name: string;
  calls: number;
}

export interface SkillsMcpResult {
  range: ResolvedRange;
  /** most-used first */
  skills: SkillRow[];
  /** most-called first */
  servers: McpServerRow[];
  days: SkillMcpDay[];
  ignoredFilters: string[];
}

/** Turn scope + the turns' runs, flattened to one row per skill / MCP tool use (direct raw path). */
function rawFlat(scope: SQL): SQL {
  return sql`with uses as (
      select t.id as turn_id, t.user_id, (t.started_at at time zone 'UTC')::date as day, u.skills, u.mcp
      from (${scope}) t
      cross join lateral (
        select t.skills, t.mcp
        union all
        select r.skills, r.mcp from runs r where r.turn_id = t.id
      ) u
    ), flat as (
      select x.turn_id, x.user_id, x.day, 'skill'::text as kind, s.key as name, ''::text as tool,
        coalesce((s.value->>'model')::bigint, 0) as model_calls, coalesce((s.value->>'user')::bigint, 0) as user_calls
      from uses x cross join lateral jsonb_each(x.skills) s
      union all
      select x.turn_id, x.user_id, x.day, 'mcp', m.key, tl.key, (tl.value #>> '{}')::bigint, 0
      from uses x cross join lateral jsonb_each(x.mcp) m cross join lateral jsonb_each(m.value) tl
    )`;
}

const LEVEL_SUMS = sql.raw(
  'sum(model_calls + user_calls)::bigint as calls, sum(model_calls)::bigint as model_calls, sum(user_calls)::bigint as user_calls, ' +
    'count(distinct turn_id) as turns, count(distinct user_id) as users',
);

function directRaw(ctx: QueryCtx, d: Dims): SQL {
  const scope = sql`select t.* from turns t ${where(turnConds(ctx, d))}`;
  return sql`${rawFlat(scope)}
    select 'name' as level, null::text as day, kind, name, '' as tool, ${LEVEL_SUMS} from flat group by kind, name
    union all
    select 'tool', null, kind, name, tool, ${LEVEL_SUMS} from flat where kind = 'mcp' group by kind, name, tool
    union all
    select 'day', day::text, kind, name, '', ${LEVEL_SUMS} from flat group by day, kind, name`;
}

function directRollup(ctx: QueryCtx, d: Dims): SQL {
  const c: SQL[] = [
        sql`d.day >= ${d.fromDay}::date`,
    sql`d.day < ${d.toDay}::date`,
  ];
  if (d.teamId) c.push(sql`d.team_id = ${d.teamId}::uuid`);
  if (d.projectId) c.push(sql`d.project_id = ${d.projectId}::uuid`);
  if (d.userId) c.push(sql`d.user_id = ${d.userId}::uuid`);
  if (d.harness) c.push(sql`d.harness = ${d.harness}`);
  if (d.model) c.push(sql`d.model = ${d.model}`);
  const sums = sql.raw(
    'sum(calls)::bigint as calls, sum(model_calls)::bigint as model_calls, sum(user_calls)::bigint as user_calls, ' +
      'sum(turns)::bigint as turns, count(distinct user_id) as users',
  );
  return sql`with d as (select * from daily_skill_mcp_rollups d ${where(c)})
    select 'name' as level, null::text as day, kind, name, '' as tool, ${sums} from d where tool = '' group by kind, name
    union all
    select 'tool', null, kind, name, tool, ${sums} from d where tool <> '' group by kind, name, tool
    union all
    select 'day', day::text, kind, name, '', ${sums} from d where tool = '' group by day, kind, name`;
}

/** Errors / denials / latency per server ('' tool) and server × tool, from raw rows or rollups. */
async function reliability(ctx: QueryCtx, d: Dims, rollup: boolean): Promise<Map<string, McpReliability>> {
  const cols = sql.raw('level, name, tool, errors, denied, latency_ms, lat0, lat1, lat2, lat3, lat4');
  let q: SQL;
  if (ctx.agg) {
    q = rollup
      ? sql`select ${cols} from agg_mcp_reliability_rollups(${aggArgs(d, 'date')})`
      : sql`select ${cols} from agg_mcp_reliability(${aggArgs(d, 'ts')})`;
  } else if (rollup) {
    const c: SQL[] = [sql`d.kind = 'mcp'`, sql`d.day >= ${d.fromDay}::date`, sql`d.day < ${d.toDay}::date`];
    if (d.teamId) c.push(sql`d.team_id = ${d.teamId}::uuid`);
    if (d.projectId) c.push(sql`d.project_id = ${d.projectId}::uuid`);
    if (d.userId) c.push(sql`d.user_id = ${d.userId}::uuid`);
    if (d.harness) c.push(sql`d.harness = ${d.harness}`);
    if (d.model) c.push(sql`d.model = ${d.model}`);
    q = sql`select case when d.tool = '' then 'name' else 'tool' end as level, d.name, d.tool, sum(d.errors) as errors,
          sum(d.denied) as denied, sum(d.latency_ms) as latency_ms, sum(d.lat0) as lat0, sum(d.lat1) as lat1, sum(d.lat2) as lat2,
          sum(d.lat3) as lat3, sum(d.lat4) as lat4
        from daily_skill_mcp_rollups d ${where(c)} group by 1, 2, 3`;
  } else {
    const flat = (k: string) => sql.raw(k === 'ms' ? `(tl.value->>'ms')::bigint` : `(tl.value->>'${k}')::bigint`);
    const b = (i: number) => sql.raw(`(tl.value->'buckets'->>${i})::bigint`);
    q = sql`with uses as (
          select u.mcp_stats from turns t
          cross join lateral (select t.mcp_stats union all select r.mcp_stats from runs r where r.turn_id = t.id) u
          ${where(turnConds(ctx, d))}
        ), flat as (
          select m.key as name, tl.key as tool, ${flat('errors')} as errors, ${flat('denied')} as denied, ${flat('ms')} as ms,
            ${b(0)} as b0, ${b(1)} as b1, ${b(2)} as b2, ${b(3)} as b3, ${b(4)} as b4
          from uses x cross join lateral jsonb_each(x.mcp_stats) m cross join lateral jsonb_each(m.value) tl
        )
        select 'name' as level, name, '' as tool, sum(errors) as errors, sum(denied) as denied, sum(ms) as latency_ms, sum(b0) as lat0,
          sum(b1) as lat1, sum(b2) as lat2, sum(b3) as lat3, sum(b4) as lat4 from flat group by name
        union all
        select 'tool', name, tool, sum(errors), sum(denied), sum(ms), sum(b0), sum(b1), sum(b2), sum(b3), sum(b4) from flat group by name, tool`;
  }
  const out = await rows<Record<string, unknown>>(ctx.tx, q);
  return new Map(
    out.map((r) => [
      `${String(r.name)}\u0000${r.level === 'name' ? '' : String(r.tool)}`,
      { errors: num(r.errors), denied: num(r.denied), latencyMs: num(r.latency_ms), buckets: [num(r.lat0), num(r.lat1), num(r.lat2), num(r.lat3), num(r.lat4)] },
    ]),
  );
}

export async function getSkillsMcp(ctx: QueryCtx, f: Filters): Promise<SkillsMcpResult> {
  const range = rangeFor(ctx, f);
  const d = dims(ctx, f, range);
  const rollup = range.source === 'rollup';
  const q = ctx.agg
    ? rollup
      ? sql`select level, day::text as day, kind, name, tool, calls, model_calls, user_calls, turns, users from agg_skill_mcp_rollups(${aggArgs(d, 'date')})`
      : sql`select level, day::text as day, kind, name, tool, calls, model_calls, user_calls, turns, users from agg_skill_mcp(${aggArgs(d, 'ts')})`
    : rollup
      ? directRollup(ctx, d)
      : directRaw(ctx, d);
  const out = await rows<Record<string, unknown>>(ctx.tx, q);

  const rel = await reliability(ctx, d, rollup);
  const relOf = (name: string, tool: string): McpReliability => rel.get(`${name}\u0000${tool}`) ?? { errors: 0, denied: 0, latencyMs: 0, buckets: [0, 0, 0, 0, 0] };
  const skills: SkillRow[] = [];
  const servers = new Map<string, McpServerRow>();
  const tools: Array<{ name: string } & McpToolRow> = [];
  const days: SkillMcpDay[] = [];
  for (const r of out) {
    const kind = r.kind === 'mcp' ? 'mcp' : 'skill';
    const name = String(r.name);
    const base = { calls: num(r.calls), turns: num(r.turns), users: num(r.users) };
    if (r.level === 'day') days.push({ day: String(r.day), kind, name, calls: base.calls });
    else if (r.level === 'tool') tools.push({ name, tool: String(r.tool), ...base, ...relOf(name, String(r.tool)) });
    else if (kind === 'skill') skills.push({ name, ...base, modelCalls: num(r.model_calls), userCalls: num(r.user_calls) });
    else servers.set(name, { name, ...base, ...relOf(name, ''), tools: [] });
  }
  for (const t of tools) {
    const { name: _n, ...row } = t;
    servers.get(t.name)?.tools.push(row);
  }
  const byCalls = <T extends { calls: number }>(key: (x: T) => string) => (a: T, b: T) => b.calls - a.calls || key(a).localeCompare(key(b));
  for (const s of servers.values()) s.tools.sort(byCalls((x) => x.tool));
  days.sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  // Effort is not a dimension of skill / MCP rows except on the direct raw path (the turn's effort).
  const effortIgnored = Boolean(d.effort) && (ctx.agg || rollup);
  return {
    range,
    skills: skills.sort(byCalls((x) => x.name)),
    servers: [...servers.values()].sort(byCalls((x) => x.name)),
    days,
    ignoredFilters: effortIgnored ? ['effort'] : [],
  };
}
