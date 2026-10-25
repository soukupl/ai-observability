import { sql } from 'drizzle-orm';
import type { Tx } from '@ai-obs/db';
import type {
  IngestEvent,
  Outcome,
  RunEvent,
  RunLink,
  SessionEndEvent,
  SessionStartEvent,
  SessionTitleEvent,
  TurnEvent,
  TurnOutcomeEvent,
  TurnStartedEvent,
  TurnSummaryEvent,
} from '@ai-obs/protocol';
import { assertOwner, OwnerConflictError, rows, type BatchContext } from './context';
import { resolveTeam, sessionKey, turnKey, upsertProject } from './resolve';
import { mergeUsage, sumUsage } from './usage';
import { propagateTurnOwner, replaceUsage } from './usage-rows';

/*
 * One function per event type. Each runs inside the batch transaction (withIngestContext, so RLS
 * lets it write only rows of the token's user) and is idempotent: replaying an event converges to the
 * same rows. app_ingest can read identity columns only, so updates set bound values and never read
 * metrics back.
 *
 * Patches before their turn (ADR-0015): a turn_outcome / turn_summary for a turn that has not arrived
 * is PARKED in pending_turn_patches; no turn row is created, so counts never include a turn without
 * its session and tokens. When the turn arrives, ingest_apply_pending_patch() (SECURITY DEFINER:
 * app_ingest cannot read patch values or delete) moves the patch onto it. Turn and patch paths take
 * a transaction-scoped advisory lock on the turn key, so a patch and its turn in concurrent batches
 * cannot both miss each other. An outcome patch also leaves a marker row in ingest_events
 * (`outcome-patch:<sender user id>:<turn key>`), so a re-sent turn never overwrites a patched outcome with its
 * provisional one. Summaries are only ever written by patches.
 *
 * Session titles (ADR-0026) follow the same design: a session_title for a session that has not arrived is parked in
 * pending_session_patches and ingest_apply_pending_session_patch() moves it onto the session when any event creates
 * the session row it creates. Every session write and the title patch take an advisory lock on the session key, so a
 * title and its session in concurrent batches cannot miss each other. processBatch takes every session lock of the
 * batch first, in sorted order (lockBatchSessions), so session locks always come before turn locks and concurrent
 * batches cannot deadlock; the lock calls inside the apply functions then re-take a held lock, which is free.
 *
 * Ownership (SEC-3): an existing turn, run or session is overwritten (or patched) only by its owner or
 * while it has none (see ownerMayWrite); anything else throws OwnerConflictError and the event is
 * rejected. Since 0018 the ingest role cannot even see another user's rows (RLS USING user_id = app_user() OR user_id
 * IS NULL): an upsert that collides with one updates nothing and is rejected, while a patch, title or run aimed at
 * another user's turn or session finds nothing and is parked (or stored unlinked) under its sender, where it is never
 * applied to the other user's row (propagateTurnOwner and the pending-patch functions only touch own or ownerless
 * rows). A non-provisional outcome patch also leaves `outcome-final:<sender user id>:<turn key>`, after
 * which a provisional patch of the same user is ignored (DP-09). Markers carry the sender, so a stray patch parked under
 * another user never freezes the owner's outcome. Runs take the turn lock too, so a run racing its turn is
 * always linked (DP-13). Revision ordering of re-sent turns is NOT enforced: the last arrival wins
 * (needs a revision on the wire and a column app_ingest can read; see the DP-09 note in the report).
 *
 * Live status (ADR-0027): agent_sessions.current_turn_started_at (C) is non-null while the main agent works on a turn,
 * and last_seen_at is the newest event time of the session. turn_started sets C = greatest(stored, started_at) and
 * creates the session on the fly like a turn does (owner guard, parked title); when the session had ended before
 * started_at (a resume), it re-opens it (ended_at and end_reason := null). A turn clears C when C <= its ended_at,
 * otherwise C stays (a newer prompt is already running); session_end clears C only when C <= its time and then also
 * sets ended_at/end_reason (an older end delivered after a newer prompt's turn_started, e.g. in one backlog batch, is ignored). last_seen_at is bumped by session_start
 * (at), turn_started (started_at), turn (ended_at) and session_end (at) to greatest(stored, least(time, now())), so a
 * collector clock running ahead cannot keep a session fresh; run and the patches carry no session time and leave both
 * alone. app_ingest may read and write these liveness columns (and read ended_at) only (0017).
 */

