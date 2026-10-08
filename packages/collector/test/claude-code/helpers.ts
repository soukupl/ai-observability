import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBatch } from '@ai-obs/protocol';
import { createClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from '../../src/adapters/claude-code/index.js';
import type { CollectorContext, HarnessAdapter, HookInvocation } from '../../src/adapters/types.js';
import { createContext } from '../../src/context.js';
import { createLogger } from '../../src/log.js';
import type { IngestEvent } from '../../src/protocol-types.js';
import type { StreamKey } from '../../src/queue.js';
import { buildEnvelope } from '../../src/sender.js';
import { tmpHome, writeTestConfig } from '../helpers.js';
import { CWD, SESSION } from './fixture.js';

/** never the real `claude` in tests */
export const FAKE_SUMMARIZER = [process.execPath, fileURLToPath(new URL('./fake-claude-summarizer.mjs', import.meta.url))];

export interface Harness {
  adapter: HarnessAdapter;
  ctx: CollectorContext;
  events: IngestEvent[];
  /** the stream key of every enqueue call, in order */
  keys: Array<StreamKey | null>;
  claudeDir: string;
  projectDir: string;
  /** fires a hook with `receivedAt` = fixture time */
  hook(name: string, receivedAtMs: number, payload?: Record<string, unknown>): Promise<void>;
}

export function setup(opts: ClaudeCodeAdapterOptions & { now?: () => Date } = {}): Harness {
  const paths = tmpHome();
  const config = writeTestConfig(paths);
  const claudeDir = opts.claudeDir ?? mkdtempSync(join(tmpdir(), 'ai-obs-claude-'));
  const projectDir = join(claudeDir, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const adapter = createClaudeCodeAdapter({ probe: async () => '2.1.289', summaryArgv: FAKE_SUMMARIZER, ...opts, claudeDir });
  const events: IngestEvent[] = [];
  const keys: Array<StreamKey | null> = [];
  const ctx = createContext({
    adapter,
    config,
    paths,
    queue: {
      enqueue: (e, key) => {
        events.push(...e);
        keys.push(key);
      },
    },
    log: createLogger(paths, 'test'),
    now: opts.now ?? (() => new Date('2026-10-01T12:00:00Z')),
    resolveProject: async () => 'github.com/acme/billing',
  });
  const transcript = join(projectDir, `${SESSION}.jsonl`);
  return {
    adapter,
    ctx,
    events,
    keys,
    claudeDir,
    projectDir,
    async hook(name, receivedAtMs, payload = {}) {
      const inv: HookInvocation = {
        harness: 'claude-code',
        hook: name,
        payload: { session_id: SESSION, transcript_path: transcript, cwd: CWD, hook_event_name: name, ...payload },
        cwd: CWD,
        env: {},
        receivedAt: new Date(receivedAtMs).toISOString(),
      };
      await adapter.handleHook(inv, ctx);
    },
  };
}

/** Throws unless every event passes the server's validateBatch. */
export function assertValid(events: IngestEvent[]): void {
  const config = writeTestConfig(tmpHome());
  const r = validateBatch(JSON.parse(JSON.stringify(buildEnvelope(config, events))));
  if (!r.ok) throw new Error(r.error);
  if (r.rejected.length) throw new Error(JSON.stringify(r.rejected));
}

export const byType = <T extends IngestEvent['type']>(events: IngestEvent[], type: T) =>
  events.filter((e): e is Extract<IngestEvent, { type: T }> => e.type === type);
