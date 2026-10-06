import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../../fsutil.js';
import type { IngestEvent } from '../../protocol-types.js';
import type { CollectorContext, HarnessAdapter, HookInvocation } from '../types.js';
import { detectCodex } from './detect.js';
import { hooksFilePath, codexHome, locateRollout, mtimeMs } from './locate.js';
import { aiObsCommands, mergeAiObsHooks, readHooksFile, removeAiObsHooks, writeHooksFile } from './hooks-config.js';
import { parseRolloutLine, type RolloutItem } from './records.js';
import { readFirstLine, readNewLines } from './rollout.js';
import {
  applyItems,
  closeOpenTurn,
  endSession,
  finalizePrev,
  newSessionState,
  refreshEmittedTurn,
  type CodexSessionState,
  type SessionEnv,
} from './session.js';
import { resolveChildren } from './subagents.js';
import { summarizeWithCodex } from './summarize.js';

/** A session whose rollout has not changed for this long is ended by the sweep (reason `crashed`). */
export const IDLE_END_MS = 60 * 60_000;
/** Ended / sub-agent session state is kept this long for late hooks, then deleted. */
const KEEP_ENDED_MS = 7 * 24 * 3600_000;
/** Summarize mid-session once this many turns are waiting (long sessions). */
const SUMMARY_BATCH = 10;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** `SessionStart` / `session_start` / `sessionstart` → `sessionstart` */
const hookKey = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CodexAdapterDeps {
  /** Codex home override (tests); default $CODEX_HOME from the hook env, else ~/.codex */
  home?: string;
  version?: () => Promise<string | null>;
  /** how long Stop waits for task_complete to reach the rollout (default 1500 ms) */
  stopWaitMs?: number;
  /** codex binary for summaries (tests) */
  codexBin?: string;
}

