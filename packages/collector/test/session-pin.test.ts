import { mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { newSessionState as newCodexState } from '../src/adapters/codex/session.js';
import type { CollectorContext, HarnessAdapter, HookInvocation } from '../src/adapters/types.js';
import { runSummaryBatch } from '../src/analysis/summaries.js';
import { loadConfig, saveConfig, type CollectorConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import type { DotFileValue } from '../src/dotfile.js';
import { nullLogger } from '../src/log.js';
import type { AiObsPaths } from '../src/paths.js';
import type { IngestEvent } from '../src/protocol-types.js';
import type { QueueStore } from '../src/queue.js';
import type { StreamKey } from '../src/routing.js';
import { FAKE_SUMMARIZER } from './claude-code/helpers.js';
import { at, CWD, SESSION, threeTurnSession, writeSession } from './claude-code/fixture.js';
import { codexTestEnv, copyFixtures, SESSION as CODEX_SESSION } from './codex/codex-helpers.js';
import { cleanupHomes, tmpHome, writeTestServers } from './helpers.js';
import { queueStore } from './queue-helpers.js';

afterEach(cleanupHomes);

const A = 'https://obs.acme.io';
const B = 'https://obs.globex.io';
const KEYS: Record<string, string> = {
  [CWD]: 'github.com/acme/billing',
  '/work/other-repo': 'github.com/acme/other',
  '/work/first': 'github.com/acme/first',
  '/work/acme-app': 'github.com/acme/app',
};
const resolveProject = async (cwd: string) => KEYS[cwd] ?? cwd;

interface Recorded {
  events: IngestEvent[];
  key: StreamKey | null;
}

/** A context over a real QueueStore that records every enqueue call; dot files come from `dots` (cwd → value). */
function contextFor(adapter: HarnessAdapter, paths: AiObsPaths, config: CollectorConfig, now: () => Date, dots: Record<string, DotFileValue> = {}) {
  const store: QueueStore = queueStore(paths);
  const calls: Recorded[] = [];
  const ctx: CollectorContext = createContext({
    adapter,
    config,
    paths,
    queue: {
      enqueue: (events, key) => {
        calls.push({ events: [...events], key });
        store.enqueue(events, key);
      },
    },
    log: nullLogger,
    now,
    resolveProject,
    dotFile: (cwd) => dots[cwd] ?? {},
  });
  return { ctx, store, calls, dots };
}

function claudeHarness(servers: string[], dots: Record<string, DotFileValue> = {}) {
  const paths = tmpHome();
  const config = writeTestServers(paths, servers.map((endpoint) => ({ endpoint })));
  const claudeDir = mkdtempSync(join(tmpdir(), 'ai-obs-claude-'));
  const projectDir = join(claudeDir, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const adapter = createClaudeCodeAdapter({ probe: async () => '2.1.289', summaryArgv: FAKE_SUMMARIZER, claudeDir });
  const { ctx, store, calls } = contextFor(adapter, paths, config, () => new Date(), dots);
  const hook = (name: string, receivedAtMs: number, cwd = CWD, payload: Record<string, unknown> = {}, sessionId = SESSION) => {
    const inv: HookInvocation = {
      harness: 'claude-code',
      hook: name,
      payload: { session_id: sessionId, transcript_path: join(projectDir, `${SESSION}.jsonl`), cwd, hook_event_name: name, ...payload },
      cwd,
      env: {},
      receivedAt: new Date(receivedAtMs).toISOString(),
    };
    return adapter.handleHook(inv, ctx);
  };
  return { paths, config, adapter, ctx, store, calls, hook, projectDir, dots };
}

/** The worker's summary phase after its flush (ADR-0027): the staged digests' summaries go to their pinned stream. */
const summaries = (adapter: HarnessAdapter, ctx: CollectorContext) =>
  runSummaryBatch(adapter, ctx, {
    commit: async (gs) => {
      for (const g of gs) ctx.queue.enqueue(g.events, g.key);
      return true;
    },
  });

const pkOf = (k: StreamKey | null) => (k?.kind === 'project' ? k.pk : null);

const target = (k: StreamKey | null) => (k ? `${k.endpoint}|${k.team}` : null);

describe('session pinning (C12, C15)', () => {
  it('Claude Code: a session started in repo X keeps every event in X’s stream, even after cwd changes and in the sweep', async () => {
    const h = claudeHarness([A]);
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' });
    await h.hook('Stop', at(31.5), '/work/other-repo'); // the user cd'd elsewhere
    utimesSync(h.ctx.state.path(SESSION), new Date(Date.now() - 25 * 3600_000), new Date(Date.now() - 25 * 3600_000));
    await h.adapter.sweepCrashedSessions(h.ctx);
    await summaries(h.adapter, h.ctx);
    const types = h.calls.flatMap((c) => c.events.map((e) => e.type));
    expect(types).toEqual(expect.arrayContaining(['session_start', 'turn', 'turn_outcome', 'session_end', 'turn_summary']));
    expect(new Set(h.calls.map((c) => pkOf(c.key)))).toEqual(new Set(['github.com/acme/billing']));
    const streams = h.store.stats().streams;
    expect(streams).toHaveLength(1);
    expect(streams[0]!.stream).toMatchObject({ kind: 'project', pk: 'github.com/acme/billing', endpoint: A, team: '' });
  });

  it('the dot file in force at the first hook pins the server; a dot file changed mid-session never retargets it', async () => {
    const h = claudeHarness([A, B], { [CWD]: { server: A } });
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' });
    h.dots[CWD] = { server: B }; // `ai-obs link` while the session runs
    await h.hook('Stop', at(31.5));
    await h.hook('SessionStart', at(400), CWD, { source: 'startup' }, 'second-session');
    expect(h.calls.map((c) => target(c.key))).toEqual([`${A}|`, `${A}|`, `${B}|`]);
    const first = h.store.stats().streams.find((s) => s.stream.endpoint === A)!;
    const queued = h.store.stream(first.stream).readBatch()!.events;
    expect(queued.filter((e) => e.type === 'session_start')).toHaveLength(1);
    expect(queued.some((e) => e.type === 'turn')).toBe(true);
  });

  it('a session recorded while no server was chosen joins the link from its next event (C12)', async () => {
    const h = claudeHarness([A, B]);
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' }); // two servers, no dot file: no server
    expect(target(h.calls[0]!.key)).toBe('|');
    h.dots[CWD] = { server: B };
    await h.hook('Stop', at(31.5));
    expect(h.calls.slice(1).every((c) => target(c.key) === `${B}|`)).toBe(true);
    h.dots[CWD] = { server: A }; // a later change does not take those events away
    await h.hook('Stop', at(32));
    expect(h.calls.slice(1).every((c) => target(c.key) === `${B}|`)).toBe(true);
  });

  it('not logged in to any server: nothing is recorded', async () => {
    const h = claudeHarness([]);
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' });
    await h.hook('Stop', at(31.5));
    expect(h.calls.every((c) => c.key === null)).toBe(true);
    expect(h.store.stats().events).toBe(0);
  });

  it('a session pinned by 0.4 (`bind`) keeps its server after the upgrade', async () => {
    const h = claudeHarness([A, B], { [CWD]: { server: B } });
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' });
    const st = h.ctx.state.get<{ stream?: unknown }>(SESSION)!;
    h.ctx.state.set(SESSION, { ...st, stream: { kind: 'project', pk: 'github.com/acme/billing', bind: { kind: 'token', id: { endpoint: A, company_slug: 'acme', token_fp: 'f' }, name: 'acme' } } });
    await h.hook('Stop', at(31.5));
    expect(target(h.calls.at(-1)!.key)).toBe(`${A}|`);
    expect(h.ctx.state.get<{ stream?: StreamKey }>(SESSION)!.stream).toEqual({ kind: 'project', pk: 'github.com/acme/billing', endpoint: A, team: '' });
  });

  it('Codex: the stream is the dot file at the session’s first hook, even when that hook enqueued nothing (C18)', async () => {
    const env = codexTestEnv();
    const paths = env.ctx.paths;
    const t0 = Date.now();
    const c = loadConfig(paths)!;
    const { ctx, calls, dots } = contextFor(env.adapter, paths, c, () => new Date(t0 + 5000), { '/work/first': {} });
    const hook = (name: string, receivedAt: number) =>
      env.adapter.handleHook(
        { harness: 'codex', hook: name, payload: { session_id: CODEX_SESSION, transcript_path: env.mainPath, cwd: '/work/first' }, cwd: '/work/first', env: {}, receivedAt: new Date(receivedAt).toISOString() },
        ctx,
      );
    await hook('SessionStart', t0 - 60_000); // the rollout is not written yet: nothing enqueued, but the stream is pinned
    expect(calls).toEqual([]);
    saveConfig(paths, { ...c, servers: [...c.servers, { ...c.servers[0]!, endpoint: B, token: 'aiobs_u_b' }] }); // a second login
    dots['/work/first'] = { server: B };
    copyFixtures(env);
    await hook('SessionEnd', t0 + 2000);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((x) => target(x.key)))).toEqual(new Set([`${c.servers[0]!.endpoint}|`]));
  });

  it('Codex: a session whose first hook precedes session_meta stays in one stream', async () => {
    const env = codexTestEnv();
    const { ctx, calls } = contextFor(env.adapter, env.ctx.paths, env.ctx.config, () => new Date('2026-10-05T10:20:00Z'));
    const hook = (name: string, cwd: string, receivedAt: string) =>
      env.adapter.handleHook(
        { harness: 'codex', hook: name, payload: { session_id: CODEX_SESSION, transcript_path: env.mainPath, cwd }, cwd, env: {}, receivedAt },
        ctx,
      );
    await hook('SessionStart', '/work/first', '2026-10-05T09:59:57Z'); // no rollout yet
    copyFixtures(env);
    await hook('SessionEnd', '/work/acme-app', '2026-10-05T10:15:00Z');
    await summaries(env.adapter, ctx);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.flatMap((c) => c.events.map((e) => e.type))).toEqual(expect.arrayContaining(['session_start', 'turn', 'session_end', 'turn_summary']));
    expect(new Set(calls.map((c) => pkOf(c.key)))).toEqual(new Set(['github.com/acme/first']));
  });

  it('Codex: a 0.1.x session state without a cwd has its remaining events dropped', async () => {
    const env = codexTestEnv();
    const now = new Date('2026-10-05T10:20:00Z');
    const { ctx, calls, store } = contextFor(env.adapter, env.ctx.paths, env.ctx.config, () => now);
    const old = now.getTime() - 3 * 3600_000;
    ctx.state.set('019f0000-0000-7000-8000-0000000000ff', { ...newCodexState('019f0000-0000-7000-8000-0000000000ff', old), startedSent: true });
    await env.adapter.sweepCrashedSessions(ctx);
    expect(calls.map((c) => [c.events.map((e) => e.type), c.key])).toEqual([[['session_end'], null]]);
    expect(store.stats().events).toBe(0);
  });
});
