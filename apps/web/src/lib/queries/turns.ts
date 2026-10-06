import { sql, type SQL } from 'drizzle-orm';
import type { Attribution, Outcome } from '@ai-obs/db';
import type { CostValue } from '../cost';
import { CostSum, ZERO_COST } from '../cost';
import type { Filters } from '../filters';
import { listProjects, listTeams } from './lookups';
import { aggArgs, dims, turnConds, type Dims } from './providers';
import { addDays, dayString, rawRange, rangeFor, type ResolvedRange } from './range';
import { buildRunTree, buildTimeline, type RunNode, type RunRow, type TimelineItem } from './runs-tree';
import { canSeeUsers, type QueryCtx } from './scope';
import { addTokens, AGG_PAGE, costTokens, emptyTokens, num, rows, tokensOf, where, type TokenTotals } from './sqlutil';

export interface TurnListRow {
  id: string;
  startedMs: number;
  durationMs: number;
  teamId: string;
  teamName: string | null;
  projectId: string | null;
  projectName: string | null;
  harness: string;
  model: string | null;
  effort: string | null;
  tokens: TokenTotals;
  /**
   * ≈ cost of the turn, priced per usage row (model x day) like every other view (ADR-0015), so a
   * mixed-model turn is not billed entirely at its primary model and the page's rows add up to the KPI.
   */
  cost: CostValue;
  outcome: Outcome;
  summary: string | null;
  /** The viewer's own turn (always true on the direct path for members). */
  isMine: boolean;
  /** Direct path only. */
  attribution: Attribution | null;
  /** Present ONLY when the viewer may see individuals (canSeeUsers); never on the aggregate path. */
  userId?: string | null;
  userName?: string | null;
}

export interface TurnListOptions {
  /** 1-based. */
  page?: number;
  pageSize?: number;
  outcome?: Outcome | null;
}

export interface TurnListResult {
  range: ResolvedRange;
  rows: TurnListRow[];
  page: number;
  pageSize: number;
  /** null on the aggregate path (the functions do not count). */
  total: number | null;
  hasNext: boolean;
  ignoredFilters: string[];
}

export const TURN_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const AGG_EFFORT_SCAN_PAGES = 10;

type Lookups = { team: Map<string, string>; project: Map<string, string> };
async function lookups(ctx: QueryCtx): Promise<Lookups> {
  const [teams, projects] = await Promise.all([listTeams(ctx), listProjects(ctx)]);
  return { team: new Map(teams.map((t) => [t.id, t.name])), project: new Map(projects.map((p) => [p.id, p.name])) };
}

function mapRow(r: Record<string, unknown>, lk: Lookups, withUsers: boolean, cost: CostValue): TurnListRow {
  const tokens = tokensOf(r);
  const startedMs = num(r.started_ms);
  const model = (r.model as string | null) ?? null;
  const row: TurnListRow = {
    id: String(r.id),
    startedMs,
    durationMs: num(r.duration_ms),
    teamId: String(r.team_id),
    teamName: lk.team.get(String(r.team_id)) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    projectName: r.project_id ? (lk.project.get(String(r.project_id)) ?? null) : null,
    harness: String(r.harness),
    model,
    effort: (r.effort as string | null) ?? null,
    tokens,
    cost,
    outcome: r.outcome as Outcome,
    summary: (r.summary as string | null) ?? null,
    isMine: Boolean(r.is_mine),
    attribution: (r.attribution as Attribution | null) ?? null,
  };
  if (withUsers) {
    row.userId = (r.user_id as string | null) ?? null;
    row.userName = (r.user_name as string | null) ?? null;
  }
  return row;
}

// started_raw / started_next: the exact start (microseconds) and the next microsecond, as text, for keyset
// paging and for finding a turn's usage through the aggregate functions.
const LIST_COLS = sql.raw(
  `t.id, (extract(epoch from t.started_at) * 1000)::bigint as started_ms, t.started_at::text as started_raw, ` +
    `(t.started_at + interval '1 microsecond')::text as started_next, t.duration_ms, t.team_id, t.project_id, t.harness, ` +
    `t.model, t.effort, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.reasoning_tokens, ` +
    `t.outcome, t.summary, t.attribution`,
);

