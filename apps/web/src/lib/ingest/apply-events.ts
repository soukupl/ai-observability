import { sql } from 'drizzle-orm';
import type { Tx } from '@ai-obs/db';
import type {
  Outcome,
  RunEvent,
  SessionEndEvent,
  SessionStartEvent,
  TurnEvent,
  TurnOutcomeEvent,
  TurnSummaryEvent,
} from '@ai-obs/protocol';
import { assertOwner, OwnerConflictError, rows, type BatchContext } from './context';
import { sessionKey, teamFor, turnKey, upsertProject } from './resolve';
import { mergeUsage, sumUsage } from './usage';
import { propagateTurnOwner, replaceUsage } from './usage-rows';

/*
 * One function per event type. Each runs inside the batch transaction (withIngestContext, so RLS
 * pins every row to the token's company) and is idempotent: replaying an event converges to the
 * same rows. app_ingest can read identity columns only, so updates set bound values and never read
 * metrics back.
 *
 * Patches before their turn (ADR-0015): a turn_outcome / turn_summary for a turn that has not arrived
 * is PARKED in pending_turn_patches; no turn row is created, so counts never include a turn without
 * its session and tokens. When the turn arrives, ingest_apply_pending_patch() (SECURITY DEFINER:
 * app_ingest cannot read patch values or delete) moves the patch onto it. Turn and patch paths take
 * a transaction-scoped advisory lock on the turn key, so a patch and its turn in concurrent batches
 * cannot both miss each other. An outcome patch also leaves a marker row in ingest_events
 * (`outcome-patch:<turn key>`), so a re-sent turn never overwrites a patched outcome with its
 * provisional one. Summaries are only ever written by patches.
 *
 * Ownership (SEC-3): an existing turn, run or session is overwritten (or patched) only by its owner or
 * while it has none (see ownerMayWrite); anything else throws OwnerConflictError and the event is
 * rejected. A non-provisional outcome patch also leaves `outcome-final:<turn key>`, after which a
 * provisional patch is ignored (DP-09). Runs take the turn lock too, so a run racing its turn is
 * always linked (DP-13). Revision ordering of re-sent turns is NOT enforced: the last arrival wins
 * (needs a revision on the wire and a column app_ingest can read; see the DP-09 note in the report).
 */

const outcomeMarker = (key: string) => `outcome-patch:${key}`;
/** Left by a non-provisional outcome patch: a provisional patch arriving later must not replace it (DP-09). */
const finalOutcomeMarker = (key: string) => `outcome-final:${key}`;