/*
 * Outcome markers are namespaced by the patch's sender (`outcome-patch:<user id>:<turn key>`). A stray patch from another
 * user (whose turn the sender cannot see, so the patch is parked under the sender and never applied) must not leave a
 * marker that freezes the owner's outcome. Every reader asks for the markers of the user writing the turn, which is the
 * turn's owner (an upsert or patch only lands on an own or ownerless row). Markers written before 0018 have no user part
 * (`outcome-patch:<turn key>`); they came from the single company of the old deployment and are still honoured.
 */
const outcomeMarker = (userId: string, key: string) => `outcome-patch:${userId}:${key}`;
/** Left by a non-provisional outcome patch: a provisional patch arriving later must not replace it (DP-09). */
const finalOutcomeMarker = (userId: string, key: string) => `outcome-final:${userId}:${key}`;
const legacyOutcomeMarker = (key: string) => `outcome-patch:${key}`;
const legacyFinalOutcomeMarker = (key: string) => `outcome-final:${key}`;

/** Serialises the turn and the patches of one turn key across concurrent batches (until commit). */
async function lockTurnKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`turn:${key}`}, 0))`);
}

/** Serialises the session upserts and the title patches of one session key across concurrent batches (until commit). */
async function lockSessionKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`session:${key}`}, 0))`);
}

/** The session keys an event writes (session_start, turn_started, turn, session_title, session_end); pure. */
export function batchSessionKeys(events: readonly IngestEvent[]): string[] {
  const keys = new Set<string>();
  for (const e of events) {
    if (
      e.type === 'session_start' ||
      e.type === 'turn_started' ||
      e.type === 'turn' ||
      e.type === 'session_title' ||
      e.type === 'session_end'
    ) {
      keys.add(sessionKey(e.harness, e.session_id));
    }
  }
  return [...keys].sort();
}

/** Takes the session locks of a batch up front, in sorted order (see the header comment). */
export async function lockBatchSessions(tx: Tx, events: readonly IngestEvent[]): Promise<void> {
  for (const key of batchSessionKeys(events)) await lockSessionKey(tx, key);
}

/**
 * Moves a title parked for this session (if any) onto it; see ingest_apply_pending_session_patch() (one indexed
 * delete; the 30-day prune of orphaned titles is the worker's).
 */
async function applyPendingSessionPatch(tx: Tx, sessionId: string): Promise<void> {
  await tx.execute(sql`select ingest_apply_pending_session_patch(${sessionId}::uuid)`);
}

const durationMs = (startedAt: string, endedAt: string) => Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
const json = (v: unknown) => JSON.stringify(v ?? {});
/** Event time for last_seen_at, capped at the server clock (a collector clock running ahead cannot keep a session fresh). */
const seenAt = (iso: string) => sql`least(${iso}::timestamptz, now())`;
const bumpSeen = (iso: string) => sql`last_seen_at = greatest(agent_sessions.last_seen_at, ${seenAt(iso)})`;

/**
 * session_start resolves and pins the session's team (ADR-0035): admin mapping → primary team → none; a
 * `project.team` from an older collector is ignored. Later events of the session reuse the stored team. The first
 * session_start with a project pins it: a later one (a lost collector state, a resume on a fresh state) keeps the
 * stored project and team even when the admin mapping or the user's memberships changed meanwhile, so one session's
 * turns never split across two teams. Without a project an existing session keeps its team.
 */
