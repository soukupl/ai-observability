import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamHolder } from '../src/adapters/types.js';
import { buildDigest } from '../src/analysis/digest.js';
import { listStagedDigests, pendingSummariesPath, stageDigests } from '../src/analysis/summaries.js';
import { writeCache } from '../src/cc-cache.js';
import { newMachineConfig, saveConfig } from '../src/config.js';
import { sessionStartEvent, turnEvent } from '../src/events.js';
import { writeJob } from '../src/jobs.js';
import { nullLogger } from '../src/log.js';
import { tryLock } from '../src/lock.js';
import { streamDirName, type StreamKey } from '../src/routing.js';
import { ulid } from '../src/ulid.js';
import { runWorker } from '../src/worker.js';
import { ccValue, cleanupHomes, fakeAdapter, okResponder, startServer, tmpHome, writeTestConfig } from './helpers.js';

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

  it('queues the plain key in the server’s stream and hashes it with the deployment salt only at send time', async () => {
    const salt = 'deployment-salt-0123456789';
    const srv = await startServer((req) =>
      req.url === '/api/v1/collector-config'
        ? { status: 200, body: ccValue({ naming: 'hashed', salt }) }
        : { status: 200, body: { accepted: 1, duplicates: 0, rejected: [] } },
    );
    closers.push(srv.close);
    const paths = tmpHome();
    const config = writeTestConfig(paths, srv.url);
    // a stale cache: the flush fetches the deployment's real (hashed, salted) config
    writeCache(paths, config.servers[0]!, { fetched_at: new Date(0).toISOString() });
    writeJob(paths.jobs, job('Stop'), 1000);
    const seen: unknown[][] = [];
    const resolveProject = async (...args: unknown[]) => (seen.push(args), 'github.com/acme/billing');
    const adapter = streamingAdapter();
    const r = await runWorker({ paths, adapters: [adapter], flush: false, resolveProject });
    expect(r.failed).toBe(0);
    expect(seen).toEqual([['/work/repo']]);
    const dir = join(paths.queueProjects, streamDirName('github.com/acme/billing', srv.url, ''));
    expect(JSON.parse(readFileSync(join(dir, 'stream.json'), 'utf8'))).toMatchObject({ key: 'github.com/acme/billing', endpoint: srv.url, team: '' });
    expect(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.ndjson'))!), 'utf8')).toContain('"key":"github.com/acme/billing"');

    const flushed = await runWorker({ paths, adapters: [adapter] });
    expect(flushed.flush).toMatchObject({ status: 'ok', sent: 1 });
    const ingest = srv.received.find((x) => x.url === '/api/v1/ingest')!;
    const [ev] = (ingest.json as { events: Array<{ project?: unknown }> }).events;
    expect(ev!.project).toEqual({ key: `sha256:${createHmac('sha256', salt).update('github.com/acme/billing').digest('hex')}` });
  });

  it('runs another flush when config.json changed during the flush (C17)', async () => {
    let posts = 0;
    const paths = tmpHome();
    const srv = await startServer((req) => {
      if (req.url === '/api/v1/ingest' && ++posts === 1) writeFileSync(paths.config, `${readFileSync(paths.config, 'utf8')}\n`);
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

  it('discards jobs while no server is registered (C6)', async () => {
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

/** Like the real adapters: enqueues a `turn` per hook and stages its digest with ctx.scheduleSummaries (ADR-0027). */
function summarizingAdapter(summarize: (turnIds: string[]) => Promise<Map<string, string>> | Map<string, string>, turns = 1) {
  const adapter = fakeAdapter({ summarize: async (d) => summarize(d.map((x) => x.turnId)) });
  const sessions = new Map<string, StreamHolder>();
  adapter.handleHook = async (event, ctx) => {
    adapter.calls.push(event);
    const sid = (event.payload as { session_id: string }).session_id;
    const holder = sessions.get(sid) ?? { pkCwd: event.cwd };
    sessions.set(sid, holder);
    const key = await ctx.streamFor(holder, Date.parse(event.receivedAt));
    const turnId = `${sid}-turn`;
    const t = Date.parse(event.receivedAt);
    ctx.queue.enqueue(
      [turnEvent({ harness: ctx.harness, sessionId: sid, turnId, startedAt: t - 1000, endedAt: t, model: 'claude-opus-5-5', effort: null, usage: [], phases: {}, outcome: { status: 'success', signals: [], provisional: true } })],
      key,
    );
    const ids = turns === 1 ? [turnId] : Array.from({ length: turns }, (_, i) => `${turnId}-${String(i).padStart(3, '0')}`);
    expect(ctx.scheduleSummaries(ids.map((id) => buildDigest({ turnId: id, prompt: 'p', toolNames: [], lastAssistantMessage: 'm' })), key)).toBe(true);
  };
  return adapter;
}

const resolveProject = async () => 'github.com/acme/billing';
const KEY: StreamKey = { kind: 'project', pk: 'github.com/acme/billing', endpoint: '', team: '' };
const sentTypes = (srv: { received: Array<{ url: string; json: unknown }> }) =>
  srv.received.filter((x) => x.url === '/api/v1/ingest').map((x) => (x.json as { events: Array<{ type: string }> }).events.map((e) => e.type));
const stagedOf = (paths: ReturnType<typeof tmpHome>) => listStagedDigests(paths.state, 'claude-code').map((f) => readFileSync(f, 'utf8'));

describe('runWorker: summary phase after the flush (ADR-0027)', () => {
  it('sends the turn first, then summarises outside the job and sends the summary in a second POST', async () => {
    const srv = await startServer(okResponder('plain'));
    closers.push(srv.close);
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    writeJob(paths.jobs, job('Stop'), 1000);
    let postsAtSummarize = -1;
    const adapter = summarizingAdapter((ids) => {
      postsAtSummarize = sentTypes(srv).length;
      return new Map(ids.map((id) => [id, 'Fixed the expiry check']));
    });
    const r = await runWorker({ paths, adapters: [adapter], resolveProject });
    expect(postsAtSummarize).toBe(1);
    expect(sentTypes(srv)).toEqual([['turn'], ['turn_summary']]);
    expect(r.summaries).toMatchObject({ summarized: 1, flush: { status: 'ok', sent: 1 } });
    expect(stagedOf(paths)).toEqual([]);
    expect(JSON.parse(readFileSync(pendingSummariesPath(paths.state, 'claude-code'), 'utf8'))).toEqual([]);
  });

  it('summarises without worker.lock; a job written meanwhile is processed and flushed in the same run', async () => {
    const srv = await startServer(okResponder('plain'));
    closers.push(srv.close);
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    writeJob(paths.jobs, job('Stop'), 1000);
    let lockFree = false;
    let wrote = false;
    const adapter = summarizingAdapter((ids) => {
      const release = tryLock(paths.workerLock);
      lockFree = release !== null;
      release?.();
      if (!wrote) {
        wrote = true;
        writeJob(paths.jobs, job('Stop', 's2'), 3000);
      }
      return new Map(ids.map((id) => [id, `S ${id}`]));
    });
    const r = await runWorker({ paths, adapters: [adapter], resolveProject });
    expect(lockFree).toBe(true);
    expect(adapter.calls.map((c) => (c.payload as { session_id: string }).session_id)).toEqual(['s1', 's2']);
    expect(r.jobs).toBe(2);
    expect(readdirSync(paths.jobs)).toEqual([]);
    expect(sentTypes(srv).flat().sort()).toEqual(['turn', 'turn', 'turn_summary', 'turn_summary']);
    expect(r.summaries?.summarized).toBe(2);
  });

  it('worker.lock held across the commit: nothing changes; the next run sends the summary', async () => {
    const srv = await startServer(okResponder('plain'));
    closers.push(srv.close);
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    writeJob(paths.jobs, job('Stop'), 1000);
    let hold: (() => void) | null = null;
    let staged: string[] = [];
    const adapter = summarizingAdapter((ids) => {
      staged = stagedOf(paths);
      hold ??= tryLock(paths.workerLock); // another worker / `ai-obs flush` takes it now
      return new Map(ids.map((id) => [id, `S ${id}`]));
    });
    const r = await runWorker({ paths, adapters: [adapter], resolveProject, summaryCommitWaitMs: 400 });
    expect(hold).not.toBeNull();
    expect(r.summaries).toBeUndefined();
    expect(staged).toHaveLength(1);
    expect(stagedOf(paths)).toEqual(staged);
    expect(existsSync(pendingSummariesPath(paths.state, 'claude-code'))).toBe(false);
    expect(sentTypes(srv)).toEqual([['turn']]);

    hold!();
    const next = await runWorker({ paths, adapters: [adapter], resolveProject });
    expect(next.summaries?.summarized).toBe(1);
    expect(sentTypes(srv)).toEqual([['turn'], ['turn_summary']]);
    expect(stagedOf(paths)).toEqual([]);
  });

  it('a backlog slower than the timeout still commits: no chunk starts after it, the rest waits as pending', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    writeJob(paths.jobs, job('Stop'), 1000);
    let calls = 0;
    const adapter = summarizingAdapter(async (ids) => {
      calls++;
      await new Promise((r) => setTimeout(r, 300)); // one chunk outlasts the whole timeout
      return new Map(ids.map((id) => [id, `S ${id}`]));
    }, 51);
    const r = await runWorker({ paths, adapters: [adapter], flush: false, resolveProject, summaryTimeoutMs: 100 });
    expect(calls).toBe(1);
    expect(r.summaries?.summarized).toBe(25);
    expect(stagedOf(paths)).toEqual([]);
    const pending = JSON.parse(readFileSync(pendingSummariesPath(paths.state, 'claude-code'), 'utf8')) as Array<{ attempts: number }>;
    expect(pending).toHaveLength(26);
    expect(pending.every((p) => p.attempts === 0)).toBe(true);
  });

  it('a job written during a commit is processed in the same run even when a later batch makes no progress', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    writeJob(paths.jobs, job('Stop'), 1000);
    let wrote = false;
    const cc = summarizingAdapter((ids) => {
      if (!wrote) {
        wrote = true;
        writeJob(paths.jobs, job('Stop', 's2'), 3000); // its worker found worker.lock taken by our commit and left
      }
      return new Map(ids.map((id) => [id, `S ${id}`]));
    });
    let hold: (() => void) | null = null;
    const codex = fakeAdapter({
      name: 'codex',
      summarize: async (d) => {
        hold ??= tryLock(paths.workerLock); // another worker takes it: this commit is refused
        return new Map(d.map((x) => [x.turnId, 'x']));
      },
    });
    stageDigests(paths.state, 'codex', [buildDigest({ turnId: 'cx-1', prompt: 'p', toolNames: [], lastAssistantMessage: 'm' })], KEY, Date.now(), nullLogger);
    const log = {
      info() {},
      warn(msg: string) {
        if (msg.includes('worker busy')) hold?.(); // that worker is done by the time we look again
      },
      error() {},
    };
    const r = await runWorker({ paths, adapters: [cc, codex], flush: false, resolveProject, log, summaryCommitWaitMs: 200 });
    expect(hold).not.toBeNull();
    expect(cc.calls.map((c) => (c.payload as { session_id: string }).session_id)).toEqual(['s1', 's2']);
    expect(r.jobs).toBe(2);
    expect(readdirSync(paths.jobs)).toEqual([]);
    expect(listStagedDigests(paths.state, 'codex')).toHaveLength(1);
  });

  it('summaries.lock held by another process: the staged digests wait for it', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    writeJob(paths.jobs, job('Stop'), 1000);
    let calls = 0;
    const adapter = summarizingAdapter((ids) => {
      calls++;
      return new Map(ids.map((id) => [id, `S ${id}`]));
    });
    const release = tryLock(paths.summariesLock)!;
    const r = await runWorker({ paths, adapters: [adapter], flush: false, resolveProject });
    expect(calls).toBe(0);
    expect(r.summaries).toBeUndefined();
    expect(stagedOf(paths)).toHaveLength(1);
    release();
    const next = await runWorker({ paths, adapters: [adapter], flush: false, resolveProject });
    expect(calls).toBe(1);
    expect(next.summaries?.summarized).toBe(1);
    expect(stagedOf(paths)).toEqual([]);
  });

  it('summaries: false skips the phase', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    writeJob(paths.jobs, job('Stop'), 1000);
    let calls = 0;
    const adapter = summarizingAdapter(() => {
      calls++;
      return new Map();
    });
    const r = await runWorker({ paths, adapters: [adapter], flush: false, summaries: false, resolveProject });
    expect(r.jobs).toBe(1);
    expect(calls).toBe(0);
    expect(stagedOf(paths)).toHaveLength(1);
  });
});