/** Direct path page: stable order (started_at desc, id); `after` = keyset cursor (the last row of the previous page). */
async function directRows(
  ctx: QueryCtx,
  d: Dims,
  outcome: Outcome | null,
  withUsers: boolean,
  limit: number,
  offset: number,
  after: { raw: string; id: string } | null,
): Promise<Record<string, unknown>[]> {
  const conds = turnConds(ctx, d);
  if (outcome) conds.push(sql`t.outcome = ${outcome}::outcome`);
  if (after) conds.push(sql`(t.started_at < ${after.raw}::timestamptz or (t.started_at = ${after.raw}::timestamptz and t.id > ${after.id}::uuid))`);
  const userCols: SQL = withUsers ? sql`, t.user_id, u.name as user_name` : sql``;
  const join: SQL = withUsers ? sql`left join users u on u.id = t.user_id and u.company_id = t.company_id` : sql``;
  return rows<Record<string, unknown>>(
    ctx.tx,
    sql`select ${LIST_COLS}, (t.user_id = ${ctx.viewer.id}::uuid) as is_mine ${userCols}
        from turns t ${join} ${where(conds)} order by t.started_at desc, t.id limit ${limit} offset ${offset}`,
  );
}

type UsageLine = { turnId: string; day: string; model: string; tokens: TokenTotals };

/** Folds usage lines into one cost per turn: priced per (model, day); a turn without usage rows costs $0, as in the KPIs. */
function foldCosts(ctx: QueryCtx, ids: string[], lines: UsageLine[], fallback: Map<string, Record<string, unknown>> = new Map()): Map<string, CostValue> {
  const sums = new Map<string, CostSum>();
  for (const l of lines) {
    if (l.tokens.total <= 0) continue; // zeroed leftover of a re-sent turn
    let cs = sums.get(l.turnId);
    if (!cs) sums.set(l.turnId, (cs = new CostSum(ctx.prices)));
    cs.add(l.model, l.day, costTokens(l.tokens));
  }
  const out = new Map<string, CostValue>();
  for (const id of ids) {
    const fb = fallback.get(id);
    if (fb) {
      // Not separable (see aggTurnCosts): the whole total at the primary model.
      const cs = new CostSum(ctx.prices);
      cs.add((fb.model as string | null) ?? null, dayString(num(fb.started_ms)), costTokens(tokensOf(fb)));
      out.set(id, cs.value());
    } else out.set(id, sums.get(id)?.value() ?? ZERO_COST);
  }
  return out;
}

const USAGE_SUMS = sql.raw(
  `sum(u.input_tokens)::bigint as input_tokens, sum(u.output_tokens)::bigint as output_tokens, sum(u.cache_read_tokens)::bigint as cache_read_tokens, ` +
    `sum(u.cache_write_tokens)::bigint as cache_write_tokens, sum(u.reasoning_tokens)::bigint as reasoning_tokens`,
);

/** Direct path: usage rows of the given turns (RLS decides what the viewer sees), priced per model and day. */
async function directTurnCosts(ctx: QueryCtx, list: Record<string, unknown>[]): Promise<Map<string, CostValue>> {
  const ids = list.map((r) => String(r.id));
  if (ids.length === 0) return new Map();
  const out = await rows<Record<string, unknown>>(
    ctx.tx,
    sql`select u.turn_id, (u.started_at at time zone 'UTC')::date::text as day, u.model, ${USAGE_SUMS}
        from usage u where u.company_id = ${ctx.viewer.companyId}::uuid and u.turn_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        group by 1, 2, 3`,
  );
  return foldCosts(ctx, ids, out.map((r) => ({ turnId: String(r.turn_id), day: String(r.day), model: String(r.model), tokens: tokensOf(r) })));
}

/**
 * Aggregate path: there is no per-turn usage function, so each turn's usage is read through
 * agg_usage_daily over the one-microsecond window that holds its start (agg_turns_daily counts the
 * turns in that window). When several visible turns share the exact microsecond their usage cannot be
 * told apart; those turns fall back to the whole total at the primary model (rare; a per-turn
 * agg function would remove the fallback).
 */
