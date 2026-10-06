import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 1500;

/** Runs git; resolves trimmed stdout, or null on any failure / timeout. Never throws. */
export function runGit(args: string[], cwd?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        args,
        { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
      );
    } catch {
      resolve(null);
    }
  });
}

/** git user.email as git resolves it in `cwd` (repo config, includeIf, then global). */
export function gitEmail(cwd?: string): Promise<string | null> {
  return runGit(['config', '--get', 'user.email'], cwd);
}

/** Absolute repository root containing `cwd`, or null outside a repo. */
export function gitTopLevel(cwd: string): Promise<string | null> {
  return runGit(['rev-parse', '--show-toplevel'], cwd);
}

/** URL of `origin`, else of the first remote; null when the repo has none. */
export async function gitRemoteUrl(cwd: string): Promise<string | null> {
  const origin = await runGit(['remote', 'get-url', 'origin'], cwd);
  if (origin) return origin;
  const remotes = await runGit(['remote'], cwd);
  const first = remotes?.split('\n')[0]?.trim();
  return first ? runGit(['remote', 'get-url', first], cwd) : null;
}
