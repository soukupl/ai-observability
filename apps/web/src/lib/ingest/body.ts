import { gunzipSync } from 'node:zlib';
import { MAX_BATCH_BYTES, MAX_BATCH_EVENTS } from '@ai-obs/protocol';

export type BodyResult = { ok: true; json: unknown } | { ok: false; status: 400 | 413 | 415; error: string };

const tooLarge = { ok: false, status: 413, error: `batch exceeds ${MAX_BATCH_BYTES} bytes` } as const;

/**
 * Reads an ingest request body: plain JSON or `Content-Encoding: gzip`. Both the bytes on the wire
 * and the decompressed JSON are capped at MAX_BATCH_BYTES (413), as is the number of events (413).
 */
export async function readBatchBody(request: Request, maxBytes: number = MAX_BATCH_BYTES): Promise<BodyResult> {
  const encoding = (request.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (!['identity', 'gzip', 'x-gzip'].includes(encoding)) {
    return { ok: false, status: 415, error: `unsupported content-encoding "${encoding}"` };
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;

  const raw = await readCapped(request, maxBytes);
  if (!raw) return tooLarge;

  let text: string;
  if (encoding === 'identity') {
    text = raw.toString('utf8');
  } else {
    try {
      text = gunzipSync(raw, { maxOutputLength: maxBytes }).toString('utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) return tooLarge;
      return { ok: false, status: 400, error: 'invalid gzip body' };
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: 'body is not valid JSON' };
  }
  const events = (json as { events?: unknown } | null)?.events;
  if (Array.isArray(events) && events.length > MAX_BATCH_EVENTS) {
    return { ok: false, status: 413, error: `batch exceeds ${MAX_BATCH_EVENTS} events` };
  }
  return { ok: true, json };
}

/** Buffers the body, or returns null as soon as it grows past `max` bytes. */
async function readCapped(request: Request, max: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}
