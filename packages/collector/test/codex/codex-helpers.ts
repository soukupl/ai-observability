import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCodexAdapter, type CodexAdapterDeps } from '../../src/adapters/codex/index.js';
import type { CollectorContext, HarnessAdapter, HookInvocation } from '../../src/adapters/types.js';
import { createContext } from '../../src/context.js';
import { nullLogger } from '../../src/log.js';
import type { IngestEvent } from '../../src/protocol-types.js';
import { tmpHome, writeTestConfig } from '../helpers.js';

export const FIXTURES = new URL('./fixtures/', import.meta.url);
export const SESSION = '019f0000-0000-7000-8000-000000000001';
export const CHILD = '019f0000-0000-7000-8000-0000000000c1';
export const T1 = '019f0000-0000-7000-8000-0000000000a1';
export const T2 = '019f0000-0000-7000-8000-0000000000a2';
export const T3 = '019f0000-0000-7000-8000-0000000000a3';

export const fixtureLines = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8').split('\n').filter(Boolean);

export interface CodexTestEnv {
  codexHome: string;
  mainPath: string;
  childPath: string;
  adapter: HarnessAdapter;
  ctx: CollectorContext;
  events: IngestEvent[];
  /** runs one hook through the adapter like the worker does (incl. the sweep after SessionStart) */
  hook(name: string, payload: Record<string, unknown>, receivedAt?: string): Promise<void>;
  writeMain(lines: readonly string[]): void;
  writeChild(lines: readonly string[]): void;
}

/** Temp ai-obs home + temp CODEX_HOME with the rollouts at their real-looking paths. */
export function codexTestEnv(opts: { now?: string; deps?: CodexAdapterDeps } = {}): CodexTestEnv {
  const paths = tmpHome();
  const config = writeTestConfig(paths);
  const codexHome = join(paths.root, '..', 'codex-home');
  const day = join(codexHome, 'sessions', '2026', '10', '05');
  mkdirSync(day, { recursive: true });
  const mainPath = join(day, `rollout-2026-10-05T09-59-58-${SESSION}.jsonl`);
  const childPath = join(day, `rollout-2026-10-05T10-00-09-${CHILD}.jsonl`);
  // fake `codex` for summaries: answers every turn id with a fixed summary
  const bin = join(codexHome, 'fake-codex.sh');
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\necho 'Done. {"t1": "Added a retry helper via ~/work/acme-app/src/retry.ts", "t2": "Ran the test suite", "t3": "Re-ran tests"}'\n`);
  chmodSync(bin, 0o755);
  const adapter = createCodexAdapter({ home: codexHome, stopWaitMs: 0, codexBin: bin, version: async () => '0.154.0', ...opts.deps });
  const events: IngestEvent[] = [];
  const now = new Date(opts.now ?? '2026-10-05T10:20:00Z');
  const ctx = createContext({
    adapter,
    config,
    paths,
    queue: { enqueue: (e) => void events.push(...e) },
    log: nullLogger,
    projectNaming: 'plain',
    now: () => now,
    resolveProject: async () => ({ key: 'github.com/acme/app', name: 'app' }),
  });
  return {
    codexHome,
    mainPath,
    childPath,
    adapter,
    ctx,
    events,
    async hook(name, payload, receivedAt = now.toISOString()) {
      const inv: HookInvocation = { harness: 'codex', hook: name, payload: { session_id: SESSION, transcript_path: mainPath, cwd: '/work/acme-app', ...payload }, cwd: '/work/acme-app', env: {}, receivedAt };
      await adapter.handleHook(inv, ctx);
      if (adapter.sessionStartHooks.includes(name)) await adapter.sweepCrashedSessions(ctx);
    },
    writeMain: (lines) => writeFileSync(mainPath, lines.map((l) => `${l}\n`).join('')),
    writeChild: (lines) => writeFileSync(childPath, lines.map((l) => `${l}\n`).join('')),
  };
}

export function copyFixtures(env: CodexTestEnv): void {
  copyFileSync(new URL('main-rollout.jsonl', FIXTURES), env.mainPath);
  copyFileSync(new URL('child-rollout.jsonl', FIXTURES), env.childPath);
}

export const ofType = <T extends IngestEvent['type']>(events: readonly IngestEvent[], type: T) =>
  events.filter((e): e is Extract<IngestEvent, { type: T }> => e.type === type);
