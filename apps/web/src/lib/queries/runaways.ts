import { sql, type SQL } from 'drizzle-orm';
import type { Filters } from '../filters';
import { listProjects, listTeams } from './lookups';
import { aggArgs, dims } from './providers';
import { rangeFor, type ResolvedRange } from './range';
import type { QueryCtx } from './scope';
import { num, rows, where } from './sqlutil';

/** A turn the worker flagged as a runaway (docs/briefs/runaway-alerts.md, ADR-0018). */
export interface RunawayRow {
  turnId: string;
  startedMs: number;
  teamName: string | null;
  projectName: string | null;
  harness: string;
  model: string | null;
  reasons: string[];
  tokens: number;
  costUsd: number | null;
  durationMs: number;
  isMine: boolean;
}

export interface RunawaysResult {
  range: ResolvedRange;
  rows: RunawayRow[];
}

/**
 * Runaway turns in range, newest first (at most `limit`). Members see their own; leads / admins their teams /
 * the deployment in full mode (RLS), or through agg_runaways in aggregates-only mode (never who).
 */
export async function getRunaways(ctx: QueryCtx, f: Filters, limit = 10): Promise<RunawaysResult> {
  const range = rangeFor(ctx, f);
  const d = dims(ctx, f, range);
  const cols = sql.raw('turn_id, started_at, team_id, project_id, harness, model, reasons, tokens, cost_usd, duration_ms');
  let q: SQL;
  if (ctx.agg) {
    q = sql`select ${cols}, is_mine from agg_runaways(${aggArgs(d, 'ts')}) limit ${limit}`;
  } else {
    const c: SQL[] = [
            sql`a.started_at >= ${d.fromIso}::timestamptz`,
      sql`a.started_at < ${d.toIso}::timestamptz`,
    ];
    if (d.teamId) c.push(sql`a.team_id = ${d.teamId}::uuid`);
    if (d.projectId) c.push(sql`a.project_id = ${d.projectId}::uuid`);
    if (d.userId) c.push(sql`a.user_id = ${d.userId}::uuid`);
    if (d.harness) c.push(sql`a.harness = ${d.harness}`);
    if (d.model) c.push(sql`a.model = ${d.model}`);
    q = sql`select ${cols}, (a.user_id = ${ctx.viewer.id}::uuid) as is_mine from runaway_alerts a ${where(c)}
          order by a.started_at desc limit ${limit}`;
  }
  const out = await rows<Record<string, unknown>>(ctx.tx, q);
  const [teams, projects] = await Promise.all([listTeams(ctx), listProjects(ctx)]);
  const team = new Map(teams.map((t) => [t.id, t.name]));
  const project = new Map(projects.map((p) => [p.id, p.name]));
  return {
    range,
    rows: out.map((r) => ({
      turnId: String(r.turn_id),
      startedMs: new Date(r.started_at as string).getTime(),
      teamName: team.get(String(r.team_id)) ?? null,
      projectName: r.project_id ? (project.get(String(r.project_id)) ?? null) : null,
      harness: String(r.harness),
      model: (r.model as string | null) ?? null,
      reasons: (r.reasons as string[]) ?? [],
      tokens: num(r.tokens),
      costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
      durationMs: num(r.duration_ms),
      isMine: r.is_mine === true,
    })),
  };
}