export async function applySessionStart(tx: Tx, ctx: BatchContext, e: SessionStartEvent): Promise<void> {
  const key = sessionKey(e.harness, e.session_id);
  const project = e.project ? await upsertProject(tx, ctx, e.project) : null;
  const teamId = project ? resolveTeam({ mappedTeamId: project.teamId, primaryTeamId: ctx.primaryTeamId }) : ctx.primaryTeamId;
  await lockSessionKey(tx, key);
  const [session] = await rows<{ id: string; team_id: string | null; project_id: string | null }>(
    tx,
    sql`insert into agent_sessions (team_id, user_id, machine_id, project_id, external_id, harness,
          harness_version, started_at, last_seen_at)
        values (${teamId}::uuid, ${ctx.userId}::uuid, ${ctx.machineRowId}::uuid,
          ${project?.id ?? null}::uuid, ${key}, ${e.harness},
          ${e.harness_version ?? null}, ${e.at}::timestamptz, ${seenAt(e.at)})
        on conflict (external_id) do update set
          ${project
            ? sql`team_id = case when agent_sessions.project_id is null then ${teamId}::uuid else agent_sessions.team_id end,
              project_id = coalesce(agent_sessions.project_id, ${project.id}::uuid),`
            : sql``}
          user_id = ${ctx.userId}::uuid, machine_id = ${ctx.machineRowId}::uuid, started_at = ${e.at}::timestamptz
          ${e.harness_version ? sql`, harness_version = ${e.harness_version}` : sql``}
          , ${bumpSeen(e.at)}
        where ${sessionOwnerGuard(ctx)}
        returning id, team_id, project_id`,
  );
  if (!session) throw new OwnerConflictError('session');
  await applyPendingSessionPatch(tx, session.id);
  if (!project) return;

  // Turns that arrived before their session_start had no project and the primary team: give them the session's
  // (pinned) project and team.
  await claimTurns(tx, ctx, sql`session_id = ${session.id}::uuid and project_id is null`);
  const backfilled = await rows<{ id: string; external_id: string; team_id: string | null; user_id: string | null }>(
    tx,
    sql`update turns set project_id = ${session.project_id}::uuid, team_id = ${session.team_id}::uuid, updated_at = now()
        where session_id = ${session.id}::uuid and project_id is null
        returning id, external_id, team_id, user_id`,
  );
  for (const t of backfilled) {
    await propagateTurnOwner(tx, { id: t.id, key: t.external_id, teamId: t.team_id, userId: t.user_id });
  }
}

export async function applySessionEnd(tx: Tx, ctx: BatchContext, e: SessionEndEvent): Promise<void> {
  const teamId = ctx.primaryTeamId;
  await lockSessionKey(tx, sessionKey(e.harness, e.session_id));
  const [done] = await rows<{ id: string }>(
    tx,
    sql`insert into agent_sessions (team_id, user_id, machine_id, external_id, harness,
          started_at, ended_at, end_reason, last_seen_at)
        values (${teamId}::uuid, ${ctx.userId}::uuid, ${ctx.machineRowId}::uuid,
          ${sessionKey(e.harness, e.session_id)}, ${e.harness}, ${e.at}::timestamptz, ${e.at}::timestamptz, ${e.reason},
          ${seenAt(e.at)})
        on conflict (external_id) do update set user_id = ${ctx.userId}::uuid,
          ended_at = case when agent_sessions.current_turn_started_at is null
              or agent_sessions.current_turn_started_at <= ${e.at}::timestamptz
            then ${e.at}::timestamptz else agent_sessions.ended_at end,
          current_turn_started_at = case when agent_sessions.current_turn_started_at <= ${e.at}::timestamptz
            then null else agent_sessions.current_turn_started_at end,
          ${bumpSeen(e.at)}
        where ${sessionOwnerGuard(ctx)}
        returning id`,
  );
  if (!done) throw new OwnerConflictError('session');
  // end_reason in its own statement (app_ingest cannot read it, 0017). An end older than a turn that already started
  // (a backlog batch orders turn_started before session_end) left ended_at alone, so it matches no row here.
  await tx.execute(sql`update agent_sessions set end_reason = ${e.reason}
    where id = ${done.id}::uuid and ended_at = ${e.at}::timestamptz`);
  await applyPendingSessionPatch(tx, done.id);
}

