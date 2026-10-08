import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamHolder } from '../src/adapters/types.js';
import { writeCache } from '../src/cc-cache.js';
import { newMachineConfig, saveConfig, type TokenEntry } from '../src/config.js';
import { sessionStartEvent } from '../src/events.js';
import { writeJob } from '../src/jobs.js';
import { tryLock } from '../src/lock.js';
import { streamDirName } from '../src/projects.js';
import { ulid } from '../src/ulid.js';
import { runWorker } from '../src/worker.js';
import { ACME, cleanupHomes, fakeAdapter, okResponder, startServer, tmpHome, writeTestConfig } from './helpers.js';
import { bound } from './queue-helpers.js';

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

/** A fake adapter that pins one stream per session (like the real adapters) and enqueues a session_start per hook. */
function streamingAdapter(overrides: Parameters<typeof fakeAdapter>[0] = {}) {
  const adapter = fakeAdapter(overrides);
  const sessions = new Map<string, StreamHolder>();
  adapter.handleHook = async (event, ctx) => {
    adapter.calls.push(event);
    const sid = (event.payload as { session_id: string }).session_id;
    const holder = sessions.get(sid) ?? { pkCwd: event.cwd };
    sessions.set(sid, holder);
    const project = await ctx.projectKey(event.cwd);
    const key = await ctx.streamFor(holder, Date.parse(event.receivedAt));
    ctx.queue.enqueue([sessionStartEvent({ harness: ctx.harness, sessionId: `${sid}-${event.hook}`, at: ctx.now(), project })], key);
  };
  return adapter;
}

describe('runWorker', () => {
  it('processes jobs in order, sweeps on session start, enqueues into the project stream and flushes', async () => {
    const srv = await startServer(okResponder('plain'));
    closers.push(srv.close);
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    writeJob(paths.jobs, job('SessionStart'), 1000);
    writeJob(paths.jobs, job('Stop'), 2000);
    let swept = 0;
    const adapter = streamingAdapter({
      async sweepCrashedSessions() {
        swept++;
      },
    });
    const r = await runWorker({ paths, adapters: [adapter], resolveProject: async () => 'github.com/acme/billing' });
    expect(r).toMatchObject({ ran: true, jobs: 2, failed: 0, flush: { status: 'ok', sent: 2 } });
    expect(adapter.calls.map((c) => c.hook)).toEqual(['SessionStart', 'Stop']);
    expect(swept).toBe(1);
    expect(readdirSync(paths.jobs)).toEqual([]);
    const ingest = srv.received.find((x) => x.url === '/api/v1/ingest')!;
    const sent = (ingest.json as { events: Array<{ project?: unknown }> }).events;
    expect(sent).toHaveLength(2);
    expect(sent[0]!.project).toEqual({ key: 'github.com/acme/billing', name: 'billing' });
  });

  it('still processes a v1 job written by the 0.1.x hook', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    mkdirSync(paths.jobs, { recursive: true });
    writeFileSync(join(paths.jobs, `${ulid(1000)}.json`), JSON.stringify(job('Stop')));
    const adapter = streamingAdapter();
    const r = await runWorker({ paths, adapters: [adapter], flush: false, resolveProject: async () => 'github.com/acme/billing' });
    expect(r).toMatchObject({ jobs: 1, failed: 0 });
    expect(readdirSync(paths.jobs)).toEqual([]);
  });

  it('queues the plain key bound to the token and hashes it with the company salt only at send time', async () => {
    const salt = 'company-salt-0123456789';
    const srv = await startServer((req) =>
      req.url === '/api/v1/collector-config'
        ? { status: 200, body: { project_naming: 'hashed', min_collector_version: '0.0.1', project_salt: salt, company: ACME, user: null } }
        : { status: 200, body: { accepted: 1, duplicates: 0, rejected: [] } },
    );
    closers.push(srv.close);
    const paths = tmpHome();
    const config = writeTestConfig(paths, srv.url);
    // a stale cache: the flush fetches the company's real (hashed, salted) config
    writeCache(paths, config.tokens[0] as TokenEntry, { fetched_at: new Date(0).toISOString() });
    writeJob(paths.jobs, job('Stop'), 1000);
    const seen: unknown[][] = [];
    const resolveProject = async (...args: unknown[]) => (seen.push(args), 'github.com/acme/billing');
    const adapter = streamingAdapter();
    const r = await runWorker({ paths, adapters: [adapter], flush: false, resolveProject });
    expect(r.failed).toBe(0);
    expect(seen).toEqual([['/work/repo']]);
    const bind = bound('acme', srv.url, 'acme', 'aiobs_u_testtoken');
    const dir = join(paths.queueProjects, streamDirName('github.com/acme/billing', bind));
    expect(JSON.parse(readFileSync(join(dir, 'stream.json'), 'utf8'))).toMatchObject({ pk: 'github.com/acme/billing', bind: { kind: 'token', name: 'acme', id: { company_slug: 'acme' } } });
    expect(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.ndjson'))!), 'utf8')).toContain('"key":"github.com/acme/billing"');

    const flushed = await runWorker({ paths, adapters: [adapter] });
    expect(flushed.flush).toMatchObject({ status: 'ok', sent: 1 });
    const ingest = srv.received.find((x) => x.url === '/api/v1/ingest')!;
    const [ev] = (ingest.json as { events: Array<{ project?: unknown }> }).events;
    expect(ev!.project).toEqual({ key: `sha256:${createHmac('sha256', salt).update('github.com/acme/billing').digest('hex')}` });
  });

  it('runs another flush when projects.json changed during the flush (C17)', async () => {
    let posts = 0;
    const paths = tmpHome();
    const srv = await startServer((req) => {
      if (req.url === '/api/v1/ingest' && ++posts === 1) writeFileSync(paths.projects, '{}\n');
      return okResponder()(req);
    });
    closers.push(srv.close);
    writeTestConfig(paths, srv.url);
    writeJob(paths.jobs, job('Stop'), 1000);
    const r = await runWorker({ paths, adapters: [streamingAdapter()], resolveProject: async () => 'github.com/acme/billing' });
    expect(r.flush).toMatchObject({ status: 'empty' }); // the second loop found nothing left
    expect(posts).toBe(1);
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

  it('discards jobs while no token is registered (pre-upgrade config, C6)', async () => {
    const paths = tmpHome();
    saveConfig(paths, newMachineConfig(null));
    writeJob(paths.jobs, job('Stop'), 1000);
    const adapter = fakeAdapter();
    expect((await runWorker({ paths, adapters: [adapter] })).ran).toBe(false);
    expect(adapter.calls).toEqual([]);
    expect(readdirSync(paths.jobs)).toEqual([]);
  });

  it('deletes SessionStart nudge markers older than 7 days', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    const { utimesSync } = await import('node:fs');
    mkdirSync(paths.nudged, { recursive: true });
    writeFileSync(join(paths.nudged, 'old'), 'x');
    writeFileSync(join(paths.nudged, 'new'), 'x');
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(join(paths.nudged, 'old'), old, old);
    writeJob(paths.jobs, job('Stop'), 1000);
    await runWorker({ paths, adapters: [fakeAdapter()], flush: false });
    expect(readdirSync(paths.nudged)).toEqual(['new']);
  });
});
