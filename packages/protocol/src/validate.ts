import type { z } from 'zod';
import { batchEnvelope } from './batch.js';
import { ingestEvent } from './events.js';
import type { IngestEvent, RejectedEvent } from './types.js';

export type BatchHeader = Omit<z.infer<typeof batchEnvelope>, 'events'>;

export type ValidateBatchResult =
  | { ok: true; header: BatchHeader; events: IngestEvent[]; rejected: RejectedEvent[] }
  | { ok: false; error: string };

/**
 * Validates a parsed ingest batch. An invalid envelope fails the whole batch (`ok: false`, HTTP 400);
 * invalid events are returned in `rejected` while the valid ones proceed.
 */
export function validateBatch(input: unknown): ValidateBatchResult {
  const envelope = batchEnvelope.safeParse(input);
  if (!envelope.success) return { ok: false, error: formatIssues(envelope.error) };

  const { events: rawEvents, ...header } = envelope.data;
  const events: IngestEvent[] = [];
  const rejected: RejectedEvent[] = [];

  for (const raw of rawEvents) {
    const parsed = ingestEvent.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else rejected.push({ event_id: eventIdOf(raw), reason: formatIssues(parsed.error) });
  }
  return { ok: true, header, events, rejected };
}

function eventIdOf(raw: unknown): string | null {
  if (raw && typeof raw === 'object' && 'event_id' in raw && typeof raw.event_id === 'string') {
    return raw.event_id.slice(0, 64);
  }
  return null;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}