/**
 * Live status (ADR-0027): the main agent started a turn. Marks the session working since started_at (the newest start
 * wins), creates it on the fly when it has not arrived (like a turn) and re-opens it when it had ended before started_at
 * (a resumed session keeps its id and sends no new session_start).
 */
export async function applyTurnStarted(tx: Tx, ctx: BatchContext, e: TurnStartedEvent): Promise<void> {
  const key = sessionKey(e.harness, e.session_id);
  const teamId = ctx.primaryTeamId;
  await lockSessionKey(tx, key);
  const started = sql`${e.started_at}::timestamptz`;
  const [row] = await rows<{ id: string }>(
    tx,
    sql`insert into agent_sessions (team_id, user_id, machine_id, external_id, harness, started_at,
          current_turn_started_at, last_seen_at)
        values (${teamId}::uuid, ${ctx.userId}::uuid, ${ctx.machineRowId}::uuid, ${key},
          ${e.harness}, ${started}, ${started}, ${seenAt(e.started_at)})
        on conflict (external_id) do update set user_id = ${ctx.userId}::uuid,
          current_turn_started_at = greatest(agent_sessions.current_turn_started_at, ${started}),
          ${bumpSeen(e.started_at)}
        where ${sessionOwnerGuard(ctx)}
        returning id`,
  );
  if (!row) throw new OwnerConflictError('session');
  // Re-open a resumed session. A separate statement because app_ingest cannot read end_reason (0017 grants it the
  // liveness columns and ended_at only); it touches no row unless the session had ended before this start.
  await tx.execute(sql`update agent_sessions set ended_at = null, end_reason = null
    where id = ${row.id}::uuid and ended_at < ${started}`);
  await applyPendingSessionPatch(tx, row.id);
}

/** ON CONFLICT ... WHERE for agent_sessions: only the owner (or anyone, while unowned) may overwrite. */
const sessionOwnerGuard = (ctx: BatchContext) =>
  sql`(agent_sessions.user_id is null or agent_sessions.user_id = ${ctx.userId}::uuid)`;

/**
 * Makes ownerless (pre-ADR-0029) turns matching `where` the sender's, verified. Every write of the ingest role must
 * leave the row owned by the token's user (WITH CHECK user_id = app_user(), 0018) and RLS shows it only own and ownerless
 * rows, so a turn is claimed before it is updated. Own turns are left alone (app_ingest cannot read `attribution`, so
 * one statement could not keep an old `matched` value).
 */
async function claimTurns(tx: Tx, ctx: BatchContext, where: ReturnType<typeof sql>): Promise<void> {
  await tx.execute(sql`update turns set user_id = ${ctx.userId}::uuid, attribution = 'verified'
    where user_id is null and ${where}`);
}

/**
 * The session a turn belongs to, with its pinned team; created on the fly (primary team) when the turn arrives before
 * session_start, which then re-points the turn to the resolved team. Also keeps the live
 * status (ADR-0027): bumps last_seen_at to the turn's end and clears current_turn_started_at when the turn ended at or
 * after it (a later prompt's start stays).
 */
async function sessionForTurn(
  tx: Tx,
  ctx: BatchContext,
  e: TurnEvent,
): Promise<{ id: string; projectId: string | null; teamId: string | null }> {
  const key = sessionKey(e.harness, e.session_id);
  await lockSessionKey(tx, key);
  const [row] = await rows<{ id: string; project_id: string | null; team_id: string | null }>(
    tx,
    sql`insert into agent_sessions (team_id, user_id, machine_id, external_id, harness, started_at,
          last_seen_at)
        values (${ctx.primaryTeamId}::uuid, ${ctx.userId}::uuid, ${ctx.machineRowId}::uuid, ${key},
          ${e.harness}, ${e.started_at}::timestamptz, ${seenAt(e.ended_at)})
        on conflict (external_id) do update set user_id = ${ctx.userId}::uuid, ${bumpSeen(e.ended_at)},
          current_turn_started_at = case when agent_sessions.current_turn_started_at <= ${e.ended_at}::timestamptz
            then null else agent_sessions.current_turn_started_at end
        where ${sessionOwnerGuard(ctx)}
        returning id, project_id, team_id`,
  );
  if (!row) throw new OwnerConflictError('session');
  await applyPendingSessionPatch(tx, row.id);
  return { id: row.id, projectId: row.project_id, teamId: row.team_id };
}

