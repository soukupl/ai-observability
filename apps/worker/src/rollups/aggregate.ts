/**
 * Pure folding of one (company, day) slice of raw rows into daily_rollups rows (ADR-0012).
 *
 * - turn count, duration, phase ms, outcome counts and run count are attributed to the turn's own
 *   (team, user, project, harness, model, effort);
 * - tokens and requests come from the turn's usage rows and are attributed to each usage row's
 *   (model, effort), so mixed-model turns are priced correctly. A turn's token columns equal the sum of its
 *   usage rows, so totals equal the raw sums either way;
 * - cost is never stored (computed at query time from model_prices).
 */
export type Outcome = 'success' | 'failed' | 'abandoned' | 'unknown';

export interface TurnRow {
  id: string;
  teamId: string;
  userId: string | null;
  projectId: string | null;
  harness: string;
  model: string | null;
  effort: string | null;
  durationMs: number;
  phasesMs: Record<string, number | undefined>;
  outcome: Outcome;
}

export interface UsageRow {
  turnId: string;
  model: string;
  effort: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requests: number;
}

export interface RollupRow {
  teamId: string;
  userId: string | null;
  projectId: string | null;
  harness: string;
  model: string;
  effort: string | null;
  turns: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requests: number;
  durationMs: number;
  phasesMs: Record<string, number>;
  success: number;
  failed: number;
  abandoned: number;
  unknown: number;
}

/** Model recorded for turns that have no primary model. */
export const UNKNOWN_MODEL = 'unknown';

const keyOf = (t: TurnRow, model: string, effort: string | null) =>
  JSON.stringify([t.teamId, t.userId, t.projectId, t.harness, model, effort]);

export function aggregateDay(turns: TurnRow[], usageRows: UsageRow[], runCounts: ReadonlyMap<string, number>): RollupRow[] {
  const groups = new Map<string, RollupRow>();
  const group = (t: TurnRow, model: string, effort: string | null): RollupRow => {
    const key = keyOf(t, model, effort);
    let g = groups.get(key);
    if (!g) {
      g = {
        teamId: t.teamId, userId: t.userId, projectId: t.projectId, harness: t.harness, model, effort,
        turns: 0, runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        reasoningTokens: 0, requests: 0, durationMs: 0, phasesMs: {}, success: 0, failed: 0, abandoned: 0, unknown: 0,
      };
      groups.set(key, g);
    }
    return g;
  };

  const byId = new Map<string, TurnRow>();
  for (const t of turns) {
    byId.set(t.id, t);
    const g = group(t, t.model ?? UNKNOWN_MODEL, t.effort);
    g.turns += 1;
    g.runs += runCounts.get(t.id) ?? 0;
    g.durationMs += t.durationMs;
    for (const [phase, ms] of Object.entries(t.phasesMs)) g.phasesMs[phase] = (g.phasesMs[phase] ?? 0) + (ms ?? 0);
    g[t.outcome] += 1;
  }

  for (const u of usageRows) {
    const t = byId.get(u.turnId);
    if (!t) continue;
    // An all-zero usage row (e.g. a model that was only mentioned) must not create a slice of its own: it
    // would show up as a zero-token model/effort row in every view (DP-10).
    if (!(u.inputTokens || u.outputTokens || u.cacheReadTokens || u.cacheWriteTokens || u.reasoningTokens || u.requests)) continue;
    const g = group(t, u.model, u.effort);
    g.inputTokens += u.inputTokens;
    g.outputTokens += u.outputTokens;
    g.cacheReadTokens += u.cacheReadTokens;
    g.cacheWriteTokens += u.cacheWriteTokens;
    g.reasoningTokens += u.reasoningTokens;
    g.requests += u.requests;
  }

  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g);
}

/** Which (company, day) slices to recompute. Pure so the selection rules are testable. */
export interface DayPlanInput {
  /** 'YYYY-MM-DD' (UTC) of "now". */
  today: string;
  /** Days always recomputed, ending today (self-healing window). Default 2. */
  recentDays?: number;
  companies: Array<{ id: string; /** First day still inside the retention window. */ cutoffDay: string }>;
  /** Slices whose raw rows changed since the watermark, or every slice on a cold start. */
  changed: Array<{ companyId: string; day: string }>;
}

