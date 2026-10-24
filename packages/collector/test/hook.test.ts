import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStdin, runHook } from '../src/hook.js';
import { filterEnv, listJobs, type JobFile } from '../src/jobs.js';
import { cleanupHomes, gitRepo, tmpHome, writeDotFile, writeTestConfig, writeTestServers } from './helpers.js';
import { writeJsonAtomic } from '../src/fsutil.js';
import { rememberPk } from '../src/pk-cache.js';
import { readDropped, recordDropped, writeServerDelivery } from '../src/delivery.js';

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
    expect(file).toMatch(/\.v2\.json$/);
    expect(job).toMatchObject({ v: 2, harness: 'claude-code', hook: 'Stop', cwd: '/work/repo', payload: { session_id: 's1' } });
    expect(job.env).toEqual({ CLAUDE_PROJECT_DIR: '/work/repo' });
  });

  it('does not wait for a stdin that never closes', async () => {
    // fake timers: the timeout itself is asserted, not the wall clock of a loaded test machine
    vi.useFakeTimers();
    try {
      let done = false;
      const read = readStdin(stdinWith(null), 50).then((v) => ((done = true), v));
      await vi.advanceTimersByTimeAsync(49);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(await read).toBe('');
    } finally {
      vi.useRealTimers();
    }
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
});

