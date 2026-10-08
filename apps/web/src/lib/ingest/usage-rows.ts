import { sql } from 'drizzle-orm';
import type { Tx } from '@ai-obs/db';
import type { UsageRow } from './usage';

/**
 * Writes the usage rows of one owner, replacing what an earlier event for the same owner wrote.
 * app_ingest has no DELETE, so rows of a model × effort pair that is no longer reported are zeroed.
 *
 * Owners (see README "Ingest API"): a turn's rows (`turn_id` set, `run_id` null) hold the WHOLE
 * turn's usage as reported by the turn event, sub-agents included; a run's rows (`run_id` set,
 * `turn_id` null) hold that sub-agent's usage. So `sum(usage where turn_id = X)` is the turn total
 * and sub-agent tokens are never counted twice, in whichever order turn and runs arrive.
 */
export async function replaceUsage(
  tx: Tx,
  owner: { companyId: string; turnId: string | null; runId: string | null; teamId: string | null; userId: string | null; startedAt: string },
  entries: readonly UsageRow[],
): Promise<void> {
  const ownerFilter = owner.runId ? sql`run_id = ${owner.runId}::uuid` : sql`turn_id = ${owner.turnId}::uuid and run_id is null`;
  await tx.execute(sql`update usage set input_tokens = 0, output_tokens = 0, cache_read_tokens = 0,
      cache_write_tokens = 0, reasoning_tokens = 0, requests = 0 where ${ownerFilter}`);
  for (const u of entries) {
    await tx.execute(sql`insert into usage (company_id, team_id, user_id, turn_id, run_id, started_at, model, effort,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, requests)
      values (${owner.companyId}::uuid, ${owner.teamId}::uuid, ${owner.userId}::uuid, ${owner.turnId}::uuid,
        ${owner.runId}::uuid, ${owner.startedAt}::timestamptz, ${u.model}, ${u.effort},
        ${u.input}, ${u.output}, ${u.cacheRead}, ${u.cacheWrite}, ${u.reasoning}, ${u.requests})
      on conflict on constraint usage_owner_model_uq do update set
        team_id = ${owner.teamId}::uuid, user_id = ${owner.userId}::uuid, started_at = ${owner.startedAt}::timestamptz,
        input_tokens = ${u.input}, output_tokens = ${u.output}, cache_read_tokens = ${u.cacheRead},
        cache_write_tokens = ${u.cacheWrite}, reasoning_tokens = ${u.reasoning}, requests = ${u.requests}`);
  }
}

/**
 * Re-points everything hanging off a turn at the turn's current owner: its usage rows, its runs
 * (also linking runs that arrived before the turn) and their usage rows. Run links (ADR-0020) carry no owner,
 * only the turn id, which is linked here like runs.turn_id.
 */
export async function propagateTurnOwner(
  tx: Tx,
  turn: { id: string; key: string; teamId: string | null; userId: string | null },
): Promise<void> {
  await tx.execute(sql`update usage set team_id = ${turn.teamId}::uuid, user_id = ${turn.userId}::uuid
    where turn_id = ${turn.id}::uuid and run_id is null`);
  await tx.execute(sql`update runs set turn_id = ${turn.id}::uuid, team_id = ${turn.teamId}::uuid, user_id = ${turn.userId}::uuid
    where turn_external_id = ${turn.key}`);
  await tx.execute(sql`update usage set team_id = ${turn.teamId}::uuid, user_id = ${turn.userId}::uuid
    where run_id in (select id from runs where turn_external_id = ${turn.key})`);
  await tx.execute(sql`update run_links set turn_id = ${turn.id}::uuid
    where turn_external_id = ${turn.key} and turn_id is distinct from ${turn.id}::uuid`);
}
