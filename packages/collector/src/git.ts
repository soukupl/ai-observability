import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve as resolvePath } from 'node:path';

const DEFAULT_TIMEOUT_MS = 1500;
const MAX_OUTPUT = 256 * 1024;
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

/** Result of one git call: trimmed stdout (null on failure / empty) and whether the deadline cut it off. */
export interface GitResult {
  out: string | null;
  timedOut: boolean;
}

/** Runs git (execFile; on timeout it waits for the child to close). Never throws. */
export function runGitResult(args: string[], cwd?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    try {
      execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_OUTPUT, env: gitEnv() }, (err, stdout) => {
        if (err) resolve({ out: null, timedOut: (err as { killed?: boolean }).killed === true });
        else resolve({ out: String(stdout).trim() || null, timedOut: false });
      });
    } catch {
      resolve({ out: null, timedOut: false });
    }
  });
}

/** Runs git; resolves trimmed stdout, or null on any failure / timeout. Never throws. */
export async function runGit(args: string[], cwd?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  return (await runGitResult(args, cwd, timeoutMs)).out;
}

/**
 * Runs git with a hard deadline (C26, the hook path): built on `spawn`; when `deadlineMs` passes it
 * sends SIGKILL, destroys the child's stdio, `unref()`s it and resolves `{out: null, timedOut: true}`
 * at once — without waiting for `close`, so a git stuck in uninterruptible I/O (or a grandchild that
 * keeps the pipe open) cannot hold the caller. Never throws.
 */
export function runGitBounded(args: string[], cwd: string | undefined, deadlineMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    if (!(deadlineMs > 0)) {
      resolve({ out: null, timedOut: true });
      return;
    }
    const start = Date.now(); // the (synchronous) spawn itself counts against the deadline
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: gitEnv() });
    } catch {
      resolve({ out: null, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      child.stdout?.destroy();
      child.unref();
      done({ out: null, timedOut: true });
    }, Math.max(0, deadlineMs - (Date.now() - start)));
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < MAX_OUTPUT) out += chunk;
    });
    child.stdout?.on('error', () => {});
    child.on('error', () => done({ out: null, timedOut: false }));
    child.on('close', (code) => done({ out: code === 0 ? out.trim() || null : null, timedOut: false }));
  });
}

/** git user.email as git resolves it in `cwd` (repo config, includeIf, then global). */
export function gitEmail(cwd?: string): Promise<string | null> {
  return runGit(['config', '--get', 'user.email'], cwd);
}

/** How a key resolution runs git: one shared deadline, optionally hard-bounded (the hook, C26). */
export interface GitDeadline {
  /** absolute deadline (ms, Date.now() clock) shared by every call of one resolution */
  until: number;
  bounded?: boolean;
}

function call(args: string[], cwd: string, d?: GitDeadline): Promise<GitResult> {
  if (!d) return runGitResult(args, cwd);
  const left = Math.ceil(d.until - Date.now());
  if (left <= 0) return Promise.resolve({ out: null, timedOut: true });
  return d.bounded ? runGitBounded(args, cwd, left) : runGitResult(args, cwd, left);
}

/** Absolute repository root containing `cwd` (with timeout information). */
export function gitTopLevelResult(cwd: string, d?: GitDeadline): Promise<GitResult> {
  return call(['rev-parse', '--show-toplevel'], cwd, d);
}

/**
 * Root of the repository containing `cwd`, for path keys (one git call): the top-level, except in a
 * linked worktree (`git worktree add`, `.claude/worktrees/…`), where it is the main checkout, so every
 * worktree of a repository without a remote shares one key. A bare repository's worktrees and
 * submodules keep their own top-level.
 */
export async function gitRepoRootResult(cwd: string, d?: GitDeadline): Promise<GitResult> {
  const r = await call(['rev-parse', '--show-toplevel', '--git-common-dir'], cwd, d);
  if (!r.out) return r;
  const [top, common] = r.out.split('\n').map((l) => l.trim());
  if (!top) return { out: null, timedOut: false };
  if (common) {
    try {
      const abs = realpathSync(resolvePath(cwd, common));
      const main = dirname(abs);
      if (basename(abs) === '.git' && main !== realpathSync(top)) return { out: main, timedOut: false };
    } catch {
      /* the common dir vanished: the top-level */
    }
  }
  return { out: top, timedOut: false };
}

/** URL of `origin`, else of the first remote (with timeout information); the fallback chain shares the deadline. */
export async function gitRemoteUrlResult(cwd: string, d?: GitDeadline): Promise<GitResult> {
  const origin = await call(['remote', 'get-url', 'origin'], cwd, d);
  if (origin.out || origin.timedOut) return origin;
  const remotes = await call(['remote'], cwd, d);
  if (remotes.timedOut) return remotes;
  const first = remotes.out?.split('\n')[0]?.trim();
  return first ? call(['remote', 'get-url', first], cwd, d) : { out: null, timedOut: false };
}

/** Absolute repository root containing `cwd`, or null outside a repo. */
export async function gitTopLevel(cwd: string, timeoutMs?: number): Promise<string | null> {
  return (await gitTopLevelResult(cwd, timeoutMs === undefined ? undefined : { until: Date.now() + timeoutMs })).out;
}

/** URL of `origin`, else of the first remote; null when the repo has none. The chain shares one deadline. */
export async function gitRemoteUrl(cwd: string, timeoutMs?: number): Promise<string | null> {
  return (await gitRemoteUrlResult(cwd, timeoutMs === undefined ? undefined : { until: Date.now() + timeoutMs })).out;
}