/** Serialises the turn and the patches of one turn key across concurrent batches (until commit). */
async function lockTurnKey(tx: Tx, ctx: BatchContext, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`turn:${ctx.companyId}:${key}`}, 0))`);
}

const durationMs = (startedAt: string, endedAt: string) => Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
const json = (v: unknown) => JSON.stringify(v ?? {});

export async function applySessionStart(tx: Tx, ctx: BatchContext, e: SessionStartEvent): Promise<void> {
  const project = e.project ? await upsertProject(tx, ctx, e.project) : null;
  const teamId = await teamFor(tx, ctx, project?.id ?? null);
  const [session] = await rows<{ id: string }>(
    tx,
    sql`insert into agent_sessions (company_id, team_id, user_id, machine_id, project_id, external_id, harness,
          harness_version, started_at)
        values (${ctx.companyId}::uuid, ${teamId}::uuid, ${ctx.userId}::uuid, ${ctx.machineRowId}::uuid,
          ${project?.id ?? null}::uuid, ${sessionKey(e.harness, e.session_id)}, ${e.harness},
          ${e.harness_version ?? null}, ${e.at}::timestamptz)
        on conflict (company_id, external_id) do update set
          team_id = ${teamId}::uuid, user_id = coalesce(${ctx.userId}::uuid, agent_sessions.user_id),
          machine_id = ${ctx.machineRowId}::uuid, started_at = ${e.at}::timestamptz,
          project_id = coalesce(${project?.id ?? null}::uuid, agent_sessions.project_id)
          ${e.harness_version ? sql`, harness_version = ${e.harness_version}` : sql``}
        where ${sessionOwnerGuard(ctx)}
        returning id`,
  );
  if (!session) throw new OwnerConflictError('session');
  if (!project) return;

  // Turns that arrived before their session_start had no project: give them one (and its team).
  const backfilled = await rows<{ id: string; external_id: string; team_id: string; user_id: string | null }>(
    tx,
    sql`update turns set project_id = ${project.id}::uuid ${project.teamId ? sql`, team_id = ${project.teamId}::uuid` : sql``}
        , updated_at = now()
        where session_id = ${session.id}::uuid and project_id is null
        returning id, external_id, team_id, user_id`,
  );
  if (project.teamId) {
    for (const t of backfilled) {
      await propagateTurnOwner(tx, { id: t.id, key: t.external_id, teamId: t.team_id, userId: t.user_id });
    }
  }
}

export async function applySessionEnd(tx: Tx, ctx: BatchContext, e: SessionEndEvent): Promise<void> {
  const teamId = await teamFor(tx, ctx, null);
  const done = await rows(
    tx,
    sql`insert into agent_sessions (company_id, team_id, user_id, machine_id, external_id, harness,
          started_at, ended_at, end_reason)
        values (${ctx.companyId}::uuid, ${teamId}::uuid, ${ctx.userId}::uuid, ${ctx.machineRowId}::uuid,
          ${sessionKey(e.harness, e.session_id)}, ${e.harness}, ${e.at}::timestamptz, ${e.at}::timestamptz, ${e.reason})
        on conflict (company_id, external_id) do update set ended_at = ${e.at}::timestamptz, end_reason = ${e.reason}
        where ${sessionOwnerGuard(ctx)}
        returning id`,
  );
  if (done.length === 0) throw new OwnerConflictError('session');
}

/** ON CONFLICT ... WHERE for agent_sessions: only the owner (or anyone, while unowned) may overwrite. */
const sessionOwnerGuard = (ctx: BatchContext) =>
  sql`(agent_sessions.user_id is null or agent_sessions.user_id = ${ctx.userId}::uuid)`;

/** The session a turn belongs to; created on the fly when the turn arrives before session_start. */
async function sessionForTurn(tx: Tx, ctx: BatchContext, e: TurnEvent): Promise<{ id: string; projectId: string | null }> {
  const key = sessionKey(e.harness, e.session_id);
  const teamId = await teamFor(tx, ctx, null);
  const [row] = await rows<{ id: string; project_id: string | null }>(
    tx,
    sql`insert into agent_sessions (company_id, team_id, user_id, machine_id, external_id, harness, started_at)
        values (${ctx.companyId}::uuid, ${teamId}::uuid, ${ctx.userId}::uuid, ${ctx.machineRowId}::uuid, ${key},
          ${e.harness}, ${e.started_at}::timestamptz)
        on conflict (company_id, external_id) do update set external_id = ${key}
        where ${sessionOwnerGuard(ctx)}
        returning id, project_id`,
  );
  if (!row) throw new OwnerConflictError('session');
  return { id: row.id, projectId: row.project_id };
}

async function hasMarker(tx: Tx, markerId: string): Promise<boolean> {
  const found = await rows(tx, sql`select 1 from ingest_events where event_id = ${markerId}`);
  return found.length > 0;
}

function outcomeSet(o: Outcome) {
  return sql`outcome = ${o.status}::outcome, outcome_signals = ${json(o.signals)}::jsonb,
    outcome_provisional = ${o.provisional}`;
}

export async function applyTurn(tx: Tx, ctx: BatchContext, e: TurnEvent, eventId: string): Promise<void> {
  const key = turnKey(e.harness, e.turn_id);
  await lockTurnKey(tx, ctx, key);
  const session = await sessionForTurn(tx, ctx, e);
  const teamId = await teamFor(tx, ctx, session.projectId);
  const usage = mergeUsage(e.usage);
  const t = sumUsage(usage);
  const keepOutcome = await hasMarker(tx, outcomeMarker(key));
  // The turn must not take over runs another user already filed under this key (propagateTurnOwner re-owns them).
  const foreignRun = await rows(
    tx,
    sql`select 1 from runs where turn_external_id = ${key} and user_id is not null
        and user_id is distinct from ${ctx.userId}::uuid limit 1`,
  );
  if (foreignRun.length > 0) throw new OwnerConflictError('turn');

  const cols = sql`team_id = ${teamId}::uuid, user_id = ${ctx.userId}::uuid, attribution = ${ctx.attribution}::attribution,
    session_id = ${session.id}::uuid, project_id = ${session.projectId}::uuid, harness = ${e.harness},
    model = ${e.model}, effort = ${e.effort}, started_at = ${e.started_at}::timestamptz,
    ended_at = ${e.ended_at}::timestamptz, duration_ms = ${durationMs(e.started_at, e.ended_at)},
    input_tokens = ${t.input}, output_tokens = ${t.output}, cache_read_tokens = ${t.cacheRead},
    cache_write_tokens = ${t.cacheWrite}, reasoning_tokens = ${t.reasoning}, requests = ${t.requests},
    phases_ms = ${json(e.phases_ms)}::jsonb, tools = ${json(e.tools)}::jsonb, skills = ${json(e.skills)}::jsonb,
    mcp = ${json(e.mcp)}::jsonb, mcp_stats = ${json(e.mcp_stats)}::jsonb, source_event_id = ${eventId},
    files_touched = ${e.files_touched}, lines_added = ${e.lines_added}, lines_removed = ${e.lines_removed},
    phase_rules_version = ${e.phase_rules_version}, updated_at = now()`;

  const [turn] = await rows<{ id: string }>(
    tx,
    sql`insert into turns (company_id, team_id, user_id, attribution, session_id, project_id, external_id, harness,
          model, effort, started_at, ended_at, duration_ms, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, reasoning_tokens, requests, phases_ms, tools, skills, mcp, mcp_stats, outcome, outcome_signals,
          outcome_provisional, source_event_id, files_touched, lines_added, lines_removed, phase_rules_version)
        values (${ctx.companyId}::uuid, ${teamId}::uuid, ${ctx.userId}::uuid, ${ctx.attribution}::attribution,
          ${session.id}::uuid, ${session.projectId}::uuid, ${key}, ${e.harness}, ${e.model}, ${e.effort},
          ${e.started_at}::timestamptz, ${e.ended_at}::timestamptz, ${durationMs(e.started_at, e.ended_at)},
          ${t.input}, ${t.output}, ${t.cacheRead}, ${t.cacheWrite}, ${t.reasoning}, ${t.requests},
          ${json(e.phases_ms)}::jsonb, ${json(e.tools)}::jsonb, ${json(e.skills)}::jsonb, ${json(e.mcp)}::jsonb, ${json(e.mcp_stats)}::jsonb,
          ${e.outcome.status}::outcome,
          ${json(e.outcome.signals)}::jsonb, ${e.outcome.provisional}, ${eventId}, ${e.files_touched},
          ${e.lines_added}, ${e.lines_removed}, ${e.phase_rules_version})
        on conflict (company_id, external_id) do update set ${cols}
          ${keepOutcome ? sql`` : sql`, ${outcomeSet(e.outcome)}`}
        where (turns.user_id is null or turns.user_id = ${ctx.userId}::uuid)
        returning id`,
  );
  if (!turn) throw new OwnerConflictError('turn');

  const owner = { id: turn.id, key, teamId, userId: ctx.userId };
  await replaceUsage(
    tx,
    { companyId: ctx.companyId, turnId: owner.id, runId: null, teamId, userId: ctx.userId, startedAt: e.started_at },
    usage,
  );
  await propagateTurnOwner(tx, owner);
  await tx.execute(sql`select ingest_apply_pending_patch(${owner.id}::uuid)`);
}

export async function applyRun(tx: Tx, ctx: BatchContext, e: RunEvent, eventId: string): Promise<void> {
  const key = turnKey(e.harness, e.turn_id);
  // Same lock as the turn: otherwise a turn batch committing between our read of the turn and our insert
  // would not see this run (propagateTurnOwner) and the run would stay unlinked (DP-13).
  await lockTurnKey(tx, ctx, key);
  const [turn] = await rows<{ id: string; team_id: string; user_id: string | null }>(
    tx,
    sql`select id, team_id, user_id from turns where external_id = ${key}`,
  );
  if (turn) assertOwner('turn', turn.user_id, ctx.userId);
  const [parent] = e.parent_run_id
    ? await rows<{ id: string }>(
        tx,
        sql`select id from runs where turn_external_id = ${key} and external_id = ${e.parent_run_id}`,
      )
    : [];
  // A run before its turn takes the batch's owner; linking the turn re-points it (propagateTurnOwner).
  const teamId = turn?.team_id ?? (await teamFor(tx, ctx, null));
  const userId = turn ? turn.user_id : ctx.userId;
  const usage = mergeUsage(e.usage);
  const t = sumUsage(usage);
  const model = e.model ?? usage[0]?.model ?? null;
  const effort = e.effort !== undefined ? e.effort : (usage[0]?.effort ?? null);
  const turnId = turn?.id ?? null;
  const parentId = parent?.id ?? null;
  const signals = json(e.outcome.signals);
  const phases = json(e.phases_ms);
  const tools = json(e.tools);
  const skills = json(e.skills);
  const mcp = json(e.mcp);
  const mcpStats = json(e.mcp_stats);
  const dur = durationMs(e.started_at, e.ended_at);
  // Already sanitised / clipped by enforceLimits (normalizeAgentGroup / normalizeOrchestrationId); NULL when absent.
  const agentGroup = e.agent_group ?? null;
  const orchestrationId = e.orchestration_id ?? null;

  const [run] = await rows<{ id: string }>(
    tx,
    sql`insert into runs (company_id, team_id, user_id, turn_id, turn_external_id, parent_run_id, parent_external_id,
          external_id, agent_type, agent_group, orchestration_id, depth, model, effort, started_at, ended_at, duration_ms, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, requests, phases_ms, tools, skills, mcp, mcp_stats, outcome,
          outcome_signals, outcome_provisional, source_event_id)
        values (${ctx.companyId}::uuid, ${teamId}::uuid, ${userId}::uuid, ${turnId}::uuid, ${key}, ${parentId}::uuid,
          ${e.parent_run_id}, ${e.run_id}, ${e.agent_type}, ${agentGroup}, ${orchestrationId}, ${e.depth}, ${model}, ${effort},
          ${e.started_at}::timestamptz, ${e.ended_at}::timestamptz, ${dur}, ${t.input}, ${t.output}, ${t.cacheRead},
          ${t.cacheWrite}, ${t.reasoning}, ${t.requests}, ${phases}::jsonb, ${tools}::jsonb, ${skills}::jsonb,
          ${mcp}::jsonb, ${mcpStats}::jsonb, ${e.outcome.status}::outcome, ${signals}::jsonb, ${e.outcome.provisional}, ${eventId})
        on conflict on constraint runs_company_turn_external_uq do update set
          team_id = ${teamId}::uuid, user_id = ${userId}::uuid, turn_id = coalesce(${turnId}::uuid, runs.turn_id),
          parent_run_id = coalesce(${parentId}::uuid, runs.parent_run_id), parent_external_id = ${e.parent_run_id},
          agent_type = ${e.agent_type}, agent_group = ${agentGroup}, orchestration_id = ${orchestrationId}, depth = ${e.depth}, model = ${model}, effort = ${effort},
          started_at = ${e.started_at}::timestamptz, ended_at = ${e.ended_at}::timestamptz, duration_ms = ${dur},
          input_tokens = ${t.input}, output_tokens = ${t.output}, cache_read_tokens = ${t.cacheRead},
          cache_write_tokens = ${t.cacheWrite}, reasoning_tokens = ${t.reasoning}, requests = ${t.requests},
          phases_ms = ${phases}::jsonb, tools = ${tools}::jsonb, skills = ${skills}::jsonb, mcp = ${mcp}::jsonb, mcp_stats = ${mcpStats}::jsonb,
          outcome = ${e.outcome.status}::outcome,
          outcome_signals = ${signals}::jsonb, outcome_provisional = ${e.outcome.provisional},
          source_event_id = ${eventId}
        where (runs.user_id is null or runs.user_id = ${ctx.userId}::uuid)
        returning id`,
  );
  if (!run) throw new OwnerConflictError('run');

  // Children that arrived before this run.
  await tx.execute(sql`update runs set parent_run_id = ${run.id}::uuid
    where turn_external_id = ${key} and parent_external_id = ${e.run_id} and parent_run_id is null`);
  await replaceUsage(
    tx,
    { companyId: ctx.companyId, turnId: null, runId: run.id, teamId, userId, startedAt: e.started_at },
    usage,
  );
}

/**
 * Applies a patch to its turn, or parks it in pending_turn_patches while the turn has not arrived.
 * `set` is the column assignment list, valid for both tables (bound values only).
 */
async function patchTurn(
  tx: Tx,
  ctx: BatchContext,
  e: TurnOutcomeEvent | TurnSummaryEvent,
  cols: ReturnType<typeof sql>,
  vals: ReturnType<typeof sql>,
  set: ReturnType<typeof sql>,
): Promise<string> {
  const key = turnKey(e.harness, e.turn_id);
  await lockTurnKey(tx, ctx, key);
  const [turn] = await rows<{ user_id: string | null }>(tx, sql`select user_id from turns where external_id = ${key}`);
  if (turn) {
    assertOwner('turn', turn.user_id, ctx.userId);
    await tx.execute(sql`update turns set ${set}, updated_at = now() where external_id = ${key}`);
  } else {
    // The parked patch remembers its sender (SEC-3): ingest_apply_pending_patch applies it only to an
    // ownerless turn or one of the same owner, and another user cannot overwrite a parked patch.
    const parked = await rows<{ id: string }>(
      tx,
      sql`insert into pending_turn_patches (company_id, turn_external_id, user_id, ${cols})
        values (${ctx.companyId}::uuid, ${key}, ${ctx.userId}::uuid, ${vals})
        on conflict (company_id, turn_external_id) do update set ${set}, user_id = ${ctx.userId}::uuid, received_at = now()
        where pending_turn_patches.user_id is null or pending_turn_patches.user_id = ${ctx.userId}::uuid
        returning id`,
    );
    if (!parked.length) throw new OwnerConflictError('turn patch');
  }
  return key;
}

export async function applyTurnOutcome(tx: Tx, ctx: BatchContext, e: TurnOutcomeEvent): Promise<void> {
  const o = e.outcome;
  // A provisional outcome never replaces a final one, whatever order the patches arrive in (DP-09). The
  // check needs the turn lock: a final patch in a concurrent batch must be visible to it.
  await lockTurnKey(tx, ctx, turnKey(e.harness, e.turn_id));
  if (o.provisional && (await hasMarker(tx, finalOutcomeMarker(turnKey(e.harness, e.turn_id))))) return;
  const key = await patchTurn(
    tx,
    ctx,
    e,
    sql`outcome, outcome_signals, outcome_provisional`,
    sql`${o.status}::outcome, ${json(o.signals)}::jsonb, ${o.provisional}`,
    outcomeSet(o),
  );
  await tx.execute(sql`insert into ingest_events (company_id, event_id, type)
    values (${ctx.companyId}::uuid, ${outcomeMarker(key)}, 'marker') on conflict (company_id, event_id) do nothing`);
  if (!o.provisional) {
    await tx.execute(sql`insert into ingest_events (company_id, event_id, type)
      values (${ctx.companyId}::uuid, ${finalOutcomeMarker(key)}, 'marker') on conflict (company_id, event_id) do nothing`);
  }
}

export async function applyTurnSummary(tx: Tx, ctx: BatchContext, e: TurnSummaryEvent): Promise<void> {
  await patchTurn(tx, ctx, e, sql`summary`, sql`${e.summary}`, sql`summary = ${e.summary}`);
}
