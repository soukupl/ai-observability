import { mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { newSessionState as newCodexState } from '../src/adapters/codex/session.js';
import type { CollectorContext, HarnessAdapter, HookInvocation } from '../src/adapters/types.js';
import { identityOf, loadConfig, saveConfig, type CollectorConfig, type TokenEntry } from '../src/config.js';
import { createContext } from '../src/context.js';
import { nullLogger } from '../src/log.js';
import type { AiObsPaths } from '../src/paths.js';
import { loadRouting, resolveStream } from '../src/projects.js';
import type { IngestEvent } from '../src/protocol-types.js';
import { identityOfRef, type QueueStore, type StreamKey } from '../src/queue.js';
import { FAKE_SUMMARIZER } from './claude-code/helpers.js';
import { at, CWD, SESSION, threeTurnSession, writeSession } from './claude-code/fixture.js';
import { codexTestEnv, copyFixtures, SESSION as CODEX_SESSION } from './codex/codex-helpers.js';
import { cleanupHomes, tmpHome, writeProjects, writeTestTokens } from './helpers.js';
import { queueStore } from './queue-helpers.js';

afterEach(cleanupHomes);

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

/** A context over a real QueueStore that also records every enqueue call. */
function contextFor(adapter: HarnessAdapter, paths: AiObsPaths, config: CollectorConfig, now: () => Date) {
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
  });
  return { ctx, store, calls };
}

function assign(paths: AiObsPaths, pk: string, t: TokenEntry) {
  writeProjects(paths, { [pk]: { token: t.name, ...identityOf(t), assigned_at: new Date().toISOString() } });
}

