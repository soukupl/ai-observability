import { sql } from 'drizzle-orm';
import type { Tx } from '@ai-obs/db';
import type { BatchHeader, IngestEvent, IngestResponse, RejectedEvent } from '@ai-obs/protocol';
import {
  applyRun,
  applySessionEnd,
  applySessionStart,
  applySessionTitle,
  applyTurn,
  applyTurnOutcome,
  applyTurnStarted,
  applyTurnSummary,
  lockBatchSessions,
} from './apply-events';
import { OwnerConflictError, rows, type BatchContext, type TokenContext } from './context';
import { enforceLimits, timeWindowProblem } from './limits';
import { upsertMachine } from './resolve';

/** Apply order inside a batch: sessions, turn starts, turns, runs (parents first), patches, session ends. */
const TYPE_ORDER: Record<IngestEvent['type'], number> = {
  session_start: 0,
  turn_started: 1,
  turn: 2,
  run: 3,
  turn_outcome: 4,
  turn_summary: 4,
  session_title: 4,
  session_end: 5,
};

/**
 * Stable ordering that lets one batch be applied without forward references. Patches keep their
 * relative order, so the last outcome patch for a turn wins. Pure.
 */
export function orderEvents(events: readonly IngestEvent[]): IngestEvent[] {
  return events
    .map((event, i) => ({ event, i }))
    .sort((a, b) => {
      const byType = TYPE_ORDER[a.event.type] - TYPE_ORDER[b.event.type];
      if (byType) return byType;
      if (a.event.type === 'run' && b.event.type === 'run') return a.event.depth - b.event.depth || a.i - b.i;
      return a.i - b.i;
    })
    .map((x) => x.event);
}

async function applyEvent(tx: Tx, ctx: BatchContext, e: IngestEvent): Promise<void> {
  switch (e.type) {
    case 'session_start':
      return applySessionStart(tx, ctx, e);
    case 'turn_started':
      return applyTurnStarted(tx, ctx, e);
    case 'turn':
      return applyTurn(tx, ctx, e, e.event_id);
    case 'run':
      return applyRun(tx, ctx, e, e.event_id);
    case 'turn_outcome':
      return applyTurnOutcome(tx, ctx, e);
    case 'turn_summary':
      return applyTurnSummary(tx, ctx, e);
    case 'session_title':
      return applySessionTitle(tx, ctx, e);
    case 'session_end':
      return applySessionEnd(tx, ctx, e);
  }
}

/**
 * Events applied under one savepoint. Every write inside a savepoint gives the transaction a
 * subtransaction id, and a backend caches only 64 of them: beyond that, every concurrent snapshot has
 * to consult pg_subtrans (DP-14). One savepoint per chunk keeps a 500-event batch at ~20.
 */
export const EVENTS_PER_SAVEPOINT = 25;

/**
 * De-duplication key of an event in the ledger. Namespaced by the token's user so one sender cannot pre-claim
 * another's event ids and get the real events dropped as duplicates (SEC-3). Collector ids are unique per sender
 * anyway; the same user's several tokens and machines share a namespace, so their retries still de-duplicate.
 */
export function ledgerKey(ctx: Pick<BatchContext, 'userId'>, eventId: string): string {
  return `${ctx.userId}:${eventId}`;
}

type Outcome = 'accepted' | 'duplicate';

/**
 * Applies validated events of one batch. Must run inside withIngestContext(db, token.userId).
 * Events are applied in chunks, each chunk under one savepoint, together with the events' ledger rows
 * (ingest_events): a replayed event is counted as a duplicate and changes nothing. When a chunk fails,
 * it is rolled back as a whole and its events are retried one per savepoint, so a failing event is
 * rejected without losing the rest of the batch and without being marked as seen.
 *
 * Every row belongs to the token's user (attribution `verified`, ADR-0029); `header.identity.git_email` is ignored.
 */
export async function processBatch(
  tx: Tx,
  token: TokenContext,
  header: BatchHeader,
  events: readonly IngestEvent[],
  log: (msg: string, err: unknown) => void = defaultLog,
  now: number = Date.now(),
): Promise<IngestResponse> {
  const ctx: BatchContext = {
    token,
    userId: token.userId,
    attribution: 'verified',
    primaryTeamId: token.primaryTeamId,
    machineRowId: await upsertMachine(tx, header.machine, token.userId),
  };

  let accepted = 0;
  let duplicates = 0;
  const rejected: RejectedEvent[] = [];

  const applyOne = async (sp: Tx, event: IngestEvent): Promise<Outcome> => {
    const [row] = await rows<{ id: string }>(
      sp,
      sql`insert into ingest_events (event_id, type)
          values (${ledgerKey(ctx, event.event_id)}, ${event.type})
          on conflict (event_id) do nothing returning id`,
    );
    if (!row) return 'duplicate';
    await applyEvent(sp, ctx, event);
    return 'accepted';
  };
  const tally = (o: Outcome) => (o === 'accepted' ? accepted++ : duplicates++);

  const ordered: IngestEvent[] = [];
  for (const event of orderEvents(events)) {
    const outside = timeWindowProblem(event, token.retentionDays, now);
    if (outside) {
      rejected.push({ event_id: event.event_id, reason: outside });
      continue;
    }
    const limited = enforceLimits(event, token.projectNaming);
    if (limited.ok) ordered.push(limited.event);
    else rejected.push({ event_id: event.event_id, reason: limited.reason });
  }

  // Every session lock of the batch first, outside the savepoints (ADR-0026): keeps the lock order sessions → turns.
  await lockBatchSessions(tx, ordered);

  for (let i = 0; i < ordered.length; i += EVENTS_PER_SAVEPOINT) {
    const chunk = ordered.slice(i, i + EVENTS_PER_SAVEPOINT);
    try {
      const outcomes = await tx.transaction(async (sp) => {
        const out: Outcome[] = [];
        for (const event of chunk) out.push(await applyOne(sp, event));
        return out;
      });
      outcomes.forEach(tally);
      continue;
    } catch {
      // Rolled back as a whole; find the failing event(s).
    }
    for (const event of chunk) {
      try {
        tally(await tx.transaction((sp) => applyOne(sp, event)));
      } catch (err) {
        if (err instanceof OwnerConflictError) {
          rejected.push({ event_id: event.event_id, reason: 'conflicts with data owned by another user' });
          continue;
        }
        log(`ingest: event ${event.event_id} (${event.type}) failed`, err);
        rejected.push({ event_id: event.event_id, reason: 'could not be stored' });
      }
    }
  }
  return { accepted, duplicates, rejected };
}

function defaultLog(msg: string, err: unknown) {
  // Error text only: never the event payload.
  console.error(msg, (err as { code?: string }).code ?? '', (err as Error).message);
}
