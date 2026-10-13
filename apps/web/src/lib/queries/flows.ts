import { sql, type SQL } from 'drizzle-orm';
import type { Outcome } from '@ai-obs/db';
import type { CostValue, PriceBook } from '../cost';
import { CostSum, ZERO_COST } from '../cost';
import type { Filters } from '../filters';
import { agentGroupOf, agentRunLabel } from './agent-groups';
import { orchestrationStages } from './flow-stages';
import { listProjects } from './lookups';
import { aggArgs, dims, turnConds } from './providers';
import { dayString, rawRange, rangeFor, type ResolvedRange } from './range';
import { deriveSequenceLinks, flowOrchestrationId, isWorkflowRun, mapRunLink, type LinkKind, type RunLink } from './run-links';
import type { QueryCtx } from './scope';
import { addTokens, costTokens, emptyTokens, num, numOrNull, rows, tokensOf, where, type TokenTotals } from './sqlutil';
import { getTurnDetail, mergeUses, type TurnDetail } from './turns';

/**
 * Agent flows (ADR-0020 amendment, docs/briefs/agent-flows-view.md): sets of ≥ 2 sub-agent runs of one turn that belong
 * together, computed here from runs + links (never stored).
 *  - `workflow`: the runs of one Workflow-tool run (same `orchestration_id`); key = the orchestration id (or
 *    `orch-<smallest run id>` when that id is not URL-safe, see orchestrationKey);
 *  - `legacy-workflow`: all `workflow:*` runs of a turn without an orchestration (pre-ADR-0019 rows); key `workflow`;
 *  - `sequence`: the other runs, one flow per connected component over `sequence` / `item` links (stored + derived);
 *    key `seq-<smallest run id of the component>`.
 */

export type FlowKind = 'workflow' | 'legacy-workflow' | 'sequence';

type Skills = Record<string, { model: number; user: number }>;
type Mcp = Record<string, Record<string, number>>;

export interface FlowStep {
  runId: string;
  parentRunId: string | null;
  agentType: string;
  /** agentRunLabel(agentType): the label part of a `workflow:<label>` type, else the type. */
  label: string;
  /** agentGroupOf(agent_type, agent_group). */
  group: string;
  /**
   * Row of the step in `Flow.stages` (dense, 0-based): `stages[stageIndex] === stageName`. Null for a step outside any
   * stage (an unstaged workflow agent, every sequence step).
   */
  stageIndex: number | null;
  stageName: string | null;
  model: string | null;
  effort: string | null;
  depth: number;
  startedMs: number;
  endedMs: number;
  durationMs: number;
  /** Start relative to the flow's start (ms). */
  offsetMs: number;
  tokens: TokenTotals;
  /** ≈ cost of the step's tokens at its model's price on its UTC start day; $0 for a step without tokens. */
  cost: CostValue;
  outcome: Outcome;
  /** null when the run has no phase split (or the source does not carry it, e.g. the aggregate list path). */
  phasesMs: Record<string, number> | null;
  /** null when the run used none (or the source does not carry them). */
  skills: Skills | null;
  mcp: Mcp | null;
  /** Links into this step from other steps of the same flow. */
  inLinks: { fromRunId: string; kind: LinkKind }[];
}

export interface FlowTurn {
  id: string;
  startedMs: number;
  projectId: string | null;
  projectName: string | null;
  harness: string;
  summary: string | null;
  isMine: boolean;
  /**
   * Skill uses / MCP calls of the turn's MAIN agent alone (the turn row, not its runs), for the detail page's
   * "Turn" line. Only the detail path fills them (null when the viewer sees the turn in limited form); undefined on
   * the list path, which never reads the turn's own uses.
   */
  skills?: Skills | null;
  mcp?: Mcp | null;
}

export interface Flow {
  /** `${turnId}~${key}` */
  id: string;
  turnId: string;
  key: string;
  kind: FlowKind;
  name: string;
  turn: FlowTurn;
  steps: FlowStep[];
  /** Stage names in order (workflow kinds); [] for sequences and stage-less workflows. */
  stages: string[];
  startedMs: number;
  endedMs: number;
  /** First step start -> last step end. */
  durationMs: number;
  tokens: TokenTotals;
  cost: CostValue;
  models: string[];
  efforts: string[];
  outcome: Outcome;
  /** Links between steps of this flow (deduplicated). */
  links: RunLink[];
  /** The steps' skill uses / MCP calls summed; null when no step carries any. */
  skills: FlowStep['skills'];
  mcp: FlowStep['mcp'];
}

