/**
 * The hook as the harness runs it: a real `node bin/ai-obs.js hook …` process over the built dist
 * (skipped until `pnpm --filter @soukupl/ai-obs build` has run). Node startup is included in the timing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listJobs } from '../src/jobs.js';
import type { AiObsPaths } from '../src/paths.js';
import { cleanupHomes, gitRepo, tmpHome, writeDotFile, writeTestConfig, writeTestServers } from './helpers.js';

afterEach(cleanupHomes);

const bin = fileURLToPath(new URL('../bin/ai-obs.js', import.meta.url));
const built = existsSync(fileURLToPath(new URL('../dist/hook.js', import.meta.url)));
/** node startup included, generous for a loaded machine (idle: ~60-85 ms) */
const LIMIT_MS = process.env.CI ? 500 : 400;

function runHookProcess(paths: AiObsPaths, args: string[], payload: unknown) {
  // warm-up (file system caches), then measure
  spawnSync(process.execPath, [bin, 'hook', 'codex', 'noop'], { env: { ...process.env, AI_OBS_HOME: '/nonexistent' }, input: '{}' });
  const t = performance.now();
  const res = spawnSync(process.execPath, [bin, 'hook', ...args], {
    env: { ...process.env, AI_OBS_HOME: paths.root, AI_OBS_SUMMARIZING: '' },
    input: JSON.stringify(payload),
  });
  return { res, ms: performance.now() - t };
}

/** Lets the detached worker finish before the temp home is removed. */
function waitForWorker(paths: AiObsPaths): void {
  const deadline = Date.now() + 5000;
  while ((listJobs(paths.jobs).length || existsSync(paths.workerLock)) && Date.now() < deadline) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
  }
  expect(listJobs(paths.jobs)).toHaveLength(0);
}

describe.skipIf(!built)('real process (needs `pnpm --filter @soukupl/ai-obs build`)', () => {
  it('one server: `ai-obs hook` exits 0 quickly, prints nothing and leaves a job for the worker', () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    const { res, ms } = runHookProcess(paths, ['claude-code', 'SessionStart'], { session_id: 's1' });
    expect(res.status).toBe(0);
    expect(res.stdout.toString()).toBe('');
    expect(ms).toBeLessThan(LIMIT_MS);
    waitForWorker(paths);
  });

  it('two servers and a repository without a dot file: one valid JSON line on stdout, within the same budget', () => {
    const paths = tmpHome();
    writeTestServers(paths, [{ endpoint: 'https://obs.acme.io' }, { endpoint: 'https://obs.globex.io' }]);
    const repo = gitRepo({ remote: 'git@github.com:acme/billing.git' });
    const { res, ms } = runHookProcess(paths, ['claude-code', 'SessionStart'], { session_id: 's1', cwd: repo, hook_event_name: 'SessionStart' });
    expect(res.status).toBe(0);
    expect(ms).toBeLessThan(LIMIT_MS);
    const lines = res.stdout.toString().split('\n');
    expect(lines.at(-1)).toBe(''); // newline-terminated
    expect(lines.filter(Boolean)).toHaveLength(1);
    const out = JSON.parse(lines[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const text = out.hookSpecificOutput.additionalContext;
    expect(text).toContain('obs.acme.io, obs.globex.io');
    expect(text).toContain('link --server <url> --team <team>');
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).not.toContain('aiobs_');
    expect(res.stderr.toString()).toBe('');
    waitForWorker(paths);
  });

  it('the dot-file lookup runs inside the budget: a dot file naming a server without a token asks to log in (Codex: plain text)', () => {
    const paths = tmpHome();
    writeTestConfig(paths, 'https://obs.acme.io');
    const repo = gitRepo({ remote: 'git@github.com:acme/billing.git' });
    writeDotFile(repo, { server: 'https://obs.other.io', team: 'platform' });
    const deep = join(repo, 'a', 'b', 'c', 'd');
    mkdirSync(deep, { recursive: true });
    const { res, ms } = runHookProcess(paths, ['codex', 'SessionStart'], { session_id: 's1', cwd: deep, hook_event_name: 'SessionStart' });
    expect(res.status).toBe(0);
    expect(ms).toBeLessThan(LIMIT_MS);
    const out = res.stdout.toString();
    expect(out.endsWith('\n')).toBe(true);
    expect(out.trimEnd()).not.toContain('\n');
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain('login --server https://obs.other.io');
    waitForWorker(paths);
  });
});