export function createCodexAdapter(deps: CodexAdapterDeps = {}): HarnessAdapter {
  const homeOf = (env?: Record<string, string>) => deps.home ?? codexHome(env ?? process.env);

  function makeEnv(ctx: CollectorContext, home: string, out: IngestEvent[]): SessionEnv {
    return {
      harness: ctx.harness,
      emit: (events) => out.push(...events),
      project: async (cwd) => {
        try {
          return await ctx.projectKey(cwd);
        } catch {
          return undefined;
        }
      },
      children: (rootTurnId, ids) => resolveChildren({ harness: ctx.harness, home, rootTurnId, ids }),
    };
  }

  /** Reads new rollout lines from the cursor and feeds them in. */
  async function sync(state: CodexSessionState, env: SessionEnv, home: string, hint: string | null, ctx: CollectorContext): Promise<void> {
    if (!state.rolloutPath || !mtimeMs(state.rolloutPath)) state.rolloutPath = locateRollout(state.sessionId, { home, hint });
    if (!state.rolloutPath) {
      ctx.log.warn('codex: rollout not found', { session: state.sessionId });
      return;
    }
    const r = readNewLines(state.rolloutPath, state.offset);
    if (r.reset) {
      // rewritten under us (e.g. `codex migrate-rollouts`): skip, re-processing would double count
      ctx.log.warn('codex: rollout shrank; skipping to its end', { session: state.sessionId });
      state.offset = r.offset;
      return;
    }
    const items = r.lines.map(parseRolloutLine).filter((i): i is RolloutItem => i !== null);
    await applyItems(state, env, items);
    state.offset = r.offset;
  }

  function save(ctx: CollectorContext, state: CodexSessionState, out: IngestEvent[]): void {
    if (out.length) ctx.queue.enqueue(out.splice(0));
    ctx.state.set(state.sessionId, state);
  }

  async function summarizeDigests(ctx: CollectorContext, state: CodexSessionState): Promise<void> {
    if (!state.digests.length) return;
    const digests = state.digests;
    state.digests = [];
    ctx.state.set(state.sessionId, state);
    await ctx.summarizeTurns(digests);
  }

  async function onSubagentStop(p: Obj, ctx: CollectorContext, home: string, receivedAt: number): Promise<void> {
    const agentId = str(p.agent_id)?.toLowerCase();
    if (!agentId) return;
    const hint = str(p.agent_transcript_path);
    // The main thread: the payload's session, else walk up session_meta parent links.
    const lineage: string[] = [agentId];
    let state: CodexSessionState | null = null;
    let cursor: string | null = str(p.session_id);
    let probe: string | null = agentId;
    for (let i = 0; i < 6 && !state; i++) {
      const candidate = cursor ? ctx.state.get<CodexSessionState>(cursor) : null;
      if (candidate && !candidate.subagent && candidate.v === 1) {
        state = candidate;
        break;
      }
      const path: string | null = probe ? locateRollout(probe, { home, hint: probe === agentId ? hint : null }) : null;
      const first: string | null = path ? readFirstLine(path) : null;
      const item: RolloutItem | null = first ? parseRolloutLine(first) : null;
      const parent: string | null = item?.kind === 'meta' ? item.meta.parentThreadId : null;
      if (!parent || lineage.includes(parent)) break;
      lineage.push(parent);
      cursor = parent;
      probe = parent;
    }
    if (!state) {
      ctx.log.warn('codex: sub-agent stop for an unknown session', { agent: agentId });
      return;
    }
    if (lineage.length > 1 && lineage.at(-1) === state.sessionId) lineage.pop();
    const out: IngestEvent[] = [];
    const env = makeEnv(ctx, home, out);
    await sync(state, env, home, null, ctx);
    const turnId = str(p.turn_id);
    const direct = lineage[lineage.length - 1]!; // the thread the main agent spawned
    const owns = (spawned: readonly string[], children: Record<string, unknown>) => lineage.some((id) => spawned.includes(id) || id in children);
    const owner = state.emitted.find((t) => owns(t.spawned, t.children));
    if (owner) refreshEmittedTurn(state, env, owner.input.turnId, owns(owner.spawned, {}) ? [] : [direct]);
    else if (state.open) {
      if (!owns(state.open.spawned, {})) state.open.spawned.push(direct);
    } else {
      const t = (turnId ? state.emitted.find((e) => e.input.turnId === turnId) : undefined) ?? state.emitted.at(-1);
      if (t) refreshEmittedTurn(state, env, t.input.turnId, [direct]);
    }
    state.lastActivityAt = Math.max(state.lastActivityAt, receivedAt);
    save(ctx, state, out);
  }

  /** Ends idle sessions (no SessionEnd: crash, kill, old Codex) and drops stale state. */
  async function sweep(ctx: CollectorContext): Promise<void> {
    const now = ctx.now().getTime();
    for (const { sessionId, updatedAt } of ctx.state.list()) {
      const state = ctx.state.get<CodexSessionState>(sessionId);
      if (!state || state.v !== 1) continue;
      if (state.subagent || state.ended) {
        if (now - updatedAt > KEEP_ENDED_MS) ctx.state.delete(sessionId);
        continue;
      }
      const lastSeen = Math.max(state.lastActivityAt, mtimeMs(state.rolloutPath));
      if (now - lastSeen < IDLE_END_MS) continue;
      const out: IngestEvent[] = [];
      const home = homeOf();
      const env = makeEnv(ctx, home, out);
      await sync(state, env, home, null, ctx);
      endSession(state, env, 'crashed', state.lastActivityAt);
      save(ctx, state, out);
      await summarizeDigests(ctx, state);
    }
    writeJsonAtomic(sweepMarker(ctx), { at: now });
  }

  const sweepMarker = (ctx: CollectorContext) => join(ctx.paths.state, 'codex-sweep.json');

  const adapter: HarnessAdapter = {
    name: 'codex',
    displayName: 'Codex',
    sessionStartHooks: ['SessionStart', 'session_start'],

    nextSteps: ['Next step: open Codex once and run /hooks to review and trust the new ai-obs hooks. Codex does not run untrusted hooks, so nothing is recorded until you do.'],

    async installedHookCommands(d = {}) {
      const paths = [hooksFilePath('user', { home: homeOf() }), ...(d.projectDir ? [hooksFilePath('project', { projectDir: d.projectDir, home: homeOf() })] : [])];
      return paths.flatMap((p) => {
        try {
          return aiObsCommands(readHooksFile(p));
        } catch {
          return [];
        }
      });
    },

    detect: (opts) => detectCodex(opts ?? {}, { ...(deps.home ? { home: deps.home } : {}), ...(deps.version ? { version: deps.version } : {}) }),

    async installHooks(opts) {
      const path = hooksFilePath(opts.scope, { ...(opts.projectDir ? { projectDir: opts.projectDir } : {}), home: homeOf() });
      const before = readHooksFile(path);
      const after = mergeAiObsHooks(before, (event) => opts.hookCommand(event).shell);
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      mkdirSync(dirname(path), { recursive: true });
      writeHooksFile(path, after);
    },

    async uninstallHooks(opts) {
      const path = hooksFilePath(opts.scope, { ...(opts.projectDir ? { projectDir: opts.projectDir } : {}), home: homeOf() });
      if (!mtimeMs(path)) return;
      const { file, removed } = removeAiObsHooks(readHooksFile(path));
      if (removed) writeHooksFile(path, file);
    },

    async handleHook(event: HookInvocation, ctx: CollectorContext) {
      const p = obj(event.payload);
      const hook = hookKey(event.hook);
      const home = homeOf(event.env);
      const receivedAt = Date.parse(event.receivedAt) || ctx.now().getTime();
      if (hook === 'subagentstop') return onSubagentStop(p, ctx, home, receivedAt);
      const sessionId = str(p.session_id);
      if (!sessionId) {
        ctx.log.warn('codex: hook payload without session_id', { hook: event.hook });
        return;
      }
      if (str(p.agent_id) && hook !== 'sessionstart') return; // a sub-agent's own hook; its usage arrives via the parent
      const state = ctx.state.get<CodexSessionState>(sessionId) ?? newSessionState(sessionId, receivedAt);
      if (state.subagent) return;
      const out: IngestEvent[] = [];
      const env = makeEnv(ctx, home, out);
      const hint = str(p.transcript_path);
      await sync(state, env, home, hint, ctx);

      if (hook === 'userpromptsubmit') {
        const prompt = str(p.prompt);
        if (prompt && state.open?.turnId !== str(p.turn_id)) finalizePrev(state, env, { prompt }, receivedAt);
      } else if (hook === 'stop') {
        const turnId = str(p.turn_id);
        const isOpen = () => state.open && (!turnId || state.open.turnId === turnId);
        // Stop fires before Codex records task_complete; give the rollout a moment, then close anyway.
        for (let waited = 0; isOpen() && waited < (deps.stopWaitMs ?? 1500); waited += 250) {
          await sleep(250);
          await sync(state, env, home, hint, ctx);
        }
        if (isOpen()) {
          const last = str(p.last_assistant_message);
          if (last) state.open!.lastMessage = last;
          state.open!.timeline.push({ at: Math.max(receivedAt, state.open!.lastAt), type: 'output' });
          closeOpenTurn(state, env, Math.max(receivedAt, state.open!.lastAt));
        }
      } else if (hook === 'sessionend') {
        const reason = str(p.reason);
        endSession(state, env, reason && reason !== 'other' ? reason : 'exit', receivedAt);
      }
      state.lastActivityAt = Math.max(state.lastActivityAt, receivedAt);
      save(ctx, state, out);

      if (state.ended || state.digests.length >= SUMMARY_BATCH) await summarizeDigests(ctx, state);
      if (!adapter.sessionStartHooks.includes(event.hook)) {
        const last = readJsonFile<{ at?: number }>(sweepMarker(ctx))?.at ?? 0;
        if (ctx.now().getTime() - last > IDLE_END_MS) await sweep(ctx);
      }
    },

    sweepCrashedSessions: sweep,

    summarize(digests, ctx) {
      return summarizeWithCodex(digests, { codexHome: homeOf(), cwd: ctx.paths.root, ...(deps.codexBin ? { bin: deps.codexBin } : {}) });
    },
  };
  return adapter;
}

export const adapter: HarnessAdapter = createCodexAdapter();