/** One run as buildFlows reads it (from the raw tables, agg_flow_runs or a turn detail's RunRow). */
export interface FlowRunInput {
  id: string;
  turnId: string;
  parentRunId: string | null;
  agentType: string;
  /** Already grouped (agentGroupOf). */
  agentGroup: string;
  orchestrationId: string | null;
  stageIndex: number | null;
  depth: number;
  model: string | null;
  effort: string | null;
  startedMs: number;
  endedMs: number;
  durationMs: number;
  tokens: TokenTotals;
  outcome: Outcome;
  phasesMs?: Record<string, number> | null;
  skills?: Skills | null;
  mcp?: Mcp | null;
}

/** Steps of a flow; fewer are not a flow (brief: "more than one step"). */
export const FLOW_MIN_STEPS = 2;
export const FLOW_PAGE_SIZE = 50;
const FLOW_MAX_PAGE_SIZE = 500;
/** Most runs (and stored links) one list query reads; agg_flow_runs / agg_flow_links cap at this + 1. */
export const FLOW_MAX_RUNS = 20_000;
/** Labels a sequence flow's name lists before "…". */
const SEQUENCE_NAME_STEPS = 4;
/** URL key of a flow: an orchestration id, `workflow` or `seq-<run id>`. */
export const FLOW_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const LEGACY_KEY = 'workflow';
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const nonEmpty = <T extends object>(v: T | null | undefined): T | null => (v && Object.keys(v).length > 0 ? v : null);

/** failed if any step failed, else abandoned if any was, else success if every step succeeded, else unknown. */
export function flowOutcome(outcomes: Outcome[]): Outcome {
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('abandoned')) return 'abandoned';
  if (outcomes.length > 0 && outcomes.every((o) => o === 'success')) return 'success';
  return 'unknown';
}

/** Connected components (undirected) of `ids` over `links`; each sorted by id, components in id order of their first. */
function components(ids: string[], links: RunLink[]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const l of links) {
    if (!parent.has(l.fromRunId) || !parent.has(l.toRunId)) continue;
    const a = find(l.fromRunId);
    const b = find(l.toRunId);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const r = find(id);
    const g = groups.get(r);
    if (g) g.push(id);
    else groups.set(r, [id]);
  }
  return [...groups.values()].map((g) => g.sort(cmp)).sort((a, b) => cmp(a[0]!, b[0]!));
}

/**
 * URL key of an orchestrated flow: the orchestration id itself when it is URL-safe (FLOW_KEY_RE) and cannot be taken
 * for the legacy / sequence keys; else `orch-<smallest run id>`. The protocol accepts any 1–128 character id (e.g.
 * `build 1/2`), and such a flow must still open on its detail page, which only accepts FLOW_KEY_RE keys. Deterministic
 * for a given set of runs, so getFlowDetail finds the same key again.
 */
export function orchestrationKey(orchestrationId: string, runs: Pick<FlowRunInput, 'id'>[]): string {
  if (FLOW_KEY_RE.test(orchestrationId) && orchestrationId !== LEGACY_KEY && !orchestrationId.startsWith('seq-')) return orchestrationId;
  return `orch-${runs.map((r) => r.id).sort(cmp)[0]}`;
}

