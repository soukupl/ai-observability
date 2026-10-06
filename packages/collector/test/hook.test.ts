import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readStdin, runHook } from '../src/hook.js';
import { filterEnv, listJobs, type JobFile } from '../src/jobs.js';
import { cleanupHomes, tmpHome, writeTestConfig } from './helpers.js';

afterEach(cleanupHomes);

const stdinWith = (text: string | null) => {
  const s = new PassThrough();
  if (text !== null) s.end(text);
  return s;
};

describe('hook fast path', () => {
  it('writes a job, spawns the worker and returns 0 in < 100 ms', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    let spawned = 0;
    const t = performance.now();
    const code = await runHook(['claude-code', 'Stop'], {
      paths,
      stdin: stdinWith(JSON.stringify({ session_id: 's1', cwd: '/work/repo', transcript_path: '/x.jsonl' })),
      env: { CLAUDE_PROJECT_DIR: '/work/repo', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', HOME: '/h' },
      spawnWorker: () => void spawned++,
    });
    const ms = performance.now() - t;
    expect(code).toBe(0);
    expect(ms).toBeLessThan(100);
    expect(spawned).toBe(1);
    const [file] = listJobs(paths.jobs);
    const job = JSON.parse(readFileSync(file!, 'utf8')) as JobFile;
    expect(job).toMatchObject({ v: 1, harness: 'claude-code', hook: 'Stop', cwd: '/work/repo', payload: { session_id: 's1' } });
    expect(job.env).toEqual({ CLAUDE_PROJECT_DIR: '/work/repo' });
  });

  it('does not wait for a stdin that never closes', async () => {
    const t = performance.now();
    expect(await readStdin(stdinWith(null), 50)).toBe('');
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('never fails: bad JSON, unknown harness, missing config, worker spawn error', async () => {
    const paths = tmpHome();
    expect(await runHook(['claude-code', 'Stop'], { paths, stdin: stdinWith('{}'), spawnWorker: () => {} })).toBe(0);
    expect(listJobs(paths.jobs)).toHaveLength(0); // not configured → nothing recorded
    writeTestConfig(paths);
    expect(await runHook(['nope', 'Stop'], { paths, stdin: stdinWith('{}') })).toBe(0);
    expect(await runHook(['codex', 'stop'], { paths, stdin: stdinWith('not json'), spawnWorker: () => {} })).toBe(0);
    expect(JSON.parse(readFileSync(listJobs(paths.jobs)[0]!, 'utf8')).payload).toBeNull();
    const boom = () => {
      throw new Error('spawn failed');
    };
    expect(await runHook(['codex', 'stop'], { paths, stdin: stdinWith('{}'), spawnWorker: boom })).toBe(0);
    expect(readFileSync(paths.logFile, 'utf8')).toContain('spawn failed');
  });

  it('exits immediately inside the summarizer (AI_OBS_SUMMARIZING)', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    expect(await runHook(['claude-code', 'Stop'], { paths, env: { AI_OBS_SUMMARIZING: '1' }, stdin: stdinWith('{}') })).toBe(0);
    expect(listJobs(paths.jobs)).toHaveLength(0);
  });

  it('filterEnv keeps harness vars and drops secrets', () => {
    expect(filterEnv({ CODEX_HOME: '/c', CLAUDE_API_KEY: 'x', AI_OBS_HOME: '/a', OPENAI_API_KEY: 'x', PATH: '/bin' })).toEqual({
      CODEX_HOME: '/c',
      AI_OBS_HOME: '/a',
    });
  });

  const bin = fileURLToPath(new URL('../bin/ai-obs.js', import.meta.url));
  const built = existsSync(fileURLToPath(new URL('../dist/hook.js', import.meta.url)));
  it.skipIf(!built)('real process: `ai-obs hook` exits 0 quickly and leaves a job (needs `pnpm build`)', () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    // warm-up (file system caches), then measure
    spawnSync(process.execPath, [bin, 'hook', 'codex', 'noop'], { env: { ...process.env, AI_OBS_HOME: '/nonexistent' }, input: '{}' });
    const t = performance.now();
    const res = spawnSync(process.execPath, [bin, 'hook', 'claude-code', 'SessionStart'], {
      env: { ...process.env, AI_OBS_HOME: paths.root, AI_OBS_SUMMARIZING: '' },
      input: JSON.stringify({ session_id: 's1' }),
    });
    const ms = performance.now() - t;
    expect(res.status).toBe(0);
    expect(res.stdout.toString()).toBe('');
    expect(ms).toBeLessThan(process.env.CI ? 500 : 400); // node startup included, generous for a loaded machine (idle: ~60-85 ms)
    // let the detached worker finish before the temp home is removed
    const deadline = Date.now() + 5000;
    while ((listJobs(paths.jobs).length || existsSync(paths.workerLock)) && Date.now() < deadline) {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},50)']);
    }
    expect(listJobs(paths.jobs)).toHaveLength(0);
  });
});
