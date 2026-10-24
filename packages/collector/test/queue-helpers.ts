import { recordDropped } from '../src/delivery.js';
import type { AiObsPaths } from '../src/paths.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { QueueStore, type QueueOptions } from '../src/queue.js';
import { loadRouting, type RoutingView, type StreamKey } from '../src/routing.js';

/** A store over paths.queue with fresh routing from disk (or `routing`) and the real drop counters. */
export function queueStore(paths: AiObsPaths, routing?: () => RoutingView | null, opts: QueueOptions = {}): QueueStore {
  return new QueueStore(paths.queue, {
    ...opts,
    routing: routing ?? (() => loadRouting(paths, opts.now?.() ?? Date.now())),
    dropped: (d) => recordDropped(paths, d),
  });
}

export function projectKey(pk: string, endpoint: string, team = ''): StreamKey {
  return { kind: 'project', pk, endpoint, team };
}

export function enqueueFor(store: QueueStore, pk: string, endpoint: string, events: readonly IngestEvent[], team = ''): StreamKey {
  const key = projectKey(pk, endpoint, team);
  store.enqueue(events, key);
  return key;
}