function claudeHarness(specs: Parameters<typeof writeTestTokens>[1]) {
  const paths = tmpHome();
  const config = writeTestTokens(paths, specs);
  const claudeDir = mkdtempSync(join(tmpdir(), 'ai-obs-claude-'));
  const projectDir = join(claudeDir, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const adapter = createClaudeCodeAdapter({ probe: async () => '2.1.289', summaryArgv: FAKE_SUMMARIZER, claudeDir });
  const { ctx, store, calls } = contextFor(adapter, paths, config, () => new Date());
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
  return { paths, config, adapter, ctx, store, calls, hook, projectDir };
}

const pkOf = (k: StreamKey | null) => (k?.kind === 'project' ? k.pk : null);

describe('session pinning (C12, C15)', () => {
  it('Claude Code: a session started in repo X keeps every event in X’s stream, even after cwd changes and in the sweep', async () => {
    const h = claudeHarness([{ name: 'acme' }]);
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' });
    await h.hook('Stop', at(31.5), '/work/other-repo'); // the user cd'd elsewhere
    utimesSync(h.ctx.state.path(SESSION), new Date(Date.now() - 25 * 3600_000), new Date(Date.now() - 25 * 3600_000));
    await h.adapter.sweepCrashedSessions(h.ctx);

    const types = h.calls.flatMap((c) => c.events.map((e) => e.type));
    expect(types).toContain('session_start');
    expect(types).toContain('turn');
    expect(types).toContain('turn_outcome');
    expect(types).toContain('session_end');
    expect(types).toContain('turn_summary');
    expect(new Set(h.calls.map((c) => pkOf(c.key)))).toEqual(new Set(['github.com/acme/billing']));
    const streams = h.store.stats().streams;
    expect(streams).toHaveLength(1);
    expect(streams[0]!.stream).toMatchObject({ kind: 'project', pk: 'github.com/acme/billing', bind: { kind: 'token', name: 'acme' } });
  });

  it('a session bound to A keeps its binding after `use b`; a new session goes to B (no split)', async () => {
    const h = claudeHarness([{ name: 'acme' }, { name: 'globex' }]);
    const [acme, globex] = h.config.tokens as [TokenEntry, TokenEntry];
    assign(h.paths, 'github.com/acme/billing', acme);
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' });
    assign(h.paths, 'github.com/acme/billing', globex); // `ai-obs use globex`
    await h.hook('Stop', at(31.5));
    await h.hook('SessionStart', at(400), CWD, { source: 'startup' }, 'second-session');

    const names = h.calls.map((c) => (c.key?.bind.kind === 'token' ? c.key.bind.name : 'open'));
    expect(names).toEqual(['acme', 'acme', 'globex']);
    const acmeStream = h.store.stats().streams.find((s) => s.stream.bind?.kind === 'token' && s.stream.bind.name === 'acme')!;
    const q = h.store.stream(acmeStream.stream);
    const queued = q.readBatch()!.events;
    expect(queued.filter((e) => e.type === 'session_start')).toHaveLength(1);
    expect(queued.some((e) => e.type === 'turn')).toBe(true);
  });

  it('a session pinned open is released whole by `use b`', async () => {
    const h = claudeHarness([{ name: 'acme' }, { name: 'globex' }]);
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' });
    await h.hook('Stop', at(31.5));
    const [ref] = h.store.streams();
    expect(ref).toMatchObject({ pk: 'github.com/acme/billing', bind: { kind: 'open' } });
    expect(resolveStream(loadRouting(h.paths)!, identityOfRef(ref!))).toMatchObject({ kind: 'held', reason: 'unassigned' });
    assign(h.paths, 'github.com/acme/billing', h.config.tokens[1]!);
    expect(resolveStream(loadRouting(h.paths)!, identityOfRef(ref!))).toMatchObject({ kind: 'token', token: { name: 'globex' }, via: 'explicit' });
    expect(h.store.streams()).toHaveLength(1);
  });

  it('an open session joins `use a` from its next event: `use b` later does not take those events to B (C12)', async () => {
    const h = claudeHarness([{ name: 'acme' }, { name: 'globex' }]);
    const [acme, globex] = h.config.tokens as [TokenEntry, TokenEntry];
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' }); // no choice yet: open
    assign(h.paths, 'github.com/acme/billing', acme); // `ai-obs use acme` (acme cannot send right now)
    await h.hook('Stop', at(31.5));
    assign(h.paths, 'github.com/acme/billing', globex); // `ai-obs use globex`
    await h.hook('Stop', at(32));

    const names = h.calls.map((c) => (c.key?.bind.kind === 'token' ? c.key.bind.name : 'open'));
    expect(names[0]).toBe('open');
    expect(names.slice(1).every((n) => n === 'acme')).toBe(true);
    const view = loadRouting(h.paths)!;
    const routes = h.store.streams().map((ref) => [ref.bind?.kind, (resolveStream(view, identityOfRef(ref)) as { token?: TokenEntry }).token?.name]);
    // recorded with no choice → follows the choice (globex); recorded after `use acme` → stays with acme
    expect(routes.sort()).toEqual([
      ['open', 'globex'],
      ['token', 'acme'],
    ]);
  });

  it('Codex: the binding is the routing at the session’s first hook, even when that hook enqueued nothing (C18)', async () => {
    const env = codexTestEnv();
    const paths = env.ctx.paths;
    const t0 = Date.now();
    const { ctx, calls } = contextFor(env.adapter, paths, env.ctx.config, () => new Date(t0 + 5000));
    const hook = (name: string, receivedAt: number) =>
      env.adapter.handleHook(
        { harness: 'codex', hook: name, payload: { session_id: CODEX_SESSION, transcript_path: env.mainPath, cwd: '/work/first' }, cwd: '/work/first', env: {}, receivedAt: new Date(receivedAt).toISOString() },
        ctx,
      );
    await hook('SessionStart', t0 - 60_000); // one token; the rollout is not written yet: nothing enqueued
    expect(calls).toEqual([]);
    const c = loadConfig(paths)!;
    const globex: TokenEntry = { name: 'globex', company: { name: 'Globex', slug: 'globex' }, endpoint: 'http://127.0.0.1:9', token: 'aiobs_c_test-globex', added_at: new Date(t0).toISOString() };
    saveConfig(paths, { ...c, tokens: [...c.tokens, globex] }, new Date(t0 + 1000)); // `ai-obs token add`
    copyFixtures(env);
    await hook('SessionEnd', t0 + 2000);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((x) => (x.key?.bind.kind === 'token' ? x.key.bind.name : 'open')))).toEqual(new Set([c.tokens[0]!.name]));
  });

  it('`use --none`: a new session is not recorded at all', async () => {
    const h = claudeHarness([{ name: 'acme' }]);
    writeProjects(h.paths, { 'github.com/acme/billing': { token: null, none: true, assigned_at: new Date().toISOString() } });
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), CWD, { source: 'startup' });
    await h.hook('Stop', at(31.5));
    expect(h.calls.every((c) => c.key === null)).toBe(true);
    expect(h.store.stats().events).toBe(0);
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