function makeFlow(turn: FlowTurn, key: string, kind: FlowKind, runs: FlowRunInput[], links: RunLink[], prices: PriceBook): Flow {
  let stages: string[] = [];
  let indexOf = new Map<string, number | null>();
  if (kind !== 'sequence') ({ stages, indexOf } = orchestrationStages(runs));

  const ids = new Set(runs.map((r) => r.id));
  const seen = new Set<string>();
  const flowLinks: RunLink[] = [];
  for (const l of links) {
    if (l.fromRunId === l.toRunId || !ids.has(l.fromRunId) || !ids.has(l.toRunId)) continue;
    const k = `${l.fromRunId}\u0000${l.toRunId}\u0000${l.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    flowLinks.push(l);
  }

  const startedMs = Math.min(...runs.map((r) => r.startedMs));
  const endedMs = Math.max(...runs.map((r) => r.endedMs));
  const total = new CostSum(prices);
  const tokens = emptyTokens();
  const steps: FlowStep[] = runs.map((r) => {
    const stageIndex = indexOf.get(r.id) ?? null;
    let cost = ZERO_COST;
    if (r.tokens.total > 0) {
      const cs = new CostSum(prices);
      const day = dayString(r.startedMs);
      cs.add(r.model, day, costTokens(r.tokens));
      total.add(r.model, day, costTokens(r.tokens));
      cost = cs.value();
    }
    addTokens(tokens, r.tokens);
    return {
      runId: r.id,
      parentRunId: r.parentRunId,
      agentType: r.agentType,
      label: agentRunLabel(r.agentType),
      group: r.agentGroup,
      stageIndex,
      stageName: stageIndex === null ? null : (stages[stageIndex] ?? null),
      model: r.model,
      effort: r.effort,
      depth: r.depth,
      startedMs: r.startedMs,
      endedMs: r.endedMs,
      durationMs: r.durationMs,
      offsetMs: r.startedMs - startedMs,
      tokens: { ...r.tokens },
      cost,
      outcome: r.outcome,
      phasesMs: nonEmpty(r.phasesMs),
      skills: nonEmpty(r.skills),
      mcp: nonEmpty(r.mcp),
      inLinks: flowLinks.filter((l) => l.toRunId === r.id).map((l) => ({ fromRunId: l.fromRunId, kind: l.kind })),
    };
  });
  steps.sort(
    (a, b) =>
      (a.stageIndex ?? Number.POSITIVE_INFINITY) - (b.stageIndex ?? Number.POSITIVE_INFINITY) ||
      a.startedMs - b.startedMs ||
      cmp(a.runId, b.runId),
  );

  let name: string;
  if (kind === 'sequence') {
    const labels = steps.map((s) => s.label);
    name = labels.slice(0, SEQUENCE_NAME_STEPS).join(' → ') + (labels.length > SEQUENCE_NAME_STEPS ? ' → …' : '');
  } else name = stages.length > 0 ? stages.join(' → ') : 'workflow';

  const anySkills = steps.some((s) => s.skills !== null);
  const anyMcp = steps.some((s) => s.mcp !== null);
  const merged = anySkills || anyMcp ? mergeUses(steps.map((s) => ({ skills: s.skills, mcp: s.mcp }))) : null;
  const distinct = (vs: (string | null)[]) => [...new Set(vs.filter((v): v is string => v !== null && v !== ''))].sort(cmp);

  return {
    id: `${turn.id}~${key}`,
    turnId: turn.id,
    key,
    kind,
    name,
    turn,
    steps,
    stages,
    startedMs,
    endedMs,
    durationMs: Math.max(0, endedMs - startedMs),
    tokens,
    cost: total.value(),
    models: distinct(steps.map((s) => s.model)),
    efforts: distinct(steps.map((s) => s.effort)),
    outcome: flowOutcome(steps.map((s) => s.outcome)),
    links: flowLinks,
    skills: anySkills ? merged!.skills : null,
    mcp: anyMcp ? merged!.mcp : null,
  };
}

/**
 * Flows of the given runs (any number of turns). `links` are the stored links (derived `sequence` links may be included
 * already; the rule is applied again for runs without an incoming one). Runs whose turn is not in `turns` are skipped.
 * Only flows with ≥ FLOW_MIN_STEPS steps are returned, newest first (start desc, then id).
 */
export function buildFlows(input: { runs: FlowRunInput[]; turns: Map<string, FlowTurn>; links: RunLink[]; prices: PriceBook }): Flow[] {
  const byTurn = new Map<string, FlowRunInput[]>();
  for (const r of input.runs) {
    if (!input.turns.has(r.turnId)) continue;
    const list = byTurn.get(r.turnId);
    if (list) list.push(r);
    else byTurn.set(r.turnId, [r]);
  }
  const runIds = new Set([...byTurn.values()].flatMap((rs) => rs.map((r) => r.id)));
  const stored = input.links.filter((l) => runIds.has(l.fromRunId) && runIds.has(l.toRunId));
  const links = deriveSequenceLinks(
    [...byTurn.values()].flat().map((r) => ({
      id: r.id,
      turnId: r.turnId,
      parentRunId: r.parentRunId,
      orchestrationId: flowOrchestrationId(r),
      startedMs: r.startedMs,
      endedMs: r.endedMs,
    })),
    stored,
  );

  const flows: Flow[] = [];
  for (const [turnId, runs] of byTurn) {
    const turn = input.turns.get(turnId)!;
    const orchestrated = new Map<string, FlowRunInput[]>();
    const legacy: FlowRunInput[] = [];
    const rest: FlowRunInput[] = [];
    for (const r of runs) {
      if (r.orchestrationId) {
        const g = orchestrated.get(r.orchestrationId);
        if (g) g.push(r);
        else orchestrated.set(r.orchestrationId, [r]);
      } else if (isWorkflowRun(r)) legacy.push(r);
      else rest.push(r);
    }
    const add = (key: string, kind: FlowKind, group: FlowRunInput[]) => {
      if (group.length >= FLOW_MIN_STEPS) flows.push(makeFlow(turn, key, kind, group, links, input.prices));
    };
    for (const [orch, group] of orchestrated) add(orchestrationKey(orch, group), 'workflow', group);
    add(LEGACY_KEY, 'legacy-workflow', legacy);
    const restById = new Map(rest.map((r) => [r.id, r]));
    for (const comp of components([...restById.keys()], links)) add(`seq-${comp[0]}`, 'sequence', comp.map((id) => restById.get(id)!));
  }
  return flows.sort((a, b) => b.startedMs - a.startedMs || cmp(a.id, b.id));
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export interface FlowTotals {
  flows: number;
  steps: number;
  tokens: TokenTotals;
  cost: CostValue;
}

export interface FlowListResult {
  range: ResolvedRange;
  /** This page. */
  flows: Flow[];
  /** Flows matching the filters (outcome included). */
  total: number;
  page: number;
  pageSize: number;
  /** Totals over every matching flow (not only this page). */
  totals: FlowTotals;
  /** The run (or link) cap was hit: the newest runs of the range are missing, some flows may be incomplete. */
  truncated: boolean;
  ignoredFilters: string[];
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const MS = (col: string) => sql.raw(`(extract(epoch from ${col}) * 1000)::bigint`);
const TOKEN_COLS = (alias: string) =>
  sql.raw(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'].map((c) => `${alias}${c}`).join(', '));

function mapFlowRun(r: Record<string, unknown>): FlowRunInput {
  const agentType = String(r.agent_type);
  return {
    id: String(r.id),
    turnId: String(r.turn_id),
    parentRunId: str(r.parent_run_id),
    agentType,
    agentGroup: agentGroupOf(agentType, str(r.agent_group)),
    orchestrationId: str(r.orchestration_id),
    stageIndex: numOrNull(r.stage_index),
    depth: num(r.depth),
    model: str(r.model),
    effort: str(r.effort),
    startedMs: num(r.started_ms),
    endedMs: num(r.ended_ms),
    durationMs: num(r.duration_ms),
    tokens: tokensOf(r),
    outcome: r.outcome as Outcome,
    phasesMs: (r.phases_ms as Record<string, number> | null | undefined) ?? null,
    skills: (r.skills as Skills | null | undefined) ?? null,
    mcp: (r.mcp as Mcp | null | undefined) ?? null,
  };
}

/** The flow totals of a set of flows: steps, tokens and ≈ cost (re-priced per step, as each flow is). */
export function flowTotals(flows: Flow[], prices: PriceBook): FlowTotals {
  const tokens = emptyTokens();
  const cs = new CostSum(prices);
  let steps = 0;
  for (const f of flows) {
    addTokens(tokens, f.tokens);
    for (const s of f.steps) {
      steps += 1;
      if (s.tokens.total > 0) cs.add(s.model, dayString(s.startedMs), costTokens(s.tokens));
    }
  }
  return { flows: flows.length, steps, tokens, cost: steps > 0 ? cs.value() : ZERO_COST };
}

/** true when at least one step of the flow belongs to the agent group (the `group` list filter). */
export const flowHasGroup = (f: Pick<Flow, 'steps'>, group: string): boolean => f.steps.some((s) => s.group === group);

/**
 * Every flow of the turns that started in the filter range (raw rows, any range length), newest first, paged in TS.
 * Direct path: runs and run_links under RLS (effort = the turn's primary effort, as on the turns list); aggregate path:
 * agg_flow_runs / agg_flow_links (no user ids; effort cannot be applied and is reported in ignoredFilters).
 * `group` keeps only flows with a step of that agent group (the Agents page's "flows →" links).
 */
export async function getFlows(
  ctx: QueryCtx,
  f: Filters,
  opts: { page: number; outcome: Outcome | null; group?: string | null; pageSize?: number; sessionId?: string | null },
): Promise<FlowListResult> {
  const pageSize = Math.min(Math.max(1, Math.floor(opts.pageSize ?? FLOW_PAGE_SIZE)), FLOW_MAX_PAGE_SIZE);
  const page = Math.max(1, Math.floor(Number.isFinite(opts.page) ? opts.page : 1));
  const { range, flows: matching, truncated, ignoredFilters } = await listFlows(ctx, f, opts.outcome, opts.group ?? null, opts.sessionId ?? null);
  const offset = (page - 1) * pageSize;
  return {
    range,
    flows: matching.slice(offset, offset + pageSize),
    total: matching.length,
    page,
    pageSize,
    totals: flowTotals(matching, ctx.prices),
    truncated,
    ignoredFilters,
  };
}

/** Every flow matching the filters, the outcome and the agent group, newest first (the list unpaged; CSV export). */
export async function listFlows(
  ctx: QueryCtx,
  f: Filters,
  outcome: Outcome | null = null,
  group: string | null = null,
  sessionId: string | null = null,
): Promise<{ range: ResolvedRange; flows: Flow[]; truncated: boolean; ignoredFilters: string[] }> {
  const range = rawRange(rangeFor(ctx, f));
  const d = dims(ctx, f, range);

  let input: FlowInputs;
  if (sessionId) {
    // One session (ADR-0026): every flow of its turns, whatever the date range; raw rows under RLS (in aggregates-only
    // mode a lead / admin reads only their own session this way).
    input = await readFlowInputs(ctx, [sql`t.company_id = ${ctx.viewer.companyId}::uuid`, sql`t.session_id = ${sessionId}::uuid`]);
  } else if (ctx.agg) {
    const args = aggArgs(d, 'ts');
    const projectsP = listProjects(ctx);
    const [runRows, linkRows] = await Promise.all([
      rows<Record<string, unknown>>(
        ctx.tx,
        sql`select id, turn_id, parent_run_id, agent_type, agent_group, orchestration_id, stage_index, depth, model, effort,
              ${MS('started_at')} as started_ms, ${MS('ended_at')} as ended_ms, duration_ms, ${TOKEN_COLS('')}, outcome,
              ${MS('turn_started_at')} as turn_started_ms, turn_project_id, turn_harness, turn_summary, turn_is_mine
            from agg_flow_runs(${args}, ${FLOW_MAX_RUNS + 1}::integer)`,
      ),
      rows<Record<string, unknown>>(ctx.tx, sql`select from_run_id, to_run_id, kind from agg_flow_links(${args}, ${FLOW_MAX_RUNS + 1}::integer)`),
    ]);
    input = toFlowInputs(runRows, linkRows, await projectsP);
  } else {
    input = await readFlowInputs(ctx, turnConds(ctx, d));
  }

  const all = buildFlows({ runs: input.runs, turns: input.turns, links: input.links, prices: ctx.prices });
  return {
    range,
    flows: all.filter((x) => (!outcome || x.outcome === outcome) && (!group || flowHasGroup(x, group))),
    truncated: input.truncated,
    ignoredFilters: ctx.agg && d.effort && !sessionId ? ['effort'] : [],
  };
}

/** What buildFlows reads, as one read returned it; `truncated` = the run or link cap was hit. */
export interface FlowInputs {
  runs: FlowRunInput[];
  turns: Map<string, FlowTurn>;
  links: RunLink[];
  truncated: boolean;
}

/**
 * Runs and stored links of the turns matching `conds` (conditions on `turns` aliased `t`), read from the tables under
 * RLS, at most FLOW_MAX_RUNS of each (oldest runs first). Used by the flows list and the sessions view.
 */
export async function readFlowInputs(ctx: QueryCtx, conds: SQL[]): Promise<FlowInputs> {
  const projectsP = listProjects(ctx);
  const [runRows, linkRows] = await Promise.all([
    rows<Record<string, unknown>>(
      ctx.tx,
      sql`select r.id, r.turn_id, r.parent_run_id, r.agent_type, r.agent_group, r.orchestration_id, r.stage_index, r.depth, r.model, r.effort,
            ${MS('r.started_at')} as started_ms, ${MS('r.ended_at')} as ended_ms, r.duration_ms, ${TOKEN_COLS('r.')}, r.outcome,
            r.phases_ms, r.skills, r.mcp,
            ${MS('t.started_at')} as turn_started_ms, t.project_id as turn_project_id, t.harness as turn_harness, t.summary as turn_summary,
            (t.user_id is not distinct from ${ctx.viewer.id}::uuid) as turn_is_mine
          from turns t join runs r on r.turn_id = t.id and r.company_id = t.company_id
          ${where(conds)}
          order by r.started_at, r.id limit ${FLOW_MAX_RUNS + 1}`,
    ),
    // Visibility follows the target run, as the run_links policy does.
    rows<Record<string, unknown>>(
      ctx.tx,
      sql`select l.from_run_id, l.to_run_id, l.kind
          from turns t join runs r on r.turn_id = t.id and r.company_id = t.company_id
            join run_links l on l.to_run_id = r.id and l.company_id = r.company_id
          ${where([...conds, sql`l.from_run_id is not null`])}
          order by r.started_at, r.id, l.from_run_id, l.kind limit ${FLOW_MAX_RUNS + 1}`,
    ),
  ]);
  return toFlowInputs(runRows, linkRows, await projectsP);
}

function toFlowInputs(runRows: Record<string, unknown>[], linkRows: Record<string, unknown>[], projectList: { id: string; name: string }[]): FlowInputs {
  const projects = new Map(projectList.map((p) => [p.id, p.name]));
  const turns = new Map<string, FlowTurn>();
  const runs: FlowRunInput[] = [];
  for (const r of runRows.slice(0, FLOW_MAX_RUNS)) {
    const run = mapFlowRun(r);
    runs.push(run);
    if (!turns.has(run.turnId)) {
      const projectId = str(r.turn_project_id);
      turns.set(run.turnId, {
        id: run.turnId,
        startedMs: num(r.turn_started_ms),
        projectId,
        projectName: projectId ? (projects.get(projectId) ?? null) : null,
        harness: String(r.turn_harness),
        summary: str(r.turn_summary),
        isMine: Boolean(r.turn_is_mine),
      });
    }
  }
  const links = linkRows
    .slice(0, FLOW_MAX_RUNS)
    .map(mapRunLink)
    .filter((l): l is RunLink => l !== null);
  return { runs, turns, links, truncated: runRows.length > FLOW_MAX_RUNS || linkRows.length > FLOW_MAX_RUNS };
}

/**
 * One flow of one turn, or null when the turn is not visible, the key is malformed or the turn has no such flow.
 * Built from getTurnDetail (runs, stored + derived links; through agg_turn_runs / agg_turn_links for someone else's
 * turn in aggregates-only mode, where `atMs` = the turn's start helps find it).
 */
export async function getFlowDetail(ctx: QueryCtx, turnId: string, key: string, atMs?: number): Promise<Flow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turnId) || !FLOW_KEY_RE.test(key)) return null;
  const d = await getTurnDetail(ctx, turnId, atMs);
  return d ? (turnFlows(d, ctx.prices).find((x) => x.key === key) ?? null) : null;
}

/**
 * Every flow of one turn detail, in buildFlows order (workflows by start, then sequences), for the turn page's flow
 * sections (ADR-0025) and getFlowDetail. [] for a turn whose runs form no flow.
 */
export function turnFlows(d: TurnDetail, prices: PriceBook): Flow[] {
  const turn: FlowTurn = {
    id: d.turn.id,
    startedMs: d.turn.startedMs,
    projectId: d.turn.projectId,
    projectName: d.turn.projectName,
    harness: d.turn.harness,
    summary: d.turn.summary,
    isMine: d.turn.isMine,
    skills: d.turn.ownSkills,
    mcp: d.turn.ownMcp,
  };
  const runs: FlowRunInput[] = d.runs.map((r) => ({ ...r, turnId: turn.id }));
  return buildFlows({ runs, turns: new Map([[turn.id, turn]]), links: d.links, prices });
}
