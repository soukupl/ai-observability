import { sql } from 'drizzle-orm';
import type { Filters } from '../filters';
import { agentGroupOf } from './agent-groups';
import { listProjects } from './lookups';
import { aggArgs, dims, turnConds, type Dims } from './providers';
import { addDays, rawRange, rangeFor, type ResolvedRange } from './range';
import { deriveSequenceLinks, flowOrchestrationId, mapRunLink, type RunLink } from './run-links';
import type { QueryCtx } from './scope';
import { num, numOrNull, rows, tokensOf, where } from './sqlutil';

/**
 * Agent timeline (ADR-0019): the turns and sub-agent runs that overlap one UTC day window (optionally
 * narrowed to a minute range), for the git-graph view. Lanes (sessions), colours (projects) and the
 * branch layout are the graph component's job; this module only reads and shapes rows.
 *
 * Overlap: a turn or run is in the window when started < to AND ended > from. Turns are selected by
 * start (agg_scope_turns / the started_at index), so the read looks back one day before the window
 * for turns that started earlier and are still running. The parent turn of every run in the window is
 * returned too, even when the turn itself ended before the window: background workflow agents outlive
 * the turn that launched them, and a run is drawn on (and bound to the project of) its turn's lane.
 */

type TimelineOutcome = 'success' | 'failed' | 'abandoned' | 'unknown';

export interface TimelineWindow {
  /** YYYY-MM-DD (UTC). */
  day: string;
  /** 0..1439 */
  fromMin: number;
  /** 1..1440, exclusive. */
  toMin: number;
  fromMs: number;
  toMs: number;
}

export interface TimelineTurn {
  id: string;
  /**
   * Groups a session's turns into one lane. In aggregates-only mode this is a per-window pseudonym from
   * agg_timeline_turns (not the stored session id), so lanes cannot be correlated across windows or days.
   */
  sessionId: string | null;
  projectId: string | null;
  projectName: string | null;
  harness: string;
  model: string | null;
  startedMs: number;
  endedMs: number;
  durationMs: number;
  outcome: TimelineOutcome;
  summary: string | null;
  tokens: number;
  isMine: boolean;
}

export interface TimelineRun {
  id: string;
  turnId: string;
  parentRunId: string | null;
  agentType: string;
  agentGroup: string;
  orchestrationId: string | null;
  /** 0-based ordinal of the agent's phase inside its orchestration (ADR-0020); null when unknown. */
  stageIndex: number | null;
  /** The `<item>` of a `<stage>:<item>` label, slugged (ADR-0020); null when the label does not follow it. */
  flowKey: string | null;
  depth: number;
  model: string | null;
  startedMs: number;
  endedMs: number;
  durationMs: number;
  tokens: number;
  outcome: TimelineOutcome;
}

export interface AgentTimelineResult {
  window: TimelineWindow;
  turns: TimelineTurn[];
  runs: TimelineRun[];
  /**
   * Links between the window's runs (ADR-0020), both ends in `runs`: the stored ones plus `sequence` links derived for
   * Agent-tool runs without a stored incoming link.
   */
  links: RunLink[];
  truncated: { turns: boolean; runs: boolean; links: boolean };
  /** UTC days inside the filter range that have turns, ascending; drives prev / next */
  days: string[];
  ignoredFilters: string[];
}

/** Most turns / runs one window returns; more are cut (oldest kept) and flagged as truncated. */
export const TIMELINE_MAX_TURNS = 1000;
export const TIMELINE_MAX_RUNS = 5000;
/** Most stored links one window reads (agg_timeline_links caps p_limit at 10 000 + 1). */
export const TIMELINE_MAX_LINKS = 10_000;
/** How far before the window a turn may have started and still overlap it. */
export const TIMELINE_LOOKBACK_MS = 86_400_000;

/**
 * URL params of the window. `from` / `to` belong to the global filter bar (custom date range), so the minutes of the
 * day use their own names; TimelineWindowControls' TIMELINE_WINDOW_PARAMS must match (asserted in a test).
 */
