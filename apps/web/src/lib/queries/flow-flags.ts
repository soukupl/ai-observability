import { sql } from 'drizzle-orm';
import { listProjects } from './lookups';
import type { QueryCtx } from './scope';
import { rows } from './sqlutil';

/**
 * Flow flags (ADR-0024, docs/briefs/dashboard-followups-2026-10-10.md): a user's private "for later" bookmarks of agent
 * flows. RLS limits every read and write to the viewer's own rows in the active company (`web_own` policy, migration
 * 0015), so nothing here filters by user explicitly. Flows are computed on read, so a flag stores the turn id, the
 * flow key and a snapshot of the flow's name.
 */

export interface FlowFlag {
  id: string;
  note: string | null;
  createdAtMs: number;
}

export interface FlaggedFlowRow {
  id: string;
  turnId: string;
  key: string;
  flowName: string;
  note: string | null;
  flaggedAtMs: number;
  /**
   * The flow's turn as the viewer may see it now; null when it is no longer visible (another member's turn after a
   * visibility change, or deleted by retention — then the flag is gone too). The flag can still be removed.
   */
  turn: { startedMs: number; projectName: string | null; summary: string | null } | null;
}

/** Most flags the list shows (newest first). */
export const FLAGGED_FLOWS_LIMIT = 100;

const ms = (v: unknown): number => new Date(v as string).getTime();

/** The viewer's flag of one flow, or null. */
export async function getFlowFlag(ctx: QueryCtx, turnId: string, key: string): Promise<FlowFlag | null> {
  const r = await rows<{ id: string; note: string | null; created_at: string }>(
    ctx.tx,
    sql`select id, note, created_at from flow_flags
        where company_id = ${ctx.viewer.companyId}::uuid and turn_id = ${turnId}::uuid and flow_key = ${key} limit 1`,
  );
  const f = r[0];
  return f ? { id: f.id, note: f.note, createdAtMs: ms(f.created_at) } : null;
}

/** Every flag of the viewer in the active company, newest flag first, with the turn's start / project / summary when visible. */
export async function listFlaggedFlows(ctx: QueryCtx): Promise<FlaggedFlowRow[]> {
  const [out, projects] = await Promise.all([
    rows<Record<string, unknown>>(
      ctx.tx,
      sql`select f.id, f.turn_id, f.flow_key, f.flow_name, f.note, f.created_at,
            t.id as t_id, t.started_at as t_started_at, t.project_id as t_project_id, t.summary as t_summary
          from flow_flags f
          left join turns t on t.id = f.turn_id and t.company_id = f.company_id
          where f.company_id = ${ctx.viewer.companyId}::uuid
          order by f.created_at desc, f.id limit ${FLAGGED_FLOWS_LIMIT}`,
    ),
    listProjects(ctx),
  ]);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  return out.map((r) => ({
    id: String(r.id),
    turnId: String(r.turn_id),
    key: String(r.flow_key),
    flowName: String(r.flow_name),
    note: (r.note as string | null) ?? null,
    flaggedAtMs: ms(r.created_at),
    turn: r.t_id
      ? {
          startedMs: ms(r.t_started_at),
          projectName: r.t_project_id ? (projectName.get(String(r.t_project_id)) ?? null) : null,
          summary: (r.t_summary as string | null) ?? null,
        }
      : null,
  }));
}
