import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionStartEvent } from '../src/events.js';
import { writeJob } from '../src/jobs.js';
import { tryLock } from '../src/lock.js';
import { runWorker } from '../src/worker.js';
import { cleanupHomes, fakeAdapter, okResponder, startServer, tmpHome, writeTestConfig } from './helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  cleanupHomes();
});

const job = (hook: string, session = 's1') => ({
  v: 1 as const,
  harness: 'claude-code' as const,
  hook,
  payload: { session_id: session },
  cwd: '/work/repo',
  env: {},
  received_at: new Date().toISOString(),
});

describe('runWorker', () => {
  it('processes jobs in order, sweeps on session start, enqueues and flushes', async () => {
    const srv = await startServer(okResponder('plain'));
    closers.push(srv.close);
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    writeJob(paths.jobs, job('SessionStart'), 1000);
    writeJob(paths.jobs, job('Stop'), 2000);
    let swept = 0;
    let naming = '';
    const adapter = fakeAdapter({
      async sweepCrashedSessions() {
        swept++;
      },
    });
    adapter.handleHook = async (event, ctx) => {
      adapter.calls.push(event);
      naming = ctx.projectNaming;
      const project = await ctx.projectKey(event.cwd);
      ctx.queue.enqueue([sessionStartEvent({ harness: ctx.harness, sessionId: `${event.hook}`, at: ctx.now(), project })]);
    };
    const r = await runWorker({
      paths,
      adapters: [adapter],
      resolveProject: async () => ({ key: 'github.com/acme/billing', name: 'billing' }),
    });
    expect(r).toMatchObject({ ran: true, jobs: 2, failed: 0, flush: { status: 'ok', sent: 2 } });
    expect(adapter.calls.map((c) => c.hook)).toEqual(['SessionStart', 'Stop']);
    expect(swept).toBe(1);
    expect(naming).toBe('plain');
    expect(readdirSync(paths.jobs)).toEqual([]);
    const ingest = srv.received.find((x) => x.url === '/api/v1/ingest')!;
    expect((ingest.json as { events: unknown[] }).events).toHaveLength(2);
  });

  it('hands the company salt and the local path secret to project resolution', async () => {
    const srv = await startServer((req) =>
      req.url === '/api/v1/collector-config'
        ? { status: 200, body: { project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: 'company-salt-0123456789' } }
        : { status: 200, body: { accepted: 0, duplicates: 0, rejected: [] } },
    );
    closers.push(srv.close);
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    writeJob(paths.jobs, job('Stop'), 1000);
    const adapter = fakeAdapter();
    adapter.handleHook = async (event, ctx) => void (await ctx.projectKey(event.cwd));
    const seen: unknown[] = [];
    await runWorker({
      paths,
      adapters: [adapter],
      flush: false,
      resolveProject: async (_cwd, _naming, secrets) => (seen.push(secrets), { key: 'github.com/acme/billing' }),
    });
    expect(seen).toEqual([{ projectSalt: 'company-salt-0123456789', pathSecret: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });

  it('logs a failing job and keeps going', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    writeJob(paths.jobs, job('Stop'), 1000);
    writeJob(paths.jobs, job('Stop', 's2'), 2000);
    const adapter = fakeAdapter();
    let n = 0;
    adapter.handleHook = async () => {
      if (++n === 1) throw new Error('transcript missing');
    };
    const r = await runWorker({ paths, adapters: [adapter], flush: false });
    expect(r).toMatchObject({ jobs: 2, failed: 1 });
  });

  it('exits when another worker holds the lock (the holder picks the job up)', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    writeJob(paths.jobs, job('Stop'), 1000);
    const release = tryLock(paths.workerLock)!;
    const r = await runWorker({ paths, adapters: [fakeAdapter()], flush: false });
    expect(r.ran).toBe(false);
    expect(readdirSync(paths.jobs)).toHaveLength(1);
    release();
    expect((await runWorker({ paths, adapters: [fakeAdapter()], flush: false })).jobs).toBe(1);
  });

  it('takes over a lock left by a dead process', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.workerLock, '999999 2026-01-01T00:00:00Z');
    writeJob(paths.jobs, job('Stop'), 1000);
    expect((await runWorker({ paths, adapters: [fakeAdapter()], flush: false })).jobs).toBe(1);
    expect(existsSync(paths.workerLock)).toBe(false);
  });

  it('discards jobs when not configured', async () => {
    const paths = tmpHome();
    writeJob(paths.jobs, job('Stop'), 1000);
    expect((await runWorker({ paths, adapters: [fakeAdapter()] })).ran).toBe(false);
    expect(readdirSync(paths.jobs)).toEqual([]);
  });
});
