import type { TurnDigest } from '../analysis/digest.js';
import type { CollectorConfig } from '../config.js';
import type { Logger } from '../log.js';
import type { AiObsPaths } from '../paths.js';
import type { HarnessName, ProjectRef } from '../protocol-types.js';
import type { QueueStore, StreamKey } from '../queue.js';
import type { SessionStateStore } from '../state.js';

/**
 * THE ADAPTER CONTRACT. One adapter per harness (src/adapters/<name>/index.ts exports
 * `const adapter: HarnessAdapter`). The core owns install plumbing, the hook fast path, the detached
 * worker, queue, delivery and summaries; an adapter maps its harness's hooks + transcripts to events.
 */
export interface HarnessAdapter {
  readonly name: HarnessName;
  /** human name for CLI output, e.g. "Claude Code" */
  readonly displayName: string;
  /** hook names after which the worker calls sweepCrashedSessions() (e.g. ['SessionStart']) */
  readonly sessionStartHooks: readonly string[];
  /** lines `ai-obs init` prints after it installed this harness's hooks (steps only the user can do) */
  readonly nextSteps?: readonly string[];

  /** Is the harness installed, which version, is it supported, are our hooks in place? Never throws. */
  detect(opts?: DetectOptions): Promise<Detection>;
  /** Shell commands of our installed hooks (user scope, plus project scope with `projectDir`), for `doctor` to check their runtime. Never throws. */
  installedHookCommands?(opts?: DetectOptions): Promise<string[]>;
  /** Writes hook config so every hook runs `opts.hookCommand(hookName)`. Idempotent; must preserve unrelated user config. */
  installHooks(opts: InstallOptions): Promise<void>;
  /** Removes only our hook entries (recognize them with isAiObsHookCommand()). Idempotent. */
  uninstallHooks(opts: UninstallOptions): Promise<void>;
  /**
   * Runs in the detached worker (never in the harness's process), serialized across all hooks.
   * Reads transcripts from the stored cursor, enqueues events via ctx.queue, saves state.
   * May throw; the worker logs it and continues.
   */
  handleHook(event: HookInvocation, ctx: CollectorContext): Promise<void>;
  /** Finishes sessions that never got their end hook (crash / kill): flush open turns, emit session_end reason "crashed". */
  sweepCrashedSessions(ctx: CollectorContext): Promise<void>;
  /**
   * Summarizes turns with the harness's cheapest model (one batched headless call). Implement with
   * summarizeWithCommand() from analysis/summaries.ts. Returns turnId → summary (≤ 140 chars) for the
   * turns it could summarize. Do not call directly: use ctx.summarizeTurns(), which retries and enqueues.
   */
  summarize(digests: TurnDigest[], ctx: CollectorContext): Promise<Map<string, string>>;
}

export interface DetectOptions {
  /** also report project-scope hooks in this directory */
  projectDir?: string;
}

export interface Detection {
  installed: boolean;
  /** harness version, e.g. "2.1.3", when it could be determined */
  version: string | null;
  /** version within the adapter's tested range; null = unknown */
  versionSupported: boolean | null;
  hooksInstalled: { user: boolean; project: boolean | null };
  /** where the harness config lives, for doctor output (a local path; printed, never sent) */
  configPath?: string;
  /** extra doctor lines, e.g. "hooks feature flag disabled" */
  notes?: string[];
  /** doctor warnings (printed with `!`), e.g. hooks that still have to be trusted in the harness */
  warnings?: string[];
}

export type InstallScope = 'user' | 'project';

export interface HookCommand {
  /** argv form, e.g. ['/usr/local/bin/node', '/Users/x/.ai-obs/app/bin/ai-obs.js', 'hook', 'claude-code', 'Stop'] */
  argv: string[];
  /** the same as one POSIX-shell-quoted string */
  shell: string;
}

export interface InstallOptions {
  scope: InstallScope;
  /** repo root for scope 'project' (the token is never written there) */
  projectDir?: string;
  /** builds the command a hook must run for `hookName` */
  hookCommand: (hookName: string) => HookCommand;
}

export interface UninstallOptions {
  scope: InstallScope;
  projectDir?: string;
}

/** One hook call as recorded by `ai-obs hook <harness> <hook>` and replayed in the worker. */
export interface HookInvocation {
  harness: HarnessName;
  /** hook name exactly as passed on the command line, e.g. "Stop", "SessionEnd", "stop" */
  hook: string;
  /** stdin JSON from the harness (null when there was none / unparsable) */
  payload: unknown;
  /** payload.cwd when present, else the hook process's cwd */
  cwd: string;
  /** harness-related env vars only (CLAUDE_*, CODEX_*, AI_OBS_*); names suggesting secrets are dropped */
  env: Record<string, string>;
  /** ISO time the hook fired */
  receivedAt: string;
}

/** Everything an adapter gets from the core. One context per harness per worker run. */
export interface CollectorContext {
  readonly harness: HarnessName;
  readonly config: CollectorConfig;
  readonly paths: AiObsPaths;
  /**
   * Append events (build them with src/events.ts) to the session's stream, from `streamFor()`. A null
   * key drops them (logged). Project keys and usage names stay plain: the sender names / hashes them
   * for the receiving token (C3).
   */
  readonly queue: Pick<QueueStore, 'enqueue'>;
  /** per-session JSON state: ~/.ai-obs/state/<harness>/<session>.json */
  readonly state: SessionStateStore;
  readonly log: Logger;
  /**
   * Project of a working directory for `session_start.project`: the plain remote, or a keyed hash for a
   * path; never a path. Cached per cwd. Routing never uses it: the sender overwrites it from the stream key.
   */
  projectKey(cwd: string): Promise<ProjectRef>;
  /**
   * The session's stream, pinned once per session (C12, C15): a pinned token-bound project stream is
   * returned as is; a pinned open one joins the project's explicit choice once there is one; an
   * unresolved one is retried and adopted (keeping its token binding); otherwise the key of
   * `holder.pkCwd` is resolved and bound with the routing in force at `capturedAt` (the `received_at`
   * of the session's first hook). Sets `holder.stream` (the caller saves the holder). Null = do not
   * record (no cwd, or `ai-obs use --none`).
   */
  streamFor(holder: StreamHolder, capturedAt: number): Promise<StreamKey | null>;
  now(): Date;
  /**
   * Summarize turns with this adapter's summarize(), enqueue `turn_summary` events into `key`'s stream,
   * and keep failed digests (locally, with their key) for retry on the next call. Never throws.
   */
  summarizeTurns(digests: TurnDigest[], key: StreamKey | null): Promise<void>;
}

/** Session state that pins a stream: the session's first cwd and, once bound, its stream (C15). */
export interface StreamHolder {
  stream?: StreamKey;
  /** the cwd the project key is resolved from; null = unknown (pre-upgrade Codex state without session_meta) */
  pkCwd?: string | null;
}
