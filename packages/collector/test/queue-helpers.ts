import { tokenFingerprint } from '../src/config.js';
import { recordDropped } from '../src/delivery.js';
import type { AiObsPaths } from '../src/paths.js';
import { loadRouting, OPEN, type Binding, type RoutingView } from '../src/projects.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { QueueStore, type QueueOptions, type StreamKey } from '../src/queue.js';

export { OPEN };

/** A store over paths.queue with fresh routing from disk (or `routing`) and the real drop counters. */
export function queueStore(paths: AiObsPaths, routing?: () => RoutingView | null, opts: QueueOptions = {}): QueueStore {
  return new QueueStore(paths.queue, {
    ...opts,
    routing: routing ?? (() => loadRouting(paths)),
    dropped: (d) => recordDropped(paths, d),
  });
}

/**
 * A binding to a verified token, as captureBinding writes it: endpoint + company slug (the fingerprint
 * is informative only when a slug is given). Defaults match writeTestTokens (`aiobs_u_test-<name>`).
 */
export function bound(name: string, endpoint = 'http://127.0.0.1:9', slug: string | null = name, token = `aiobs_u_test-${name}`): Binding {
  return { kind: 'token', id: { endpoint, ...(slug ? { company_slug: slug } : {}), token_fp: tokenFingerprint(token) }, name };
}

export function projectKey(pk: string, bind: Binding): StreamKey {
  return { kind: 'project', pk, bind };
}

export function enqueueFor(store: QueueStore, pk: string, bind: Binding, events: readonly IngestEvent[]): StreamKey {
  const key = projectKey(pk, bind);
  store.enqueue(events, key);
  return key;
}
