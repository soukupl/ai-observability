import { sql } from 'drizzle-orm';
import type { Outcome } from '@ai-obs/db';
import { aggArgs, turnConds, type Dims } from './providers';
import type { QueryCtx } from './scope';
import { AGG_PAGE, num, rows, where } from './sqlutil';

/**
 * Lightweight turn rows for stats the agg_* functions cannot give directly (an overall median, or
 * stats under the effort filter). Direct path: SELECT; agg path: agg_turn_list pages (no user_id).
 * Capped so a huge company never loads everything; `truncated` says the cap was hit.
 */
export interface TurnRow {
  id: string;
  startedMs: number;
  durationMs: number;
  teamId: string | null;
  projectId: string | null;
  harness: string;
  model: string | null;
  effort: string | null;
  outcome: Outcome;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export const TURN_ROWS_CAP = 5000;

export async function loadTurnRows(ctx: QueryCtx, d: Dims, cap = TURN_ROWS_CAP): Promise<{ rows: TurnRow[]; truncated: boolean }> {
  const out: TurnRow[] = [];
  if (ctx.agg) {
    // agg_turn_list has no effort argument: effort is filtered here, so keep paging until the cap.
    for (let offset = 0; out.length <= cap; offset += AGG_PAGE) {
      const page = await rows<Record<string, unknown>>(
        ctx.tx,
        sql`select id, (extract(epoch from started_at) * 1000)::bigint as started_ms, duration_ms, team_id, project_id, harness,
              model, effort, outcome, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
            from agg_turn_list(${aggArgs(d, 'ts')}, null::outcome, ${AGG_PAGE}, ${offset})`,
      );
      for (const r of page) if (!d.effort || r.effort === d.effort) out.push(toRow(r));
      if (page.length < AGG_PAGE) break;
    }
  } else {
    const page = await rows<Record<string, unknown>>(
      ctx.tx,
      sql`select t.id, (extract(epoch from t.started_at) * 1000)::bigint as started_ms, t.duration_ms, t.team_id, t.project_id,
            t.harness, t.model, t.effort, t.outcome, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_write_tokens,
            t.reasoning_tokens
          from turns t ${where(turnConds(ctx, d))} order by t.started_at desc limit ${cap + 1}`,
    );
    for (const r of page) out.push(toRow(r));
  }
  const truncated = out.length > cap;
  return { rows: truncated ? out.slice(0, cap) : out, truncated };
}

function toRow(r: Record<string, unknown>): TurnRow {
  return {
    id: String(r.id),
    startedMs: num(r.started_ms),
    durationMs: num(r.duration_ms),
    teamId: r.team_id ? String(r.team_id) : null,
    projectId: (r.project_id as string | null) ?? null,
    harness: String(r.harness),
    model: (r.model as string | null) ?? null,
    effort: (r.effort as string | null) ?? null,
    outcome: r.outcome as Outcome,
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheWriteTokens: num(r.cache_write_tokens),
    reasoningTokens: num(r.reasoning_tokens),
  };
}
