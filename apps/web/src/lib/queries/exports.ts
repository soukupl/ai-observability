import type { Outcome } from '@ai-obs/db';
import type { CsvCell } from '../csv';
import type { CostValue } from '../cost';
import type { Filters } from '../filters';
import { getAgents } from './agents';
import { getBudgetProgress } from './budgets';
import { getModelsEffort } from './models';
import { getPhases, PHASES, type PhaseGroup, PHASE_GROUPS } from './phases';
import { getProjects } from './projects';
import { canSeeUsers, isLead, type QueryCtx } from './scope';
import { getSkillsMcp, type McpReliability } from './skills-mcp';
import { getWastedSpend, modelKey, wastedShare } from './wasted';
import type { TokenTotals } from './sqlutil';
import { getTokenSeries } from './timeseries';
import { exportTurns } from './turns';

/** Table views that have a CSV export (BRIEF §8: every table view). */
export const EXPORT_VIEWS = ['overview', 'projects', 'models', 'phases', 'agents', 'skills-mcp', 'turns', 'budgets'] as const;
export type ExportView = (typeof EXPORT_VIEWS)[number];

export interface CsvTable {
  headers: string[];
  rows: CsvCell[][];
  /**
   * The export hit its row cap and the oldest rows are missing. A last row says so in the file itself;
   * the route should also report it (header, audit meta).
   */
  truncated?: boolean;
}

export interface ExportOptions {
  /** phases: team | project | model */
  group?: PhaseGroup;
  /** turns: outcome filter */
  outcome?: Outcome | null;
  /** turns: row cap (default EXPORT_MAX_ROWS); newest rows are kept. */
  maxRows?: number;
}

export const isExportView = (v: string | null | undefined): v is ExportView => (EXPORT_VIEWS as readonly string[]).includes(v ?? '');
export const isPhaseGroup = (v: string | null | undefined): v is PhaseGroup => (PHASE_GROUPS as readonly string[]).includes(v ?? '');

const TOKEN_HEADERS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_tokens'];
const tokenCells = (t: TokenTotals): CsvCell[] => [t.input, t.output, t.cacheRead, t.cacheWrite, t.reasoning, t.total];
/** USD to 6 decimals; empty when no model had a price (the UI shows "n/a"). */
const usd = (c: CostValue): CsvCell => (c.usd === null ? '' : Math.round(c.usd * 1e6) / 1e6);
const ratio = (v: number | null): CsvCell => (v === null ? '' : Math.round(v * 1e4) / 1e4);
const iso = (ms: number) => new Date(ms).toISOString();

