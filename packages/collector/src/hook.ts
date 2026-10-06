/**
 * `ai-obs hook <harness> <hookName>` — the FAST PATH run inside the harness. Budget: < 100 ms.
 * Reads the stdin JSON, writes a job file, spawns the detached worker, exits 0. It never blocks or
 * fails the harness: every error is logged to ~/.ai-obs/log and swallowed. Keep imports minimal.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { filterEnv, writeJob } from './jobs.js';
import { createLogger } from './log.js';
import { aiObsPaths, type AiObsPaths } from './paths.js';
import type { HarnessName } from './protocol-types.js';

const HARNESSES: readonly string[] = ['claude-code', 'codex'];
const STDIN_TIMEOUT_MS = 50;
const STDIN_MAX_BYTES = 4 * 1024 * 1024;

export interface HookDeps {
  paths?: AiObsPaths;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean; destroy?: () => void };
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
  /** starts the worker; default spawns `node dist/worker-main.js` detached */
  spawnWorker?: (paths: AiObsPaths) => void;
}

/** Reads all of stdin, giving up after `timeoutMs` without data / end (harness kept the pipe open). */
export function readStdin(stream: HookDeps['stdin'], timeoutMs = STDIN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY) return resolve('');
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', finish);
      stream.removeListener('error', finish);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (c: Buffer | string) => {
      const b = typeof c === 'string' ? Buffer.from(c) : c;
      size += b.length;
      if (size <= STDIN_MAX_BYTES) chunks.push(b);
      timer.refresh(); // data is flowing; wait for the end
    };
    const timer = setTimeout(() => {
      finish();
      try {
        stream.destroy?.();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    stream.on('data', onData);
    stream.once('end', finish);
    stream.once('error', finish);
  });
}

export function defaultSpawnWorker(paths: AiObsPaths): void {
  const entry = fileURLToPath(new URL('./worker-main.js', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, AI_OBS_HOME: paths.root },
  });
  child.on('error', () => {});
  child.unref();
}

/** Always resolves 0. `args` = [harness, hookName]. */
export async function runHook(args: readonly string[], deps: HookDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  if (env.AI_OBS_SUMMARIZING) return 0;
  const paths = deps.paths ?? aiObsPaths();
  try {
    const [harness, hook] = args;
    if (!harness || !HARNESSES.includes(harness) || !hook) {
      createLogger(paths, 'hook').warn('hook: bad invocation', { harness, hook });
      return 0;
    }
    if (!existsSync(paths.config)) return 0; // not configured (or uninstalled with --purge)
    const raw = await readStdin(deps.stdin ?? process.stdin);
    let payload: unknown = null;
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        createLogger(paths, 'hook').warn('hook: stdin is not JSON', { harness, hook, bytes: raw.length });
      }
    }
    const payloadCwd = payload && typeof payload === 'object' && typeof (payload as { cwd?: unknown }).cwd === 'string' ? (payload as { cwd: string }).cwd : null;
    const now = deps.now?.() ?? Date.now();
    writeJob(
      paths.jobs,
      {
        v: 1,
        harness: harness as HarnessName,
        hook,
        payload,
        cwd: payloadCwd ?? deps.cwd ?? process.cwd(),
        env: filterEnv(env),
        received_at: new Date(now).toISOString(),
      },
      now,
    );
    (deps.spawnWorker ?? defaultSpawnWorker)(paths);
  } catch (err) {
    createLogger(paths, 'hook').error('hook: failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return 0;
}
