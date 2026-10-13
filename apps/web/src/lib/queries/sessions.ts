import { sql, type SQL } from 'drizzle-orm';
import type { Outcome } from '@ai-obs/db';
import type { CostValue } from '../cost';
import { CostSum, ZERO_COST } from '../cost';
import type { Filters } from '../filters';
import { agentGroupOf } from './agent-groups';
import { buildFlows, readFlowInputs, type Flow, type FlowRunInput } from './flows';
import { listProjects, listTeams } from './lookups';
import { dims, turnConds } from './providers';
import { addDays, rawRange, rangeFor, type ResolvedRange } from './range';
import { canSeeUsers, type QueryCtx } from './scope';
import { costTokens, num, rows, tokensOf, where, type Outcomes, type TokenTotals } from './sqlutil';
import { mergeUses } from './turns';

/**
 * Sessions view (ADR-0026, docs/briefs/sessions-view.md): one row per harness session (`agent_sessions`) with its
 * turns, sub-agent runs, workflows and flows. Always read from the tables under RLS, never through agg_* functions:
 * a session is one person's stream of work, so in aggregates-only mode a lead / admin sees only their own sessions
 * (RLS already limits them to their own rows; the queries say so explicitly as well).
 *
 * A session's span runs from its first activity (the session start or its first turn, whichever is earlier) to its
 * last (the latest of its last turn end, last run end and `ended_at`): Workflow agents outlive the turn that launched
 * them (ADR-0019).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `session` search param (an `agent_sessions.id`); null when absent or not a uuid. */
export function parseSessionId(v: string | string[] | null | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && UUID_RE.test(s) ? s.toLowerCase() : null;
}

/** Sessions per page of the list. */
export const SESSION_PAGE_SIZE = 50;
const SESSION_MAX_PAGE_SIZE = 500;
/** Most sessions one CSV export holds. */
export const SESSION_EXPORT_MAX = 5_000;
/** A session without a `session_end` counts as open while its last activity is younger than this. */
export const SESSION_OPEN_MS = 30 * 60_000;
/** Sessions are found through turns that started up to this long before the range (runs may reach into it). */
const CANDIDATE_SLACK_DAYS = 1;
/** Characters of the harness session id in the fallback title. */
const SHORT_ID = 8;

/** The harness's own session id (what `claude --resume` takes): the stored key without its `<harness>:` prefix. */
export function harnessSessionId(externalId: string, harness: string): string {
  return externalId.startsWith(`${harness}:`) ? externalId.slice(harness.length + 1) : externalId;
}

/**
 * Title of a session, in one place: the stored title (from the harness, ADR-0026 phase 2) when there is one, else the
 * summary of its first summarized turn, else "Session <first 8 chars of the harness id>".
 */
export function sessionTitle(s: { title?: string | null; firstSummary: string | null; harnessSessionId: string }): string {
  const stored = s.title?.trim();
  if (stored) return stored;
  const summary = s.firstSummary?.trim();
  if (summary) return summary;
  return `Session ${s.harnessSessionId.slice(0, SHORT_ID)}`;
}

/** The command that resumes the session in its harness; null for a harness without a known one. */
export function resumeCommand(harness: string, id: string): string | null {
  if (harness === 'claude-code') return `claude --resume ${id}`;
  if (harness === 'codex') return `codex resume ${id}`;
  return null;
}

export interface SessionRow {
  /** `agent_sessions.id` */
  id: string;
  /** The harness's own session id (`claude --resume <id>`). */
  harnessSessionId: string;
  harness: string;
  title: string;
  projectId: string | null;
  projectName: string | null;
  teamId: string | null;
  teamName: string | null;
  /** First activity (session start or first turn). */
  startedMs: number;
  /** Last activity (last turn end, last run end or session end). */
  lastActivityMs: number;
  /** startedMs → lastActivityMs. */
  spanMs: number;
  /** From `session_end`; null when it never arrived. */
  endedMs: number | null;
  endReason: string | null;
  /** No `session_end` and the last activity is younger than SESSION_OPEN_MS. */
  open: boolean;
  turns: number;
  runs: number;
  /** Distinct Workflow-tool runs (`orchestration_id`). */
  workflows: number;
  /** Agent flows (≥ 2 steps, ADR-0020) of the session's turns. */
  flows: number;
  tokens: TokenTotals;
  /** ≈ cost of the session's usage rows, priced per model and day (as the turns list). */
  cost: CostValue;
  outcomes: Outcomes;
  isMine: boolean;
  /** Present ONLY when the viewer may see individuals (canSeeUsers). */
  userId?: string | null;
  userName?: string | null;
}