async function hasMarker(tx: Tx, ...markerIds: string[]): Promise<boolean> {
  const ids = sql.join(markerIds.map((id) => sql`${id}`), sql`, `);
  const found = await rows(tx, sql`select 1 from ingest_events where event_id in (${ids}) limit 1`);
  return found.length > 0;
}

function outcomeSet(o: Outcome) {
  return sql`outcome = ${o.status}::outcome, outcome_signals = ${json(o.signals)}::jsonb,
    outcome_provisional = ${o.provisional}`;
}

export async function applyTurn(tx: Tx, ctx: BatchContext, e: TurnEvent, eventId: string): Promise<void> {
  const key = turnKey(e.harness, e.turn_id);
  await lockTurnKey(tx, key);
  const session = await sessionForTurn(tx, ctx, e);
  const teamId = session.teamId;
  const usage = mergeUsage(e.usage);
  const t = sumUsage(usage);
  const keepOutcome = await hasMarker(tx, outcomeMarker(ctx.userId, key), legacyOutcomeMarker(key));

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
    sql`insert into turns (team_id, user_id, attribution, session_id, project_id, external_id, harness,
          model, effort, started_at, ended_at, duration_ms, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, reasoning_tokens, requests, phases_ms, tools, skills, mcp, mcp_stats, outcome, outcome_signals,
          outcome_provisional, source_event_id, files_touched, lines_added, lines_removed, phase_rules_version)
        values (${teamId}::uuid, ${ctx.userId}::uuid, ${ctx.attribution}::attribution,
          ${session.id}::uuid, ${session.projectId}::uuid, ${key}, ${e.harness}, ${e.model}, ${e.effort},
          ${e.started_at}::timestamptz, ${e.ended_at}::timestamptz, ${durationMs(e.started_at, e.ended_at)},
          ${t.input}, ${t.output}, ${t.cacheRead}, ${t.cacheWrite}, ${t.reasoning}, ${t.requests},
          ${json(e.phases_ms)}::jsonb, ${json(e.tools)}::jsonb, ${json(e.skills)}::jsonb, ${json(e.mcp)}::jsonb, ${json(e.mcp_stats)}::jsonb,
          ${e.outcome.status}::outcome,
          ${json(e.outcome.signals)}::jsonb, ${e.outcome.provisional}, ${eventId}, ${e.files_touched},
          ${e.lines_added}, ${e.lines_removed}, ${e.phase_rules_version})
        on conflict (external_id) do update set ${cols}
          ${keepOutcome ? sql`` : sql`, ${outcomeSet(e.outcome)}`}
        where (turns.user_id is null or turns.user_id = ${ctx.userId}::uuid)
        returning id`,
  );
  if (!turn) throw new OwnerConflictError('turn');

  const owner = { id: turn.id, key, teamId, userId: ctx.userId };
  await replaceUsage(
    tx,
    { turnId: owner.id, runId: null, teamId, userId: ctx.userId, startedAt: e.started_at },
    usage,
  );
  await propagateTurnOwner(tx, owner);
  await tx.execute(sql`select ingest_apply_pending_patch(${owner.id}::uuid)`);
}