async function aggTurnCosts(ctx: QueryCtx, list: Record<string, unknown>[]): Promise<Map<string, CostValue>> {
  const ids = list.map((r) => String(r.id));
  if (ids.length === 0) return new Map();
  // Turns of this page that share a start cannot be told apart: no need to ask the database.
  const starts = new Map<string, number>();
  for (const r of list) starts.set(String(r.started_raw), (starts.get(String(r.started_raw)) ?? 0) + 1);
  const tied = list.filter((r) => (starts.get(String(r.started_raw)) ?? 0) > 1);
  const single = list.filter((r) => (starts.get(String(r.started_raw)) ?? 0) === 1);
  if (single.length === 0) return foldCosts(ctx, ids, [], new Map(tied.map((r) => [String(r.id), r] as const)));
  const values = sql.join(
    single.map((r) => sql`(${String(r.id)}::uuid, ${String(r.started_raw)}::timestamptz, ${String(r.started_next)}::timestamptz, ${(r.team_id as string | null) ?? null}::uuid, ${(r.project_id as string | null) ?? null}::uuid, ${String(r.harness)}::text)`),
    sql`, `,
  );
  const out = await rows<Record<string, unknown>>(
    ctx.tx,
    sql`select v.id as turn_id,
          (select coalesce(sum(a.turns), 0) from agg_turns_daily(v.ts, v.ts_next, v.team_id, v.project_id, v.harness, null::text) a) as n,
          u.day::text as day, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.reasoning_tokens
        from (values ${values}) as v(id, ts, ts_next, team_id, project_id, harness)
        left join lateral agg_usage_daily(v.ts, v.ts_next, v.team_id, v.project_id, v.harness, null::text) u on true`,
  );
  const shared = new Set(out.filter((r) => num(r.n) !== 1).map((r) => String(r.turn_id)));
  const fallback = new Map(list.filter((r) => shared.has(String(r.id)) || (starts.get(String(r.started_raw)) ?? 0) > 1).map((r) => [String(r.id), r] as const));
  return foldCosts(
    ctx,
    ids,
    out.filter((r) => r.model !== null && r.model !== undefined).map((r) => ({ turnId: String(r.turn_id), day: String(r.day), model: String(r.model), tokens: tokensOf(r) })),
    fallback,
  );
}

const turnCosts = (ctx: QueryCtx, list: Record<string, unknown>[]) => (ctx.agg ? aggTurnCosts(ctx, list) : directTurnCosts(ctx, list));

/** Filterable, paged turn list (newest first). Raw rows for every range. */
export async function listTurns(ctx: QueryCtx, f: Filters, opts: TurnListOptions = {}): Promise<TurnListResult> {
  const range = rawRange(rangeFor(ctx, f));
  const d = dims(ctx, f, range);
  const pageSize = Math.min(Math.max(1, Math.floor(opts.pageSize ?? TURN_PAGE_SIZE)), MAX_PAGE_SIZE);
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const offset = (page - 1) * pageSize;
  const lk = await lookups(ctx);
  const withUsers = !ctx.agg && canSeeUsers(ctx.viewer);

  if (!ctx.agg) {
    const conds = turnConds(ctx, d);
    if (opts.outcome) conds.push(sql`t.outcome = ${opts.outcome}::outcome`);
    const [list, totalRow] = await Promise.all([
      directRows(ctx, d, opts.outcome ?? null, withUsers, pageSize + 1, offset, null),
      rows<{ n: unknown }>(ctx.tx, sql`select count(*) as n from turns t ${where(conds)}`),
    ]);
    const pageRows = list.slice(0, pageSize);
    const costs = await turnCosts(ctx, pageRows);
    return {
      range,
      rows: pageRows.map((r) => mapRow(r, lk, withUsers, costs.get(String(r.id)) ?? ZERO_COST)),
      page,
      pageSize,
      total: num(totalRow[0]?.n),
      hasNext: list.length > pageSize,
      ignoredFilters: [],
    };
  }

  // Aggregate path: no user_id ever. agg_turn_list has no effort argument; with the filter we scan
  // pages and keep matches.
  const want = offset + pageSize + 1;
  const picked: Record<string, unknown>[] = [];
  if (!d.effort) {
    picked.push(...(await aggPage(ctx, d, opts.outcome ?? null, pageSize + 1, offset)));
    return await finishAgg(ctx, range, picked, lk, page, pageSize, picked.length > pageSize);
  }
  for (let i = 0; i < AGG_EFFORT_SCAN_PAGES && picked.length < want; i++) {
    const batch = await aggPage(ctx, d, opts.outcome ?? null, AGG_PAGE, i * AGG_PAGE);
    picked.push(...batch.filter((r) => r.effort === d.effort));
    if (batch.length < AGG_PAGE) break;
  }
  return await finishAgg(ctx, range, picked.slice(offset), lk, page, pageSize, picked.length > offset + pageSize);
}

async function finishAgg(ctx: QueryCtx, range: ResolvedRange, list: Record<string, unknown>[], lk: Lookups, page: number, pageSize: number, hasNext: boolean): Promise<TurnListResult> {
  const pageRows = list.slice(0, pageSize);
  const costs = await aggTurnCosts(ctx, pageRows);
  return { range, rows: pageRows.map((r) => mapRow(r, lk, false, costs.get(String(r.id)) ?? ZERO_COST)), page, pageSize, total: null, hasNext, ignoredFilters: [] };
}

