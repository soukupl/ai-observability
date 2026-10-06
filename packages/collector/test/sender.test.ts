import { afterEach, describe, expect, it } from 'vitest';
import { turnSummaryEvent } from '../src/events.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { EventQueue } from '../src/queue.js';
import { flushQueue, getCollectorConfig, readDeliveryState } from '../src/sender.js';
import { cleanupHomes, okResponder, startServer, tmpHome, writeTestConfig } from './helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  cleanupHomes();
});

const events = (n: number, start = 0): IngestEvent[] =>
  Array.from({ length: n }, (_, i) => turnSummaryEvent({ harness: 'claude-code', turnId: `t${start + i}`, summary: 'Did a thing', at: 1_700_000_000_000 })!);

async function setup(respond: Parameters<typeof startServer>[0]) {
  const srv = await startServer(respond);
  closers.push(srv.close);
  const paths = tmpHome();
  const config = writeTestConfig(paths, srv.url);
  const queue = new EventQueue(paths.queue);
  return { srv, paths, config, queue };
}

describe('flushQueue', () => {
  it('POSTs gzip JSON batches with the Bearer token and acks them', async () => {
    const { srv, paths, config, queue } = await setup(okResponder());
    queue.enqueue(events(750));
    const r = await flushQueue(queue, { config, paths });
    expect(r).toMatchObject({ status: 'ok', batches: 2, sent: 750, accepted: 750 });
    expect(srv.received).toHaveLength(2);
    const req = srv.received[0]!;
    expect(req.url).toBe('/api/v1/ingest');
    expect(req.headers.authorization).toBe('Bearer aiobs_u_testtoken');
    expect(req.headers['content-encoding']).toBe('gzip');
    const body = req.json as { schema: number; machine: { id: string }; identity: { git_email?: string }; events: unknown[] };
    expect(body.schema).toBe(1);
    expect(body.machine.id).toBe(config.machine_id);
    expect(body.identity.git_email).toBe('dev@acme.com');
    expect(body.events).toHaveLength(500);
    expect(queue.stats().events).toBe(0);
    expect(readDeliveryState(paths).last_success_at).toBeTruthy();
  });

  it('counts duplicates and rejected events as delivered', async () => {
    const { queue, paths, config } = await setup(() => ({
      status: 200,
      body: { accepted: 1, duplicates: 2, rejected: [{ event_id: 'x', reason: 'bad' }] },
    }));
    queue.enqueue(events(4));
    const r = await flushQueue(queue, { config, paths });
    expect(r).toMatchObject({ status: 'ok', accepted: 1, duplicates: 2, rejected: 1 });
    expect(queue.stats().events).toBe(0);
  });

  it('keeps events queued on 5xx and backs off; force ignores the backoff', async () => {
    let fail = true;
    const { srv, queue, paths, config } = await setup((req) => (fail ? { status: 503 } : okResponder()(req)));
    queue.enqueue(events(3));
    const r1 = await flushQueue(queue, { config, paths });
    expect(r1.status).toBe('failed');
    expect(queue.stats().events).toBe(3);
    const st = readDeliveryState(paths);
    expect(st.consecutive_failures).toBe(1);
    expect(Date.parse(st.next_attempt_at!)).toBeGreaterThan(Date.now());

    const r2 = await flushQueue(queue, { config, paths });
    expect(r2.status).toBe('backoff');
    expect(srv.received).toHaveLength(1);

    fail = false;
    const r3 = await flushQueue(queue, { config, paths }, { force: true });
    expect(r3).toMatchObject({ status: 'ok', sent: 3 });
    expect(readDeliveryState(paths).consecutive_failures).toBe(0);
  });

  it('a retry after a lost response re-sends the same event ids (server de-dupes)', async () => {
    let n = 0;
    const { srv, queue, paths, config } = await setup((req) => (++n === 1 ? { status: 500 } : okResponder()(req)));
    queue.enqueue(events(2));
    await flushQueue(queue, { config, paths });
    await flushQueue(queue, { config, paths }, { force: true });
    const ids = srv.received.map((r) => (r.json as { events: Array<{ event_id: string }> }).events.map((e) => e.event_id));
    expect(ids[0]).toEqual(ids[1]);
  });

  it('reports auth errors and keeps the queue', async () => {
    const { queue, paths, config } = await setup(() => ({ status: 401, body: { error: 'invalid token' } }));
    queue.enqueue(events(1));
    const r = await flushQueue(queue, { config, paths });
    expect(r.status).toBe('auth_error');
    expect(queue.stats().events).toBe(1);
  });

  it('honours Retry-After on 429', async () => {
    const { queue, paths, config } = await setup(() => ({ status: 429, headers: { 'retry-after': '600' } }));
    queue.enqueue(events(1));
    await flushQueue(queue, { config, paths });
    const next = Date.parse(readDeliveryState(paths).next_attempt_at!);
    expect(next - Date.now()).toBeGreaterThan(590_000);
  });

  it('halves the batch on 413 and dead-letters on 400', async () => {
    const { srv, queue, paths, config } = await setup((req) => {
      const n = (req.json as { events: unknown[] }).events.length;
      if (n > 2) return { status: 413 };
      return n === 1 ? { status: 400, body: { error: 'bad envelope' } } : okResponder()(req);
    });
    queue.enqueue(events(5));
    const r = await flushQueue(queue, { config, paths });
    expect(r.sent).toBe(4);
    expect(queue.stats().events).toBe(0);
    expect(srv.received.length).toBeGreaterThan(3);
  });

  it('times out a hanging server and keeps events', async () => {
    const { queue, paths, config } = await setup(() => ({ status: 200, delayMs: 5000 }));
    queue.enqueue(events(1));
    const r = await flushQueue(queue, {
      config,
      paths,
      transport: async (req) => (await import('../src/http.js')).nodeTransport({ ...req, timeoutMs: 200 }),
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/timeout/);
    expect(queue.stats().events).toBe(1);
  });

  it('network failure keeps events', async () => {
    const paths = tmpHome();
    const config = writeTestConfig(paths, 'http://127.0.0.1:9');
    const queue = new EventQueue(paths.queue);
    queue.enqueue(events(1));
    expect((await flushQueue(queue, { config, paths })).status).toBe('failed');
    expect(queue.stats().events).toBe(1);
  });
});

describe('getCollectorConfig', () => {
  it('fetches, caches with a TTL, and falls back to the cache when offline', async () => {
    const { srv, paths, config } = await setup(okResponder('plain'));
    const a = await getCollectorConfig({ config, paths });
    expect(a).toMatchObject({ source: 'fresh', value: { project_naming: 'plain' } });
    const b = await getCollectorConfig({ config, paths });
    expect(b.source).toBe('cache');
    expect(srv.received).toHaveLength(1);
    const offline = { ...config, endpoint: 'http://127.0.0.1:9' };
    const c = await getCollectorConfig({ config: offline, paths }, { force: true });
    expect(c).toMatchObject({ source: 'cache', value: { project_naming: 'plain' } });
  });

  it('keeps the company project_salt (and ignores an implausible one)', async () => {
    const salted = await setup(() => ({ status: 200, body: { project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: 's'.repeat(32) } }));
    const a = await getCollectorConfig({ config: salted.config, paths: salted.paths });
    expect(a.value).toEqual({ project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: 's'.repeat(32) });
    expect((await getCollectorConfig({ config: salted.config, paths: salted.paths })).value.project_salt).toBe('s'.repeat(32)); // from cache
    const short = await setup(() => ({ status: 200, body: { project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: 'abc' } }));
    expect((await getCollectorConfig({ config: short.config, paths: short.paths })).value).toEqual({ project_naming: 'hashed', min_collector_version: '0.0.1' });
  });

  it('defaults to hashed project naming when the server was never reached', async () => {
    const paths = tmpHome();
    const config = writeTestConfig(paths);
    const r = await getCollectorConfig({ config, paths });
    expect(r).toMatchObject({ source: 'default', value: { project_naming: 'hashed' } });
  });
});