export interface SessionListOptions {
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export interface SessionListResult {
  range: ResolvedRange;
  rows: SessionRow[];
  page: number;
  pageSize: number;
  total: number;
  /** true = a lead / admin in aggregates-only mode: only the viewer's own sessions are listed. */
  ownOnly: boolean;
  /** Some page sessions have more runs than were read: their flow counts may be low. */
  flowsTruncated: boolean;
}

const MS = (col: string) => sql.raw(`(extract(epoch from ${col}) * 1000)::bigint`);

/**
 * One row per session of `cand` (a query returning `session_id`), with whole-session totals (every visible turn and
 * run of the session, not only those of the filter range). `span` limits to sessions whose span overlaps it.
 */
function sessionSql(ctx: QueryCtx, cand: SQL, opts: { span?: { fromIso: string; toIso: string }; withUsers: boolean; tail: SQL }): SQL {
  const own = ctx.agg ? sql`and s.user_id = ${ctx.viewer.id}::uuid` : sql``;
  const userCols = opts.withUsers ? sql`, x.user_id, coalesce(u.name, u.email) as user_name` : sql``;
  const userJoin = opts.withUsers ? sql`left join users u on u.id = x.user_id` : sql``;
  const span = opts.span ? sql`where x.span_start < ${opts.span.toIso}::timestamptz and x.span_end >= ${opts.span.fromIso}::timestamptz` : sql``;
  return sql`
    with cand as (${cand}),
    st as (
      select t.session_id, min(t.started_at) as first_turn_at, max(t.ended_at) as last_turn_end, count(*) as turns,
        count(*) filter (where t.outcome = 'success') as success, count(*) filter (where t.outcome = 'failed') as failed,
        count(*) filter (where t.outcome = 'abandoned') as abandoned, count(*) filter (where t.outcome = 'unknown') as unknown,
        sum(t.input_tokens)::bigint as input_tokens, sum(t.output_tokens)::bigint as output_tokens,
        sum(t.cache_read_tokens)::bigint as cache_read_tokens, sum(t.cache_write_tokens)::bigint as cache_write_tokens,
        sum(t.reasoning_tokens)::bigint as reasoning_tokens,
        (array_agg(t.summary order by t.started_at, t.id) filter (where t.summary is not null and t.summary <> ''))[1] as first_summary,
        (array_agg(t.project_id order by t.started_at, t.id) filter (where t.project_id is not null))[1] as turn_project_id,
        (array_agg(t.team_id order by t.started_at, t.id) filter (where t.team_id is not null))[1] as turn_team_id
      from turns t join cand c on c.session_id = t.session_id
      where t.company_id = ${ctx.viewer.companyId}::uuid
      group by t.session_id
    ),
    rs as (
      select t.session_id, count(r.id) as runs, count(distinct r.orchestration_id) as workflows, max(r.ended_at) as last_run_end
      from turns t join cand c on c.session_id = t.session_id join runs r on r.turn_id = t.id and r.company_id = t.company_id
      where t.company_id = ${ctx.viewer.companyId}::uuid
      group by t.session_id
    ),
    x as (
      select s.id, s.external_id, s.harness, s.title, s.user_id, s.end_reason,
        coalesce(s.project_id, st.turn_project_id) as project_id, coalesce(s.team_id, st.turn_team_id) as team_id,
        least(s.started_at, st.first_turn_at) as span_start,
        greatest(st.last_turn_end, rs.last_run_end, s.ended_at) as span_end,
        s.ended_at, st.turns, coalesce(rs.runs, 0) as runs, coalesce(rs.workflows, 0) as workflows,
        st.success, st.failed, st.abandoned, st.unknown, st.input_tokens, st.output_tokens, st.cache_read_tokens,
        st.cache_write_tokens, st.reasoning_tokens, st.first_summary
      from agent_sessions s join st on st.session_id = s.id left join rs on rs.session_id = s.id
      where s.company_id = ${ctx.viewer.companyId}::uuid ${own}
    )
    select x.*, ${MS('x.span_start')} as span_start_ms, ${MS('x.span_end')} as span_end_ms, ${MS('x.ended_at')} as ended_ms,
      (x.user_id is not distinct from ${ctx.viewer.id}::uuid) as is_mine, count(*) over () as total ${userCols}
    from x ${userJoin} ${span}
    ${opts.tail}`;
}

type Lookups = { team: Map<string, string>; project: Map<string, string> };
async function lookups(ctx: QueryCtx): Promise<Lookups> {
  const [teams, projects] = await Promise.all([listTeams(ctx), listProjects(ctx)]);
  return { team: new Map(teams.map((t) => [t.id, t.name])), project: new Map(projects.map((p) => [p.id, p.name])) };
}

/** A sessionSql row → SessionRow (flows and cost are filled in by the caller). */
export function mapSessionRow(r: Record<string, unknown>, lk: Lookups, withUsers: boolean, nowMs: number): SessionRow {
  const harness = String(r.harness);
  const hid = harnessSessionId(String(r.external_id), harness);
  const startedMs = num(r.span_start_ms);
  const lastActivityMs = Math.max(startedMs, num(r.span_end_ms));
  const endedMs = r.ended_ms === null || r.ended_ms === undefined ? null : num(r.ended_ms);
  const projectId = (r.project_id as string | null) ?? null;
  const teamId = (r.team_id as string | null) ?? null;
  const row: SessionRow = {
    id: String(r.id),
    harnessSessionId: hid,
    harness,
    title: sessionTitle({ title: (r.title as string | null | undefined) ?? null, firstSummary: (r.first_summary as string | null) ?? null, harnessSessionId: hid }),
    projectId,
    projectName: projectId ? (lk.project.get(projectId) ?? null) : null,
    teamId,
    teamName: teamId ? (lk.team.get(teamId) ?? null) : null,
    startedMs,
    lastActivityMs,
    spanMs: lastActivityMs - startedMs,
    endedMs,
    endReason: (r.end_reason as string | null) ?? null,
    open: endedMs === null && nowMs - lastActivityMs < SESSION_OPEN_MS,
    turns: num(r.turns),
    runs: num(r.runs),
    workflows: num(r.workflows),
    flows: 0,
    tokens: tokensOf(r),
    cost: ZERO_COST,
    outcomes: { success: num(r.success), failed: num(r.failed), abandoned: num(r.abandoned), unknown: num(r.unknown) },
    isMine: Boolean(r.is_mine),
  };
  if (withUsers) {
    row.userId = (r.user_id as string | null) ?? null;
    row.userName = (r.user_name as string | null) ?? null;
  }
  return row;
}

const USAGE_SUMS = sql.raw(
  `sum(u.input_tokens)::bigint as input_tokens, sum(u.output_tokens)::bigint as output_tokens, sum(u.cache_read_tokens)::bigint as cache_read_tokens, ` +
    `sum(u.cache_write_tokens)::bigint as cache_write_tokens, sum(u.reasoning_tokens)::bigint as reasoning_tokens`,
);
const idList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

/**
 * ≈ cost per key (`by` = 'session' or 'turn') of the usage rows of the given sessions, priced per model and UTC day;
 * a key without usage costs $0, as everywhere else.
 */
async function usageCosts(ctx: QueryCtx, sessionIds: string[], by: 'session' | 'turn'): Promise<Map<string, CostValue>> {
  if (sessionIds.length === 0) return new Map();
  const key = by === 'session' ? sql`t.session_id` : sql`t.id`;
  const out = await rows<Record<string, unknown>>(
    ctx.tx,
    sql`select ${key} as k, (u.started_at at time zone 'UTC')::date::text as day, u.model, ${USAGE_SUMS}
        from usage u join turns t on t.id = u.turn_id and t.company_id = u.company_id
        where t.company_id = ${ctx.viewer.companyId}::uuid and t.session_id in (${idList(sessionIds)})
        group by 1, 2, 3`,
  );
  const sums = new Map<string, CostSum>();
  for (const r of out) {
    const tokens = tokensOf(r);
    if (tokens.total <= 0) continue; // zeroed leftover of a re-sent turn
    const k = String(r.k);
    let cs = sums.get(k);
    if (!cs) sums.set(k, (cs = new CostSum(ctx.prices)));
    cs.add(String(r.model), String(r.day), costTokens(tokens));
  }
  return new Map([...sums].map(([k, cs]) => [k, cs.value()]));
}

/** Runs, links and flows of the given sessions' turns (raw, under RLS). */
async function sessionFlows(ctx: QueryCtx, sessionIds: string[]) {
  const input = await readFlowInputs(ctx, [sql`t.company_id = ${ctx.viewer.companyId}::uuid`, sql`t.session_id in (${idList(sessionIds)})`]);
  const flows = buildFlows({ runs: input.runs, turns: input.turns, links: input.links, prices: ctx.prices });
  return { ...input, flows };
}

/** Candidate sessions of the filter range: those with a turn matching the filters started in it (or just before). */
function candidates(ctx: QueryCtx, f: Filters, range: ResolvedRange): SQL {
  const d = dims(ctx, f, range);
  const conds = turnConds(ctx, { ...d, fromIso: `${addDays(range.fromDay, -CANDIDATE_SLACK_DAYS)}T00:00:00Z` });
  conds.push(sql`t.session_id is not null`);
  return sql`select distinct t.session_id from turns t ${where(conds)}`;
}

/**
 * Sessions whose span overlaps the filter range and that have a turn matching the filters, newest first, paged.
 * Totals are whole-session. Raw rows only (sessions follow raw retention, ADR-0012).
 */
export async function listSessions(ctx: QueryCtx, f: Filters, opts: SessionListOptions = {}): Promise<SessionListResult> {
  const range = rawRange(rangeFor(ctx, f));
  const pageSize = Math.min(Math.max(1, Math.floor(opts.pageSize ?? SESSION_PAGE_SIZE)), SESSION_MAX_PAGE_SIZE);
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const withUsers = !ctx.agg && canSeeUsers(ctx.viewer);
  const [lk, list] = await Promise.all([
    lookups(ctx),
    rows<Record<string, unknown>>(
      ctx.tx,
      sessionSql(ctx, candidates(ctx, f, range), {
        span: { fromIso: range.fromIso, toIso: range.toIso },
        withUsers,
        tail: sql`order by x.span_start desc, x.id limit ${pageSize} offset ${(page - 1) * pageSize}`,
      }),
    ),
  ]);
  const { rows: out, flowsTruncated } = await finishRows(ctx, list, lk, withUsers);
  let total = num(list[0]?.total);
  if (list.length === 0 && page > 1) {
    // A page past the end has no row to carry the count: count without paging, so the pager can lead back.
    const [r] = await rows<Record<string, unknown>>(
      ctx.tx,
      sessionSql(ctx, candidates(ctx, f, range), { span: { fromIso: range.fromIso, toIso: range.toIso }, withUsers: false, tail: sql`limit 1` }),
    );
    total = num(r?.total);
  }
  return { range, rows: out, page, pageSize, total, ownOnly: ctx.agg, flowsTruncated };
}

/** Every session of the list (newest first, up to `max`), for the CSV export. */
export async function exportSessions(ctx: QueryCtx, f: Filters, max = SESSION_EXPORT_MAX): Promise<{ rows: SessionRow[]; truncated: boolean }> {
  const range = rawRange(rangeFor(ctx, f));
  const withUsers = !ctx.agg && canSeeUsers(ctx.viewer);
  const [lk, list] = await Promise.all([
    lookups(ctx),
    rows<Record<string, unknown>>(
      ctx.tx,
      sessionSql(ctx, candidates(ctx, f, range), {
        span: { fromIso: range.fromIso, toIso: range.toIso },
        withUsers,
        tail: sql`order by x.span_start desc, x.id limit ${max + 1}`,
      }),
    ),
  ]);
  const kept = list.slice(0, max);
  const out: SessionRow[] = [];
  for (let i = 0; i < kept.length; i += SESSION_PAGE_SIZE) out.push(...(await finishRows(ctx, kept.slice(i, i + SESSION_PAGE_SIZE), lk, withUsers)).rows);
  return { rows: out, truncated: list.length > max };
}

async function finishRows(ctx: QueryCtx, list: Record<string, unknown>[], lk: Lookups, withUsers: boolean): Promise<{ rows: SessionRow[]; flowsTruncated: boolean }> {
  const ids = list.map((r) => String(r.id));
  if (ids.length === 0) return { rows: [], flowsTruncated: false };
  const [costs, fl] = await Promise.all([usageCosts(ctx, ids, 'session'), sessionFlows(ctx, ids)]);
  const sessionOfTurn = new Map<string, string>();
  const turnRows = await rows<{ id: string; session_id: string }>(
    ctx.tx,
    sql`select t.id, t.session_id from turns t where t.company_id = ${ctx.viewer.companyId}::uuid and t.session_id in (${idList(ids)})`,
  );
  for (const t of turnRows) sessionOfTurn.set(String(t.id), String(t.session_id));
  const flowCount = new Map<string, number>();
  for (const x of fl.flows) {
    const s = sessionOfTurn.get(x.turnId);
    if (s) flowCount.set(s, (flowCount.get(s) ?? 0) + 1);
  }
  const nowMs = ctx.now.getTime();
  return {
    rows: list.map((r) => ({ ...mapSessionRow(r, lk, withUsers, nowMs), cost: costs.get(String(r.id)) ?? ZERO_COST, flows: flowCount.get(String(r.id)) ?? 0 })),
    flowsTruncated: fl.truncated,
  };
}

// ---------------------------------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------------------------------

export interface SessionTurn {
  id: string;
  startedMs: number;
  endedMs: number;
  durationMs: number;
  model: string | null;
  effort: string | null;
  tokens: TokenTotals;
  cost: CostValue;
  outcome: Outcome;
  summary: string | null;
  runs: number;
}

/** One Workflow-tool run of the session (its agents share an `orchestration_id`). */
export interface SessionWorkflow {
  orchestrationId: string;
  turnId: string;
  turnStartedMs: number;
  steps: number;
  startedMs: number;
  endedMs: number;
  /** The flow made of it (≥ 2 steps), for the link; null for a one-agent workflow. */
  flow: Flow | null;
}

export interface SessionDetail {
  session: SessionRow;
  turns: SessionTurn[];
  runs: FlowRunInput[];
  flows: Flow[];
  workflows: SessionWorkflow[];
  skills: Record<string, { model: number; user: number }>;
  mcp: Record<string, Record<string, number>>;
  /** The session started before the raw retention cutoff: its oldest turns may have been deleted. */
  retentionCut: boolean;
  /** More runs or links than one read holds: some runs and flows are missing. */
  truncated: boolean;
}

/** One session with its turns (oldest first), runs, flows and workflows; null when missing or not visible. */
export async function getSessionDetail(ctx: QueryCtx, sessionId: string): Promise<SessionDetail | null> {
  const id = parseSessionId(sessionId);
  if (!id) return null;
  const withUsers = !ctx.agg && canSeeUsers(ctx.viewer);
  const [lk, list] = await Promise.all([
    lookups(ctx),
    rows<Record<string, unknown>>(ctx.tx, sessionSql(ctx, sql`select ${id}::uuid as session_id`, { withUsers, tail: sql`` })),
  ]);
  const head = list[0];
  if (!head) return null;

  const [turnRows, costs, sessionCost, fl] = await Promise.all([
    rows<Record<string, unknown>>(
      ctx.tx,
      sql`select t.id, ${MS('t.started_at')} as started_ms, ${MS('t.ended_at')} as ended_ms, t.duration_ms, t.model, t.effort,
            t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens, t.reasoning_tokens, t.outcome, t.summary,
            t.skills, t.mcp,
            (select count(*) from runs r where r.turn_id = t.id and r.company_id = t.company_id) as runs
          from turns t where t.company_id = ${ctx.viewer.companyId}::uuid and t.session_id = ${id}::uuid
          order by t.started_at, t.id`,
    ),
    usageCosts(ctx, [id], 'turn'),
    usageCosts(ctx, [id], 'session'),
    sessionFlows(ctx, [id]),
  ]);

  const turns: SessionTurn[] = turnRows.map((r) => ({
    id: String(r.id),
    startedMs: num(r.started_ms),
    endedMs: num(r.ended_ms),
    durationMs: num(r.duration_ms),
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    tokens: tokensOf(r),
    cost: costs.get(String(r.id)) ?? ZERO_COST,
    outcome: r.outcome as Outcome,
    summary: (r.summary as string | null) ?? null,
    runs: num(r.runs),
  }));

  const session: SessionRow = { ...mapSessionRow(head, lk, withUsers, ctx.now.getTime()), cost: sessionCost.get(id) ?? ZERO_COST, flows: fl.flows.length };

  // Workflows: the session's runs grouped by orchestration id, each linked to the flow it forms (if any).
  const flowOfRun = new Map<string, Flow>();
  for (const x of fl.flows) for (const s of x.steps) flowOfRun.set(s.runId, x);
  const byOrch = new Map<string, FlowRunInput[]>();
  for (const r of fl.runs) {
    if (!r.orchestrationId) continue;
    const k = `${r.turnId}\u0000${r.orchestrationId}`;
    const g = byOrch.get(k);
    if (g) g.push(r);
    else byOrch.set(k, [r]);
  }
  const workflows: SessionWorkflow[] = [...byOrch.values()]
    .map((g) => {
      const flow = g.map((r) => flowOfRun.get(r.id)).find((x) => x?.kind === 'workflow') ?? null;
      return {
        orchestrationId: g[0]!.orchestrationId!,
        turnId: g[0]!.turnId,
        turnStartedMs: fl.turns.get(g[0]!.turnId)?.startedMs ?? 0,
        steps: g.length,
        startedMs: Math.min(...g.map((r) => r.startedMs)),
        endedMs: Math.max(...g.map((r) => r.endedMs)),
        flow,
      };
    })
    .sort((a, b) => a.startedMs - b.startedMs || (a.orchestrationId < b.orchestrationId ? -1 : 1));

  const uses = mergeUses([
    ...turnRows.map((r) => ({ skills: r.skills, mcp: r.mcp })),
    ...fl.runs.map((r) => ({ skills: r.skills ?? null, mcp: r.mcp ?? null })),
  ]);

  const retention = ctx.retentionDays;
  const retentionCut = retention !== undefined && session.startedMs < ctx.now.getTime() - retention * 86_400_000;

  return {
    session,
    turns,
    runs: fl.runs.map((r) => ({ ...r, agentGroup: agentGroupOf(r.agentType, r.agentGroup) })),
    flows: fl.flows.sort((a, b) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : 1)),
    workflows,
    skills: uses.skills,
    mcp: uses.mcp,
    retentionCut,
    truncated: fl.truncated,
  };
}

/** Title and id of a session for a link (turn page header, list chips); null when missing or not visible. */
export async function getSessionLink(ctx: QueryCtx, sessionId: string | null): Promise<{ id: string; title: string } | null> {
  const id = parseSessionId(sessionId);
  if (!id) return null;
  const own = ctx.agg ? sql`and s.user_id = ${ctx.viewer.id}::uuid` : sql``;
  const [r] = await rows<Record<string, unknown>>(
    ctx.tx,
    sql`select s.id, s.external_id, s.harness, s.title,
          (select t.summary from turns t where t.session_id = s.id and t.company_id = s.company_id and t.summary is not null and t.summary <> ''
            order by t.started_at, t.id limit 1) as first_summary
        from agent_sessions s where s.id = ${id}::uuid and s.company_id = ${ctx.viewer.companyId}::uuid ${own}`,
  );
  if (!r) return null;
  const hid = harnessSessionId(String(r.external_id), String(r.harness));
  return { id: String(r.id), title: sessionTitle({ title: (r.title as string | null) ?? null, firstSummary: (r.first_summary as string | null) ?? null, harnessSessionId: hid }) };
}