async function aggPage(ctx: QueryCtx, d: Dims, outcome: Outcome | null, limit: number, offset: number) {
  return rows<Record<string, unknown>>(
    ctx.tx,
    sql`select id, (extract(epoch from started_at) * 1000)::bigint as started_ms, started_at::text as started_raw,
          (started_at + interval '1 microsecond')::text as started_next, duration_ms, team_id, project_id, harness, model,
          effort, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, outcome, summary,
          is_mine, null::text as attribution
        from agg_turn_list(${aggArgs(d, 'ts')}, ${outcome}::outcome, ${limit}, ${offset})`,
  );
}

/** Most turns one CSV export holds. Beyond it the export is cut at the newest rows and says so (`truncated`). */
export const EXPORT_MAX_ROWS = 50_000;
const EXPORT_PAGE = 500;

export interface TurnExport {
  rows: TurnListRow[];
  /** More turns matched than `max`: the oldest were left out. */
  truncated: boolean;
}

/**
 * Every turn matching the filters, newest first, up to `max` (CSV export). Pages by keyset, not offset,
 * so rows that start at the same instant are neither repeated nor skipped:
 *  - direct path: (started_at, id) cursor;
 *  - aggregate path: agg_turn_list orders by started_at only, so the window's upper bound moves down to the
 *    last start and the whole group of turns that share it is fetched in one call.
 */