describe('SessionStart nudge', () => {
  const SELF = ['/usr/bin/node', '/app/bin/ai-obs.js'] as const;
  const KEY = 'github.com/acme/billing';
  const A = 'https://obs.acme.io';
  const B = 'https://obs.globex.io';
  const DAY = 86_400_000;

  function run(
    paths: ReturnType<typeof tmpHome>,
    harness: string,
    hook: string,
    payload: Record<string, unknown> = {},
    extra: Partial<Parameters<typeof runHook>[1]> = {},
  ) {
    const out: string[] = [];
    const calls: Array<{ cwd: string; timeoutMs: number; bounded?: boolean }> = [];
    return runHook([harness, hook], {
      paths,
      stdin: stdinWith(JSON.stringify({ session_id: 'sess-1', cwd: '/work/billing', ...payload })),
      spawnWorker: () => {},
      stdout: { write: (x: string) => void out.push(x) },
      selfCommand: SELF,
      resolveProjectKey: async (cwd, opts) => {
        calls.push({ cwd, ...opts });
        return KEY;
      },
      ...extra,
    }).then((code) => ({ code, out, calls }));
  }
  const textOf = (line: string) => (JSON.parse(line) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  const two = (paths: ReturnType<typeof tmpHome>) => writeTestServers(paths, [{ endpoint: A }, { endpoint: B }]);

  it('(a) two servers and no dot file: one JSON line for Claude Code, plain text for Codex, asking for `ai-obs link`', async () => {
    const paths = tmpHome();
    two(paths);
    const cc = await run(paths, 'claude-code', 'SessionStart');
    expect(cc.code).toBe(0);
    expect(cc.out).toHaveLength(1);
    expect(cc.out[0]!.endsWith('\n')).toBe(true);
    const json = JSON.parse(cc.out[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(json.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const text = json.hookSpecificOutput.additionalContext;
    expect(text).toContain('obs.acme.io, obs.globex.io');
    expect(text).toContain("/usr/bin/node /app/bin/ai-obs.js link --server <url> --team <team> --project-dir /work/billing");
    expect(text).not.toContain('aiobs_');
    expect(cc.calls).toHaveLength(0); // no git without a warning to look up
    const codex = await run(paths, 'codex', 'SessionStart', { session_id: 'c1' });
    expect(codex.out).toHaveLength(1);
    expect(() => JSON.parse(codex.out[0]!)).toThrow();
    expect(codex.out[0]).toContain('link --server <url> --team <team>');
  });

  it('stays silent for other hooks, sub-agents, one server without a dot file, and a dot file naming a registered server', async () => {
    const paths = tmpHome();
    two(paths);
    expect((await run(paths, 'claude-code', 'Stop')).out).toEqual([]);
    expect((await run(paths, 'claude-code', 'SessionStart', { agent_id: 'sub' })).out).toEqual([]);
    const repo = gitRepo();
    writeDotFile(repo, { server: B, team: 'platform' });
    expect((await run(paths, 'claude-code', 'SessionStart', { cwd: repo })).out).toEqual([]);
    const one = tmpHome();
    writeTestConfig(one, A);
    expect((await run(one, 'claude-code', 'SessionStart')).out).toEqual([]);
  });

  it('(b) the dot file names a server without a token: tell the user to log in (also with no server at all)', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, A);
    const repo = gitRepo();
    writeDotFile(repo, { server: 'https://obs.other.io', team: 'platform' });
    const r = await run(paths, 'claude-code', 'SessionStart', { cwd: repo });
    const text = textOf(r.out[0]!);
    expect(text).toContain('reports to https://obs.other.io');
    expect(text).toContain('not logged in to that server');
    expect(text).toContain('ai-obs.js login --server https://obs.other.io');
    const none = tmpHome();
    writeTestServers(none, []);
    expect(textOf((await run(none, 'claude-code', 'SessionStart', { cwd: repo })).out[0]!)).toContain('login --server https://obs.other.io');
  });

  it('(b) an expired or a refused token for the repository’s server', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, A, { expiresAt: new Date(Date.now() - DAY).toISOString() });
    expect(textOf((await run(paths, 'claude-code', 'SessionStart')).out[0]!)).toContain(`the ai-obs token for ${A} has expired`);
    const refused = tmpHome();
    const cfg = writeTestConfig(refused, A);
    writeServerDelivery(refused, cfg.servers[0]!, { blocked: { status: 401, at: new Date().toISOString(), message: 'x' } });
    const text = textOf((await run(refused, 'claude-code', 'SessionStart')).out[0]!);
    expect(text).toContain(`${A} rejected this machine's ai-obs token`);
    expect(text).toContain(`login --server ${A}`);
  });

  it('(c) a token that expires within 14 days; not at 20 days', async () => {
    const paths = tmpHome();
    const exp = new Date(Date.now() + 10 * DAY + 3600_000).toISOString();
    writeTestConfig(paths, A, { expiresAt: exp });
    const text = textOf((await run(paths, 'claude-code', 'SessionStart')).out[0]!);
    expect(text).toContain(`expires in 10 days (${exp.slice(0, 10)})`);
    expect(text).toContain(`login --server ${A}\` before then`);
    const later = tmpHome();
    writeTestConfig(later, A, { expiresAt: new Date(Date.now() + 20 * DAY).toISOString() });
    expect((await run(later, 'claude-code', 'SessionStart')).out).toEqual([]);
  });

  it('(e) a server warning about this project’s team (key from the cache, git only when warnings exist)', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, A);
    writeJsonAtomic(paths.warnings, { [KEY]: { code: 'team_not_member', team: 'mobile', endpoint: A, session_id: 's0', at: new Date().toISOString() } });
    rememberPk(paths, '/work/billing', KEY);
    const hit = await run(paths, 'claude-code', 'SessionStart');
    expect(hit.calls).toHaveLength(0);
    expect(textOf(hit.out[0]!)).toContain('ignored team "mobile"');
    // no cache entry: git, bounded
    const miss = tmpHome();
    writeTestConfig(miss, A);
    writeJsonAtomic(miss.warnings, { [KEY]: { code: 'team_unknown', team: 'mobile', endpoint: A, session_id: 's0', at: new Date().toISOString() } });
    const m = await run(miss, 'claude-code', 'SessionStart');
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ bounded: true });
    expect(m.calls[0]!.timeoutMs).toBeLessThanOrEqual(40);
    expect(textOf(m.out[0]!)).toContain('no team has that slug');
    // a warning from another server is not about where this repository reports now
    const other = tmpHome();
    writeTestConfig(other, A);
    writeJsonAtomic(other.warnings, { [KEY]: { code: 'team_unknown', team: 'mobile', endpoint: B, session_id: 's0', at: new Date().toISOString() } });
    expect((await run(other, 'claude-code', 'SessionStart')).out).toEqual([]);
  });

  it('prints a text only once per session until it changes', async () => {
    const paths = tmpHome();
    two(paths);
    expect((await run(paths, 'claude-code', 'SessionStart')).out).toHaveLength(1);
    expect((await run(paths, 'claude-code', 'SessionStart')).out).toHaveLength(0); // same session, same text
    expect((await run(paths, 'claude-code', 'SessionStart', { session_id: 'other' })).out).toHaveLength(1);
    writeTestServers(paths, [{ endpoint: A }, { endpoint: B }, { endpoint: 'https://obs.third.io' }]);
    expect((await run(paths, 'claude-code', 'SessionStart')).out).toHaveLength(1);
    expect((await run(paths, 'claude-code', 'SessionStart')).out).toHaveLength(0);
  });

  it('mentions deleted events once', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, A);
    writeJsonAtomic(paths.dropped, { held_events: 7, sendable_events: 0, last_at: '2026-10-08T10:00:00.000Z', shown_at: null });
    const first = await run(paths, 'claude-code', 'SessionStart');
    expect(textOf(first.out[0]!)).toContain('deleted 7 kept events');
    expect(readDropped(paths).shown_at).toBeTruthy();
    // the hook never rewrites the counters (the worker does, under its lock): no lost update (C13)
    expect(JSON.parse(readFileSync(paths.dropped, 'utf8'))).toMatchObject({ held_events: 7, shown_at: null });
    expect((await run(paths, 'claude-code', 'SessionStart', { session_id: 'next' })).out).toEqual([]);
  });

  it('mentions sendable events the caps deleted (C13), and a drop recorded after it was shown', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, A);
    recordDropped(paths, { held: 0, sendable: 4 }, new Date('2026-10-08T10:00:00.000Z'));
    expect(textOf((await run(paths, 'claude-code', 'SessionStart')).out[0]!)).toContain('deleted 4 events it could not send in time');
    recordDropped(paths, { held: 3, sendable: 0 }, new Date(Date.now() + 60_000));
    const again = await run(paths, 'claude-code', 'SessionStart', { session_id: 'next' });
    expect(again.out).toHaveLength(1);
    expect(again.out[0]).toContain('deleted 3 kept events');
    expect(again.out[0]).not.toContain('deleted 4'); // already told: only what came since is reported
    recordDropped(paths, { held: 1, sendable: 0 }, new Date(Date.now() + 120_000));
    const third = await run(paths, 'claude-code', 'SessionStart', { session_id: 'third' });
    expect(third.out[0]).toContain('deleted 1 kept events');
    expect(third.out[0]).not.toContain('deleted 4 kept events');
  });

  it('a session in a subdirectory gets `link --project-dir <repository root>`', async () => {
    const paths = tmpHome();
    two(paths);
    const repo = gitRepo();
    const sub = join(repo, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    const r = await run(paths, 'claude-code', 'SessionStart', { session_id: 'sub', cwd: sub });
    expect(textOf(r.out[0]!)).toContain(`--project-dir ${repo}\``);
  });

  it('never fails on a damaged config or dot file, and still writes the job', async () => {
    const paths = tmpHome();
    two(paths);
    const repo = gitRepo();
    writeDotFile(repo, '{not json');
    const r = await run(paths, 'claude-code', 'SessionStart', { cwd: repo });
    expect(r.code).toBe(0);
    expect(textOf(r.out[0]!)).toContain('link --server'); // a malformed dot file counts as absent
    expect(listJobs(paths.jobs)).toHaveLength(1);
    writeFileSync(paths.config, '{broken');
    const r2 = await run(paths, 'codex', 'SessionStart', { session_id: 'x' });
    expect(r2.code).toBe(0);
    expect(r2.out).toEqual([]);
  });

  it('skips git when 40 ms have already passed since hook entry (stdin held open)', async () => {
    const paths = tmpHome();
    writeTestConfig(paths, A);
    writeJsonAtomic(paths.warnings, { [KEY]: { code: 'team_unknown', team: 'mobile', endpoint: A, session_id: 's0', at: new Date().toISOString() } });
    const stdin = new PassThrough(); // never ends: readStdin gives up after its 50 ms cap
    stdin.write(JSON.stringify({ session_id: 's', cwd: '/work/billing' }));
    const out: string[] = [];
    let called = 0;
    const t = performance.now();
    const code = await runHook(['claude-code', 'SessionStart'], {
      paths,
      stdin,
      spawnWorker: () => {},
      stdout: { write: (x: string) => void out.push(x) },
      selfCommand: SELF,
      resolveProjectKey: async () => {
        called++;
        return KEY;
      },
    });
    expect(code).toBe(0);
    expect(called).toBe(0);
    expect(out).toEqual([]); // no key, so no warning
    expect(performance.now() - t).toBeLessThan(100);
    expect(listJobs(paths.jobs)).toHaveLength(1);
  });

  it('never prints in the summarizer', async () => {
    const paths = tmpHome();
    two(paths);
    const r = await run(paths, 'claude-code', 'SessionStart', {}, { env: { AI_OBS_SUMMARIZING: '1' } });
    expect(r.out).toEqual([]);
    expect(listJobs(paths.jobs)).toHaveLength(0);
  });
});