/** Re-runs a view's query and shapes it as a flat table. RLS and the visibility mode apply as on screen. */
export async function buildExportTable(ctx: QueryCtx, view: ExportView, f: Filters, opts: ExportOptions = {}): Promise<CsvTable> {
  switch (view) {
    case 'overview': {
      const s = await getTokenSeries(ctx, f);
      return {
        headers: ['day', 'model', ...TOKEN_HEADERS, 'est_cost_usd'],
        rows: s.rows.map((r) => [r.day, r.model, ...tokenCells(r.tokens), usd(r.cost)]),
      };
    }
    case 'projects': {
      const p = await getProjects(ctx, f);
      const w = (await getWastedSpend(ctx, f)).byProject;
      return {
        headers: ['project', 'team', 'turns', ...TOKEN_HEADERS, 'est_cost_usd', 'success_rate', 'unknown_share', 'wasted_est_cost_usd', 'wasted_share'],
        rows: p.rows.map((r) => {
          const part = w.get(r.projectId ?? '');
          return [r.name, r.teamName, r.turns, ...tokenCells(r.tokens), usd(r.cost), ratio(r.successRate), ratio(r.unknownShare), part ? usd(part.wasted) : '', ratio(wastedShare(part))];
        }),
      };
    }
    case 'models': {
      const m = await getModelsEffort(ctx, f);
      const w = (await getWastedSpend(ctx, f)).byModel;
      return {
        headers: ['model', 'effort', 'primary_turns', ...TOKEN_HEADERS, 'est_cost_usd', 'success_rate', 'unknown_share', 'median_duration_ms', 'avg_duration_ms', 'wasted_est_cost_usd', 'wasted_share'],
        rows: m.rows.map((r) => [
          r.model,
          r.effort,
          r.turns,
          ...tokenCells(r.tokens),
          usd(r.cost),
          ratio(r.successRate),
          ratio(r.unknownShare),
          r.medianDurationMs === null ? '' : Math.round(r.medianDurationMs),
          r.avgDurationMs === null ? '' : Math.round(r.avgDurationMs),
          w.get(modelKey(r.model, r.effort)) ? usd(w.get(modelKey(r.model, r.effort))!.wasted) : '',
          ratio(wastedShare(w.get(modelKey(r.model, r.effort)))),
        ]),
      };
    }
    case 'phases': {
      const group = opts.group ?? 'team';
      const p = await getPhases(ctx, f, group);
      return {
        headers: [group, ...PHASES.map((x) => `${x}_ms`), 'total_ms'],
        rows: p.rows.map((r) => [r.label, ...PHASES.map((x) => r.ms[x]), r.totalMs]),
      };
    }
    case 'agents': {
      const a = await getAgents(ctx, f);
      return {
        headers: ['agent_type', 'agent_group', 'spawns', ...TOKEN_HEADERS, 'token_share', 'success_rate', 'unknown_share', 'avg_depth', 'max_depth'],
        rows: a.rows.map((r) => [
          r.agentType,
          r.agentGroup,
          r.spawns,
          ...tokenCells(r.tokens),
          ratio(r.tokenShare),
          ratio(r.successRate),
          ratio(r.unknownShare),
          r.avgDepth === null ? '' : Math.round(r.avgDepth * 100) / 100,
          r.maxDepth,
        ]),
      };
    }
    case 'skills-mcp': {
      const r = await getSkillsMcp(ctx, f);
      const withUsers = ctx.viewer.companyRole === 'admin' || isLead(ctx.viewer);
      const users = (n: number): CsvCell[] => (withUsers ? [n] : []);
      const rel = (x: McpReliability): CsvCell[] => [x.errors, x.denied, x.latencyMs, ...x.buckets];
      const noRel: CsvCell[] = ['', '', '', '', '', '', '', ''];
      return {
        headers: [
          'kind', 'name', 'tool', 'calls', 'model_calls', 'user_calls', 'turns', ...(withUsers ? ['users'] : []),
          'errors', 'denied', 'latency_ms', 'lat_lt_1s', 'lat_1_5s', 'lat_5_30s', 'lat_30_120s', 'lat_gt_120s',
        ],
        rows: [
          ...r.skills.map((s) => ['skill', s.name, '', s.calls, s.modelCalls, s.userCalls, s.turns, ...users(s.users), ...noRel]),
          ...r.servers.flatMap((s) => [
            ['mcp', s.name, '', s.calls, s.calls, 0, s.turns, ...users(s.users), ...rel(s)],
            ...s.tools.map((t) => ['mcp', s.name, t.tool, t.calls, t.calls, 0, t.turns, ...users(t.users), ...rel(t)]),
          ]),
        ],
      };
    }
    case 'turns': {
      const withUsers = canSeeUsers(ctx.viewer);
      const { rows: turns, truncated } = await exportTurns(ctx, f, { outcome: opts.outcome ?? null, max: opts.maxRows });
      const headers = [
        'started_at',
        ...(withUsers ? ['user'] : []),
        'team',
        'project',
        'harness',
        'model',
        'effort',
        'outcome',
        'duration_ms',
        ...TOKEN_HEADERS,
        'est_cost_usd',
        'summary',
      ];
      const body = turns.map((t): CsvCell[] => [
        iso(t.startedMs),
        ...(withUsers ? [t.userName ?? (t.attribution === 'unverified' ? 'unverified' : '')] : []),
        t.teamName,
        t.projectName,
        t.harness,
        t.model,
        t.effort,
        t.outcome,
        t.durationMs,
        ...tokenCells(t.tokens),
        usd(t.cost),
        t.summary,
      ]);
      if (truncated) {
        // A visible last row: a cut-off export must not look complete.
        const note: CsvCell[] = headers.map(() => '');
        note[0] = `TRUNCATED: only the newest ${turns.length} turns are listed; narrow the range or filters to export the rest`;
        body.push(note);
      }
      return { headers, rows: body, truncated };
    }
    case 'budgets': {
      const b = await getBudgetProgress(ctx);
      return {
        headers: ['month', 'scope', 'team', 'user', 'kind', 'limit', 'used', 'fraction'],
        rows: b.rows.map((r) => [b.month, r.scope, r.teamName, r.userName ?? '', r.kind, r.limit, r.used === null ? '' : Math.round(r.used * 1e6) / 1e6, ratio(r.fraction)]),
      };
    }
  }
}