export function planDays(input: DayPlanInput, addDays: (day: string, n: number) => string): Array<{ companyId: string; day: string }> {
  const recent = input.recentDays ?? 2;
  const cutoff = new Map(input.companies.map((c) => [c.id, c.cutoffDay]));
  const out = new Map<string, { companyId: string; day: string }>();
  const add = (companyId: string, day: string) => {
    const cut = cutoff.get(companyId);
    // Never fold a day outside the retention window: its raw rows may be partly deleted, and the slice
    // recompute would shrink the permanent rollup.
    if (cut === undefined || day < cut || day > input.today) return;
    out.set(`${companyId}|${day}`, { companyId, day });
  };
  for (const c of input.companies) for (let i = 0; i < recent; i++) add(c.id, addDays(input.today, -i));
  for (const c of input.changed) add(c.companyId, c.day);
  return [...out.values()].sort((a, b) => (a.day === b.day ? a.companyId.localeCompare(b.companyId) : a.day < b.day ? 1 : -1));
}

/** Skill / MCP counts of one turn or run (turns.skills / turns.mcp, runs.skills / runs.mcp). */
export interface SkillMcpUse {
  turnId: string;
  skills: Record<string, { model?: number; user?: number }> | null;
  mcp: Record<string, Record<string, number>> | null;
}

export interface SkillMcpRollupRow {
  teamId: string;
  userId: string | null;
  projectId: string | null;
  harness: string;
  model: string;
  kind: 'skill' | 'mcp';
  name: string;
  /** '' for a skill and for an MCP server's total row */
  tool: string;
  calls: number;
  modelCalls: number;
  userCalls: number;
  /** distinct turns of the group that used it */
  turns: number;
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Folds the skill / MCP use of the picked turns (each turn plus its runs) into daily_skill_mcp_rollups
 * rows, grouped like daily_rollups by the turn's (team, user, project, harness, primary model). Per skill:
 * one row (tool ''). Per MCP server: a total row (tool '') and one row per tool. `turns` counts each turn
 * once per row, so a server row is not the sum of its tool rows.
 */
export function aggregateSkillMcp(turns: TurnRow[], uses: SkillMcpUse[]): SkillMcpRollupRow[] {
  const perTurn = new Map<string, { skills: Map<string, { model: number; user: number }>; mcp: Map<string, Map<string, number>> }>();
  for (const u of uses) {
    let acc = perTurn.get(u.turnId);
    if (!acc) perTurn.set(u.turnId, (acc = { skills: new Map(), mcp: new Map() }));
    for (const [name, c] of Object.entries(u.skills ?? {})) {
      const cur = acc.skills.get(name) ?? { model: 0, user: 0 };
      cur.model += n(c?.model);
      cur.user += n(c?.user);
      acc.skills.set(name, cur);
    }
    for (const [server, tools] of Object.entries(u.mcp ?? {})) {
      const cur = acc.mcp.get(server) ?? new Map<string, number>();
      for (const [tool, k] of Object.entries(tools ?? {})) cur.set(tool, (cur.get(tool) ?? 0) + n(k));
      acc.mcp.set(server, cur);
    }
  }

  const groups = new Map<string, SkillMcpRollupRow>();
  const add = (t: TurnRow, kind: 'skill' | 'mcp', name: string, tool: string, model: number, user: number) => {
    if (model + user <= 0) return;
    const m = t.model ?? UNKNOWN_MODEL;
    const key = JSON.stringify([t.teamId, t.userId, t.projectId, t.harness, m, kind, name, tool]);
    let g = groups.get(key);
    if (!g) {
      g = { teamId: t.teamId, userId: t.userId, projectId: t.projectId, harness: t.harness, model: m, kind, name, tool, calls: 0, modelCalls: 0, userCalls: 0, turns: 0 };
      groups.set(key, g);
    }
    g.calls += model + user;
    g.modelCalls += model;
    g.userCalls += user;
    g.turns += 1;
  };

  for (const t of turns) {
    const acc = perTurn.get(t.id);
    if (!acc) continue;
    for (const [name, c] of acc.skills) add(t, 'skill', name, '', c.model, c.user);
    for (const [server, tools] of acc.mcp) {
      let total = 0;
      for (const [tool, k] of tools) {
        add(t, 'mcp', server, tool, k, 0);
        total += k;
      }
      add(t, 'mcp', server, '', total, 0);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, g]) => g);
}