export const TIMELINE_PARAMS = { day: 'day', from: 'fromH', to: 'toH' } as const;

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** A real calendar day in YYYY-MM-DD form (rejects 2026-02-30). */
function validDay(v: string | undefined): v is string {
  if (!v || !DAY_RE.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
}

/** "HH:MM" -> minutes of the day (0..1440; "24:00" = 1440). null when malformed or out of range. */
export function parseHhMm(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** Minutes of the day -> "HH:MM" (1440 -> "24:00"); for building prev / next / zoom links. */
export function formatHhMm(minutes: number): string {
  const m = Math.max(0, Math.min(DAY_MINUTES, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * The window of the request. `day` must lie inside the filter range (any day of it, with or without
 * turns); otherwise the last day that has turns, else the range's last day. `fromH` / `toH` are HH:MM
 * ("24:00" allowed); both missing = the whole day, a missing one = that end of the day, anything
 * malformed or from >= to = the whole day.
 */
export function parseTimelineWindow(
  sp: Record<string, string | string[] | undefined>,
  days: string[],
  range: Pick<ResolvedRange, 'fromDay' | 'toDay'>,
): TimelineWindow {
  const wanted = first(sp[TIMELINE_PARAMS.day]);
  const inRange = (d: string) => d >= range.fromDay && d < range.toDay;
  const fallback = days.length > 0 ? days[days.length - 1]! : addDays(range.toDay, -1);
  const day = validDay(wanted) && inRange(wanted) ? wanted : fallback;

  const rawFrom = first(sp[TIMELINE_PARAMS.from]);
  const rawTo = first(sp[TIMELINE_PARAMS.to]);
  let fromMin = rawFrom === undefined || rawFrom === '' ? 0 : parseHhMm(rawFrom);
  let toMin = rawTo === undefined || rawTo === '' ? DAY_MINUTES : parseHhMm(rawTo);
  if (fromMin === null || toMin === null || fromMin >= DAY_MINUTES || toMin < 1 || fromMin >= toMin) {
    fromMin = 0;
    toMin = DAY_MINUTES;
  }
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  return { day, fromMin, toMin, fromMs: dayMs + fromMin * MINUTE_MS, toMs: dayMs + toMin * MINUTE_MS };
}

/** Rows were read with limit + 1: keep `limit`, and say whether there were more. */
export function capRows<T>(list: T[], limit: number): { rows: T[]; truncated: boolean } {
  return list.length > limit ? { rows: list.slice(0, limit), truncated: true } : { rows: list, truncated: false };
}

/** Half-open overlap of [startMs, endMs] with the window (start < to AND end > from), as the SQL does. */
export function overlapsWindow(startMs: number, endMs: number, w: Pick<TimelineWindow, 'fromMs' | 'toMs'>): boolean {
  return startMs < w.toMs && endMs > w.fromMs;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function mapTimelineTurn(r: Record<string, unknown>, projects: Map<string, string>): TimelineTurn {
  const projectId = str(r.project_id);
  return {
    id: String(r.id),
    sessionId: str(r.session_id),
    projectId,
    projectName: projectId ? (projects.get(projectId) ?? null) : null,
    harness: String(r.harness),
    model: str(r.model),
    startedMs: num(r.started_ms),
    endedMs: num(r.ended_ms),
    durationMs: num(r.duration_ms),
    outcome: r.outcome as TimelineOutcome,
    summary: str(r.summary),
    tokens: tokensOf(r).total,
    isMine: Boolean(r.is_mine),
  };
}

export function mapTimelineRun(r: Record<string, unknown>): TimelineRun {
  const agentType = String(r.agent_type);
  return {
    id: String(r.id),
    turnId: String(r.turn_id),
    parentRunId: str(r.parent_run_id),
    agentType,
    agentGroup: agentGroupOf(agentType, str(r.agent_group)),
    orchestrationId: str(r.orchestration_id),
    stageIndex: numOrNull(r.stage_index),
    flowKey: str(r.flow_key),
    depth: num(r.depth),
    model: str(r.model),
    startedMs: num(r.started_ms),
    endedMs: num(r.ended_ms),
    durationMs: num(r.duration_ms),
    tokens: tokensOf(r).total,
    outcome: r.outcome as TimelineOutcome,
  };
}

const MS = (col: string) => sql.raw(`(extract(epoch from ${col}) * 1000)::bigint`);
const TOKEN_COLS = (alias: string) =>
  sql.raw(
    ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'].map((c) => `${alias}${c}`).join(', '),
  );

/** UTC days of the filter range that have turns (same filters as the window). */
async function timelineDays(ctx: QueryCtx, d: Dims): Promise<string[]> {
  if (ctx.agg) {
    const out = await rows<{ day: string; turns: unknown }>(ctx.tx, sql`select day::text as day, turns from agg_turns_daily(${aggArgs(d, 'ts')}) order by day`);
    return out.filter((r) => num(r.turns) > 0).map((r) => String(r.day));
  }
  const out = await rows<{ day: string }>(
    ctx.tx,
    sql`select distinct (t.started_at at time zone 'UTC')::date::text as day from turns t ${where(turnConds(ctx, d))} order by 1`,
  );
  return out.map((r) => String(r.day));
}

/**
 * The timeline of one window. Leads / admins in aggregates-only mode read through agg_timeline_turns /
 * agg_timeline_runs (no user_id, no names); everyone else reads the tables under RLS. Filters are the
 * global ones (team, project, harness, model; effort on the direct path only), window from the URL.
 */
export async function getAgentTimeline(ctx: QueryCtx, f: Filters, sp: Record<string, string | string[] | undefined>): Promise<AgentTimelineResult> {
  const range = rawRange(rangeFor(ctx, f));
  const d = dims(ctx, f, range);
  const [days, projectList] = await Promise.all([timelineDays(ctx, d), listProjects(ctx)]);
  const projects = new Map(projectList.map((p) => [p.id, p.name]));
  const window = parseTimelineWindow(sp, days, range);
  const fromIso = new Date(window.fromMs).toISOString();
  const toIso = new Date(window.toMs).toISOString();
  // Turns are selected by start: look back a day for turns still running when the window opens.
  const w: Dims = { ...d, fromIso: new Date(window.fromMs - TIMELINE_LOOKBACK_MS).toISOString(), toIso };

  let turnRows: Record<string, unknown>[];
  let runRows: Record<string, unknown>[];
  let linkRows: Record<string, unknown>[];
  if (ctx.agg) {
    // The functions apply the look-back themselves: they take the window itself.
    const args = aggArgs({ ...d, fromIso, toIso }, 'ts');
    [turnRows, runRows, linkRows] = await Promise.all([
      rows<Record<string, unknown>>(
        ctx.tx,
        sql`select id, session_id, project_id, harness, model, ${MS('started_at')} as started_ms, ${MS('ended_at')} as ended_ms,
              duration_ms, ${TOKEN_COLS('')}, outcome, summary, is_mine
            from agg_timeline_turns(${args}, ${TIMELINE_MAX_TURNS + 1}::integer)`,
      ),
      rows<Record<string, unknown>>(
        ctx.tx,
        sql`select id, turn_id, parent_run_id, agent_type, agent_group, orchestration_id, stage_index, flow_key, depth, model,
              ${MS('started_at')} as started_ms, ${MS('ended_at')} as ended_ms, duration_ms, ${TOKEN_COLS('')}, outcome
            from agg_timeline_runs(${args}, ${TIMELINE_MAX_RUNS + 1}::integer)`,
      ),
      rows<Record<string, unknown>>(
        ctx.tx,
        sql`select from_run_id, to_run_id, kind from agg_timeline_links(${args}, ${TIMELINE_MAX_LINKS + 1}::integer)`,
      ),
    ]);
  } else {
    const conds = turnConds(ctx, w);
    [turnRows, runRows, linkRows] = await Promise.all([
      rows<Record<string, unknown>>(
        ctx.tx,
        sql`select t.id, t.session_id, t.project_id, t.harness, t.model, ${MS('t.started_at')} as started_ms, ${MS('t.ended_at')} as ended_ms,
              t.duration_ms, ${TOKEN_COLS('t.')}, t.outcome, t.summary, (t.user_id is not distinct from ${ctx.viewer.id}::uuid) as is_mine
            from turns t ${where([
              ...conds,
              sql`(t.ended_at > ${fromIso}::timestamptz or exists (select 1 from runs r where r.turn_id = t.id and r.company_id = t.company_id
                and r.started_at < ${toIso}::timestamptz and r.ended_at > ${fromIso}::timestamptz))`,
            ])}
            order by t.started_at, t.id limit ${TIMELINE_MAX_TURNS + 1}`,
      ),
      rows<Record<string, unknown>>(
        ctx.tx,
        sql`select r.id, r.turn_id, r.parent_run_id, r.agent_type, r.agent_group, r.orchestration_id, r.stage_index, r.flow_key, r.depth, r.model,
              ${MS('r.started_at')} as started_ms, ${MS('r.ended_at')} as ended_ms, r.duration_ms, ${TOKEN_COLS('r.')}, r.outcome
            from turns t join runs r on r.turn_id = t.id and r.company_id = t.company_id
            ${where([...conds, sql`r.started_at < ${toIso}::timestamptz`, sql`r.ended_at > ${fromIso}::timestamptz`])}
            order by r.started_at, r.id limit ${TIMELINE_MAX_RUNS + 1}`,
      ),
      // Links whose target run is in the window (visibility follows the target run, as the run_links policy does).
      rows<Record<string, unknown>>(
        ctx.tx,
        sql`select l.from_run_id, l.to_run_id, l.kind
            from turns t join runs r on r.turn_id = t.id and r.company_id = t.company_id
              join run_links l on l.to_run_id = r.id and l.company_id = r.company_id
            ${where([...conds, sql`r.started_at < ${toIso}::timestamptz`, sql`r.ended_at > ${fromIso}::timestamptz`, sql`l.from_run_id is not null`])}
            order by r.started_at, r.id, l.from_run_id, l.kind limit ${TIMELINE_MAX_LINKS + 1}`,
      ),
    ]);
  }

  const t = capRows(turnRows, TIMELINE_MAX_TURNS);
  const r = capRows(runRows, TIMELINE_MAX_RUNS);
  const windowRuns = r.rows.map(mapTimelineRun).filter((x) => overlapsWindow(x.startedMs, x.endedMs, window));
  const parentIds = new Set(windowRuns.map((x) => x.turnId));
  // A turn is in the window when it overlaps it or is the parent of a run that does (see the module comment).
  const turns = t.rows
    .map((x) => mapTimelineTurn(x, projects))
    .filter((x) => overlapsWindow(x.startedMs, x.endedMs, window) || parentIds.has(x.id));
  // A run is drawn on its turn's lane: drop runs whose turn was cut off by the row cap.
  const turnIds = new Set(turns.map((x) => x.id));
  const runs = windowRuns.filter((x) => turnIds.has(x.turnId));
  // Links: both ends must be runs of the result (a source that ended before the window is not drawn).
  const l = capRows(linkRows, TIMELINE_MAX_LINKS);
  const runIds = new Set(runs.map((x) => x.id));
  const stored = l.rows.map(mapRunLink).filter((x): x is RunLink => x !== null && runIds.has(x.fromRunId) && runIds.has(x.toRunId));
  const links = deriveSequenceLinks(
    runs.map((x) => ({
      id: x.id,
      turnId: x.turnId,
      parentRunId: x.parentRunId,
      orchestrationId: flowOrchestrationId(x),
      startedMs: x.startedMs,
      endedMs: x.endedMs,
    })),
    stored,
  );
  return {
    window,
    turns,
    runs,
    links,
    truncated: { turns: t.truncated, runs: r.truncated, links: l.truncated },
    days,
    ignoredFilters: ctx.agg && d.effort ? ['effort'] : [],
  };
}