export async function exportTurns(ctx: QueryCtx, f: Filters, opts: { outcome?: Outcome | null; max?: number } = {}): Promise<TurnExport> {
  const max = Math.max(1, Math.floor(opts.max ?? EXPORT_MAX_ROWS));
  const outcome = opts.outcome ?? null;
  const range = rawRange(rangeFor(ctx, f));
  const d = dims(ctx, f, range);
  const lk = await lookups(ctx);
  const withUsers = !ctx.agg && canSeeUsers(ctx.viewer);
  const picked: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const take = (batch: Record<string, unknown>[]) => {
    for (const r of batch) {
      const id = String(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (!ctx.agg || !d.effort || r.effort === d.effort) picked.push(r);
    }
  };

  if (!ctx.agg) {
    let after: { raw: string; id: string } | null = null;
    while (picked.length <= max) {
      const page = await directRows(ctx, d, outcome, withUsers, EXPORT_PAGE, 0, after);
      take(page);
      const last = page[page.length - 1];
      if (!last || page.length < EXPORT_PAGE) break;
      after = { raw: String(last.started_raw), id: String(last.id) };
    }
  } else {
    let toIso = d.toIso;
    while (picked.length <= max) {
      const page = await aggPage(ctx, { ...d, toIso }, outcome, EXPORT_PAGE, 0);
      const last = page[page.length - 1];
      if (!last || page.length < EXPORT_PAGE) {
        take(page);
        break;
      }
      // The page may end inside a group of equal start times: keep what is strictly newer, then read the group whole.
      const edge = String(last.started_raw);
      take(page.filter((r) => String(r.started_raw) !== edge));
      take(await aggPage(ctx, { ...d, fromIso: edge, toIso: String(last.started_next) }, outcome, AGG_PAGE, 0));
      toIso = edge;
    }
  }

  const truncated = picked.length > max;
  const kept = picked.slice(0, max);
  const out: TurnListRow[] = [];
  for (let i = 0; i < kept.length; i += EXPORT_PAGE) {
    const chunk = kept.slice(i, i + EXPORT_PAGE);
    const costs = await turnCosts(ctx, chunk);
    for (const r of chunk) out.push(mapRow(r, lk, withUsers, costs.get(String(r.id)) ?? ZERO_COST));
  }
  return { rows: out, truncated };
}

/** The rows of {@link exportTurns} (kept for callers that do not care about truncation). */
export async function listTurnsForExport(ctx: QueryCtx, f: Filters, opts: { outcome?: Outcome | null; max?: number } = {}): Promise<TurnListRow[]> {
  return (await exportTurns(ctx, f, opts)).rows;
}

// ---------------------------------------------------------------------------------------------
// Turn detail
// ---------------------------------------------------------------------------------------------
export interface TurnDetail {
  turn: TurnListRow & {
    endedMs: number;
    phasesMs: Record<string, number> | null;
    tools: Record<string, number> | null;
    /** skills of the turn and its runs (null when limited) */
    skills: Record<string, { model: number; user: number }> | null;
    /** MCP server → tool → calls of the turn and its runs (null when limited) */
    mcp: Record<string, Record<string, number>> | null;
    filesTouched: number | null;
    linesAdded: number | null;
    linesRemoved: number | null;
    outcomeSignals: string[] | null;
    outcomeProvisional: boolean | null;
  };
  runs: RunRow[];
  /** Parent -> child tree of the runs (the main agent is the implicit root). */
  tree: RunNode[];
  /** Gantt-style bars: main agent first, then runs depth-first. */
  timeline: TimelineItem[];
  /** Per model usage of the turn (direct path only; null when the viewer cannot read the usage rows). */
  usage: { model: string; effort: string | null; tokens: TokenTotals; cost: CostValue }[] | null;
  /** true = someone else's turn seen through the aggregate functions: no phases / tools / signals. */
  limited: boolean;
}

/** Skill / MCP counts of a turn and its runs, summed. */
export function mergeUses(uses: Array<{ skills: unknown; mcp: unknown }>): {
  skills: Record<string, { model: number; user: number }>;
  mcp: Record<string, Record<string, number>>;
} {
  const skills: Record<string, { model: number; user: number }> = {};
  const mcp: Record<string, Record<string, number>> = {};
  for (const u of uses) {
    for (const [name, c] of Object.entries((u.skills ?? {}) as Record<string, { model?: number; user?: number }>)) {
      const cur = (skills[name] ??= { model: 0, user: 0 });
      cur.model += num(c?.model);
      cur.user += num(c?.user);
    }
    for (const [server, tools] of Object.entries((u.mcp ?? {}) as Record<string, Record<string, number>>)) {
      const cur = (mcp[server] ??= {});
      for (const [tool, n] of Object.entries(tools ?? {})) cur[tool] = (cur[tool] ?? 0) + num(n);
    }
  }
  return { skills, mcp };
}

/**
 * One turn with its run tree and timeline, or null when it does not exist or the viewer may not see
 * it. `atMs` (the list row's startedMs) lets the aggregate path find someone else's turn without a
 * scan, because agg_turn_list can only be filtered by time.
 */
export async function getTurnDetail(ctx: QueryCtx, turnId: string, atMs?: number): Promise<TurnDetail | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turnId)) return null;
  const lk = await lookups(ctx);
  const withUsers = canSeeUsers(ctx.viewer);

  const userCols: SQL = withUsers ? sql`, t.user_id, u.name as user_name` : sql``;
  const join: SQL = withUsers ? sql`left join users u on u.id = t.user_id and u.company_id = t.company_id` : sql``;
  const [own] = await rows<Record<string, unknown>>(
    ctx.tx,
    sql`select ${LIST_COLS}, (extract(epoch from t.ended_at) * 1000)::bigint as ended_ms, t.phases_ms, t.tools, t.files_touched,
          t.lines_added, t.lines_removed, t.outcome_signals, t.outcome_provisional, t.skills, t.mcp,
          (select coalesce(jsonb_agg(jsonb_build_object('skills', r.skills, 'mcp', r.mcp)), '[]'::jsonb) from runs r
            where r.turn_id = t.id and r.company_id = t.company_id and (r.skills <> '{}'::jsonb or r.mcp <> '{}'::jsonb)) as run_uses,
          (t.user_id = ${ctx.viewer.id}::uuid) as is_mine ${userCols}
        from turns t ${join} where t.id = ${turnId}::uuid and t.company_id = ${ctx.viewer.companyId}::uuid`,
  );

  let base: TurnListRow;
  let extra: Partial<TurnDetail['turn']> = {};
  let limited = false;
  if (own) {
    base = mapRow(own, lk, withUsers && !ctx.agg, ZERO_COST);
    extra = {
      endedMs: num(own.ended_ms),
      phasesMs: (own.phases_ms as Record<string, number>) ?? {},
      tools: (own.tools as Record<string, number>) ?? {},
      ...mergeUses([{ skills: own.skills, mcp: own.mcp }, ...((own.run_uses as Array<{ skills: unknown; mcp: unknown }>) ?? [])]),
      filesTouched: num(own.files_touched),
      linesAdded: num(own.lines_added),
      linesRemoved: num(own.lines_removed),
      outcomeSignals: (own.outcome_signals as string[]) ?? [],
      outcomeProvisional: Boolean(own.outcome_provisional),
    };
  } else if (ctx.agg) {
    const found = await findViaAgg(ctx, turnId, atMs);
    if (!found) return null;
    base = mapRow(found, lk, false, (await aggTurnCosts(ctx, [found])).get(String(found.id)) ?? ZERO_COST);
    extra = { endedMs: base.startedMs + base.durationMs, phasesMs: null, tools: null, skills: null, mcp: null, filesTouched: null, linesAdded: null, linesRemoved: null, outcomeSignals: null, outcomeProvisional: null };
    limited = true;
  } else {
    return null;
  }

  const runRows = await rows<Record<string, unknown>>(
    ctx.tx,
    sql`select id, parent_run_id, agent_type, depth, model, effort, (extract(epoch from started_at) * 1000)::bigint as started_ms,
          (extract(epoch from ended_at) * 1000)::bigint as ended_ms, duration_ms, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, reasoning_tokens, phases_ms, tools, outcome from agg_turn_runs(${turnId}::uuid)`,
  );
  const runs: RunRow[] = runRows.map((r) => ({
    id: String(r.id),
    parentRunId: (r.parent_run_id as string | null) ?? null,
    agentType: String(r.agent_type),
    depth: Number(r.depth),
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    startedMs: num(r.started_ms),
    endedMs: num(r.ended_ms),
    durationMs: num(r.duration_ms),
    tokens: tokensOf(r),
    phasesMs: (r.phases_ms as Record<string, number>) ?? {},
    tools: (r.tools as Record<string, number>) ?? {},
    outcome: r.outcome as Outcome,
  }));
  const tree = buildRunTree(runs, base.startedMs);

  let usage: TurnDetail['usage'] = null;
  if (own) {
    const u = await rows<Record<string, unknown>>(
      ctx.tx,
      sql`select model, effort, (u.started_at at time zone 'UTC')::date::text as day, ${USAGE_SUMS}
          from usage u where u.turn_id = ${turnId}::uuid and u.company_id = ${ctx.viewer.companyId}::uuid
          group by 1, 2, 3 having sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) > 0 order by 1, 2, 3`,
    );
    // One line per model x effort, priced per day; the header is the sum of the same priced groups, so
    // header and lines always agree (and the turn agrees with the KPIs).
    const header = new CostSum(ctx.prices);
    const lines = new Map<string, { model: string; effort: string | null; tokens: TokenTotals; cs: CostSum }>();
    for (const r of u) {
      const model = String(r.model);
      const effort = (r.effort as string | null) ?? null;
      const key = `${model}\u0000${effort ?? ''}`;
      let line = lines.get(key);
      if (!line) lines.set(key, (line = { model, effort, tokens: emptyTokens(), cs: new CostSum(ctx.prices) }));
      const tokens = tokensOf(r);
      addTokens(line.tokens, tokens);
      line.cs.add(model, String(r.day), costTokens(tokens));
      header.add(model, String(r.day), costTokens(tokens));
    }
    usage = [...lines.values()].map((l) => ({ model: l.model, effort: l.effort, tokens: l.tokens, cost: l.cs.value() }));
    base = { ...base, cost: u.length ? header.value() : ZERO_COST };
  }

  const turn = { ...base, ...extra } as TurnDetail['turn'];
  return { turn, runs, tree, timeline: buildTimeline(tree, turn.durationMs), usage, limited };
}

async function findViaAgg(ctx: QueryCtx, turnId: string, atMs?: number): Promise<Record<string, unknown> | null> {
  const empty = { teamId: null, projectId: null, userId: null, harness: null, model: null, effort: null };
  if (atMs !== undefined && Number.isFinite(atMs)) {
    const d: Dims = { ...empty, fromDay: '', toDay: '', fromIso: new Date(Math.floor(atMs)).toISOString(), toIso: new Date(Math.floor(atMs) + 1).toISOString() };
    return (await aggPage(ctx, d, null, 20, 0)).find((r) => String(r.id) === turnId) ?? null;
  }
  const today = dayString(ctx.now.getTime());
  const d: Dims = { ...empty, fromDay: '', toDay: '', fromIso: `${addDays(today, -35)}T00:00:00Z`, toIso: `${addDays(today, 1)}T00:00:00Z` };
  for (let i = 0; i < 3; i++) {
    const batch = await aggPage(ctx, d, null, AGG_PAGE, i * AGG_PAGE);
    const hit = batch.find((r) => String(r.id) === turnId);
    if (hit) return hit;
    if (batch.length < AGG_PAGE) break;
  }
  return null;
}