export async function applyRun(tx: Tx, ctx: BatchContext, e: RunEvent, eventId: string): Promise<void> {
  const key = turnKey(e.harness, e.turn_id);
  // Same lock as the turn: otherwise a turn batch committing between our read of the turn and our insert
  // would not see this run (propagateTurnOwner) and the run would stay unlinked (DP-13).
  await lockTurnKey(tx, key);
  const [turn] = await rows<{ id: string; team_id: string | null; user_id: string | null }>(
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
  const teamId = turn ? turn.team_id : ctx.primaryTeamId;
  // An ownerless (pre-ADR-0029) turn is claimed by its first token user, like every ownerless row.
  const userId = turn?.user_id ?? ctx.userId;
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
  // Agent flow (ADR-0020); flow_key sanitised by normalizeFlowKey, links de-duplicated without self-links.
  const stageIndex = e.stage_index ?? null;
  const flowKey = e.flow_key ?? null;

  const [run] = await rows<{ id: string }>(
    tx,
    sql`insert into runs (team_id, user_id, turn_id, turn_external_id, parent_run_id, parent_external_id,
          external_id, agent_type, agent_group, orchestration_id, stage_index, flow_key, depth, model, effort, started_at, ended_at, duration_ms, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, requests, phases_ms, tools, skills, mcp, mcp_stats, outcome,
          outcome_signals, outcome_provisional, source_event_id)
        values (${teamId}::uuid, ${userId}::uuid, ${turnId}::uuid, ${key}, ${parentId}::uuid,
          ${e.parent_run_id}, ${e.run_id}, ${e.agent_type}, ${agentGroup}, ${orchestrationId}, ${stageIndex}, ${flowKey}, ${e.depth}, ${model}, ${effort},
          ${e.started_at}::timestamptz, ${e.ended_at}::timestamptz, ${dur}, ${t.input}, ${t.output}, ${t.cacheRead},
          ${t.cacheWrite}, ${t.reasoning}, ${t.requests}, ${phases}::jsonb, ${tools}::jsonb, ${skills}::jsonb,
          ${mcp}::jsonb, ${mcpStats}::jsonb, ${e.outcome.status}::outcome, ${signals}::jsonb, ${e.outcome.provisional}, ${eventId})
        on conflict on constraint runs_turn_external_uq do update set
          team_id = ${teamId}::uuid, user_id = ${userId}::uuid, turn_id = coalesce(${turnId}::uuid, runs.turn_id),
          parent_run_id = coalesce(${parentId}::uuid, runs.parent_run_id), parent_external_id = ${e.parent_run_id},
          agent_type = ${e.agent_type}, agent_group = ${agentGroup}, orchestration_id = ${orchestrationId},
          stage_index = ${stageIndex}, flow_key = ${flowKey}, depth = ${e.depth}, model = ${model}, effort = ${effort},
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
  await tx.execute(sql`update runs set parent_run_id = ${run.id}::uuid, user_id = coalesce(runs.user_id, ${ctx.userId}::uuid)
    where turn_external_id = ${key} and parent_external_id = ${e.run_id} and parent_run_id is null`);
  await replaceRunLinks(tx, { key, turnId, runId: run.id, externalId: e.run_id }, e.links ?? []);
  await replaceUsage(
    tx,
    { turnId: null, runId: run.id, teamId, userId, startedAt: e.started_at },
    usage,
  );
}

/**
 * Replaces the incoming links of one run (ADR-0020): the run event carries all of them, so a re-sent run drops edges it
 * no longer reports (an older collector sends none). A source run that has not arrived yet keeps from_run_id NULL and
 * is resolved when it does; the same pass resolves the links that were waiting for THIS run as their source. Runs of
 * one turn key are serialised by the turn lock, so the two passes cannot miss each other.
 */
async function replaceRunLinks(
  tx: Tx,
  run: { key: string; turnId: string | null; runId: string; externalId: string },
  links: readonly RunLink[],
): Promise<void> {
  await tx.execute(sql`delete from run_links
    where turn_external_id = ${run.key} and to_external_id = ${run.externalId}`);
  const edges = links.filter((l) => l.from_run_id !== run.externalId);
  if (edges.length > 0) {
    const values = edges.map(
      (l) => sql`(${run.turnId}::uuid, ${run.key},
        (select id from runs where turn_external_id = ${run.key} and external_id = ${l.from_run_id}),
        ${run.runId}::uuid, ${l.from_run_id}, ${run.externalId}, ${l.kind})`,
    );
    await tx.execute(sql`insert into run_links (turn_id, turn_external_id, from_run_id, to_run_id,
        from_external_id, to_external_id, kind)
      values ${sql.join(values, sql`, `)}
      on conflict on constraint run_links_edge_uq do nothing`);
  }
  await tx.execute(sql`update run_links set from_run_id = ${run.runId}::uuid
    where turn_external_id = ${run.key} and from_external_id = ${run.externalId} and from_run_id is null`);
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
  await lockTurnKey(tx, key);
  const [turn] = await rows<{ user_id: string | null }>(tx, sql`select user_id from turns where external_id = ${key}`);
  if (turn) {
    assertOwner('turn', turn.user_id, ctx.userId);
    await claimTurns(tx, ctx, sql`external_id = ${key}`);
    await tx.execute(sql`update turns set ${set}, updated_at = now() where external_id = ${key}`);
  } else {
    // The parked patch remembers its sender (SEC-3): ingest_apply_pending_patch applies it only to an
    // ownerless turn or one of the same owner, and another user cannot overwrite a parked patch.
    const parked = await rows<{ id: string }>(
      tx,
      sql`insert into pending_turn_patches (turn_external_id, user_id, ${cols})
        values (${key}, ${ctx.userId}::uuid, ${vals})
        on conflict (turn_external_id) do update set ${set}, user_id = ${ctx.userId}::uuid, received_at = now()
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
  const turn = turnKey(e.harness, e.turn_id);
  await lockTurnKey(tx, turn);
  if (o.provisional && (await hasMarker(tx, finalOutcomeMarker(ctx.userId, turn), legacyFinalOutcomeMarker(turn)))) return;
  const key = await patchTurn(
    tx,
    ctx,
    e,
    sql`outcome, outcome_signals, outcome_provisional`,
    sql`${o.status}::outcome, ${json(o.signals)}::jsonb, ${o.provisional}`,
    outcomeSet(o),
  );
  await tx.execute(sql`insert into ingest_events (event_id, type)
    values (${outcomeMarker(ctx.userId, key)}, 'marker') on conflict (event_id) do nothing`);
  if (!o.provisional) {
    await tx.execute(sql`insert into ingest_events (event_id, type)
      values (${finalOutcomeMarker(ctx.userId, key)}, 'marker') on conflict (event_id) do nothing`);
  }
}

export async function applyTurnSummary(tx: Tx, ctx: BatchContext, e: TurnSummaryEvent): Promise<void> {
  await patchTurn(tx, ctx, e, sql`summary`, sql`${e.summary}`, sql`summary = ${e.summary}`);
}

/**
 * Sets the session's title (ADR-0026), or parks it in pending_session_patches while the session has not arrived; a
 * patch never creates a session. Only the session's owner (or anyone, while it has none) may set it; a parked title
 * remembers its sender and is applied only to an ownerless session or one of the same owner (SEC-3).
 */
export async function applySessionTitle(tx: Tx, ctx: BatchContext, e: SessionTitleEvent): Promise<void> {
  const key = sessionKey(e.harness, e.session_id);
  await lockSessionKey(tx, key);
  const [session] = await rows<{ user_id: string | null }>(
    tx,
    sql`select user_id from agent_sessions where external_id = ${key}`,
  );
  if (session) {
    assertOwner('session', session.user_id, ctx.userId);
    await tx.execute(sql`update agent_sessions set title = ${e.title}, title_source = ${e.source}, user_id = ${ctx.userId}::uuid
      where external_id = ${key}`);
    return;
  }
  const parked = await rows<{ id: string }>(
    tx,
    sql`insert into pending_session_patches (session_external_id, user_id, title, title_source)
      values (${key}, ${ctx.userId}::uuid, ${e.title}, ${e.source})
      on conflict (session_external_id) do update set title = ${e.title}, title_source = ${e.source},
        user_id = ${ctx.userId}::uuid, received_at = now()
      where pending_session_patches.user_id is null or pending_session_patches.user_id = ${ctx.userId}::uuid
      returning id`,
  );
  if (!parked.length) throw new OwnerConflictError('session patch');
}
