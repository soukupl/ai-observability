import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStdin, runHook } from '../src/hook.js';
import { filterEnv, listJobs, type JobFile } from '../src/jobs.js';
import { writeProjects, cleanupHomes, tmpHome, writeTestConfig, writeTestTokens } from './helpers.js';
import { writeJsonAtomic } from '../src/fsutil.js';
import { rememberPk } from '../src/pk-cache.js';
import { streamDirName, OPEN } from '../src/projects.js';
import { readDropped, recordDropped, writeTokenDelivery } from '../src/delivery.js';
import { tokenFingerprint } from '../src/config.js';
import { join } from 'node:path';

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
  const CWD = '/work/billing';

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
      stdin: stdinWith(JSON.stringify({ session_id: 'sess-1', cwd: CWD, ...payload })),
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
  const two = (paths: ReturnType<typeof tmpHome>) => writeTestTokens(paths, [{ name: 'acme' }, { name: 'globex', token: 'aiobs_c_globex' }]);

  it('prints one JSON line for Claude Code and plain text for Codex when a repo is unassigned', async () => {
    const paths = tmpHome();
    two(paths);
    const cc = await run(paths, 'claude-code', 'SessionStart');
    expect(cc.code).toBe(0);
    expect(cc.out).toHaveLength(1);
    expect(cc.out[0]!.endsWith('\n')).toBe(true);
    const json = JSON.parse(cc.out[0]!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(json.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const text = json.hookSpecificOutput.additionalContext;
    expect(text).toContain(KEY);
    expect(text).toContain('"acme"');
    expect(text).toContain('"globex"');
    expect(text).toContain('use <name> --project-dir /work/billing');
    expect(text).toContain('use --none');
    expect(listJobs(paths.jobs)).toHaveLength(1); // the job is written first

    const cx = await run(paths, 'codex', 'SessionStart', { session_id: 'sess-2' });
    expect(cx.out).toHaveLength(1);
    expect(cx.out[0]).toBe(`${text}\n`); // plain text, same words, no JSON
    expect(() => JSON.parse(cx.out[0]!)).toThrow();
  });

  it('stays silent for other hooks, sub-agents, assigned repos and --none', async () => {
    const paths = tmpHome();
    two(paths);
    expect((await run(paths, 'claude-code', 'Stop')).out).toEqual([]);
    expect((await run(paths, 'codex', 'SessionStart', { agent_id: 'sub-1' })).out).toEqual([]);
    writeProjects(paths, { [KEY]: { token: null, none: true, assigned_at: new Date().toISOString() } });
    expect((await run(paths, 'claude-code', 'SessionStart')).out).toEqual([]);
    const cfg = JSON.parse(readFileSync(paths.config, 'utf8')) as { tokens: Array<{ name: string; endpoint: string; token: string }> };
    const acme = cfg.tokens[0]!;
    writeProjects(paths, { [KEY]: { token: 'acme', endpoint: acme.endpoint, company_slug: 'acme', token_fp: tokenFingerprint(acme.token), assigned_at: new Date().toISOString() } });
    const r = await run(paths, 'claude-code', 'SessionStart');
    expect(r.out).toEqual([]);
    expect(listJobs(paths.jobs).length).toBeGreaterThan(0);
  });

  it('does not run git for one token with no projects and no open data', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    const r = await run(paths, 'claude-code', 'SessionStart', {}, { resolveProjectKey: async () => { throw new Error('must not be called'); } });
    expect(r.out).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('one token with an open backlog for the key asks about it', async () => {
    const paths = tmpHome();
    writeTestConfig(paths);
    const dir = join(paths.queueProjects, streamDirName(KEY, OPEN));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '01ARZ3NDEKTSV4RRFFQ69G5FAV.ndjson'), '{}\n');
    const r = await run(paths, 'claude-code', 'SessionStart');
    const text = (JSON.parse(r.out[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(text).toContain('recorded while several ai-obs tokens were registered');
    expect(text).toMatch(/ use [a-z0-9-]+ --project-dir \/work\/billing/);
  });

  it('a blocked single token is reported', async () => {
    const paths = tmpHome();
    const cfg = writeTestConfig(paths);
    writeTokenDelivery(paths, cfg.tokens[0]!, { blocked: { status: 401, at: new Date().toISOString(), message: 'bad token' } });
    const r = await run(paths, 'claude-code', 'SessionStart');
    const text = (JSON.parse(r.out[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(text).toContain('rejected the token');
    expect(text).toContain('HTTP 401');
    expect(text).not.toContain('aiobs_');
  });

  it('zero tokens prints the no-tokens text', async () => {
    const paths = tmpHome();
    writeJsonAtomic(paths.config, { machine_id: 'm', created_at: new Date().toISOString(), tokens: [] });
    const r = await run(paths, 'claude-code', 'SessionStart');
    const text = (JSON.parse(r.out[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(text).toContain('has no usable token');
    expect(text).toContain('init --token');
  });

  it('prints a text only once per session until it changes', async () => {
    const paths = tmpHome();
    two(paths);
    expect((await run(paths, 'claude-code', 'SessionStart')).out).toHaveLength(1);
    expect((await run(paths, 'claude-code', 'SessionStart')).out).toHaveLength(0); // same session, same text
    expect((await run(paths, 'claude-code', 'SessionStart', { session_id: 'other' })).out).toHaveLength(1);
    // the situation changes in the same session: the new text is shown once
    writeProjects(paths, { [KEY]: { token: 'gone', endpoint: 'http://nowhere.test', token_fp: 'x', assigned_at: new Date().toISOString() } });
    expect((await run(paths, 'claude-code', 'SessionStart')).out).toHaveLength(1);
    expect((await run(paths, 'claude-code', 'SessionStart')).out).toHaveLength(0);
  });

  it('mentions deleted events once', async () => {
    const paths = tmpHome();
    two(paths);
    writeProjects(paths, { [KEY]: { token: null, none: true, assigned_at: new Date().toISOString() } });
    writeJsonAtomic(paths.dropped, { held_events: 7, sendable_events: 0, last_at: '2026-10-08T10:00:00.000Z', shown_at: null });
    const first = await run(paths, 'claude-code', 'SessionStart');
    const text = (JSON.parse(first.out[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(text).toContain('deleted 7 kept events');
    expect(readDropped(paths).shown_at).toBeTruthy();
    // the hook never rewrites the counters (the worker does, under its lock): no lost update (C13)
    expect(JSON.parse(readFileSync(paths.dropped, 'utf8'))).toMatchObject({ held_events: 7, shown_at: null });
    expect((await run(paths, 'claude-code', 'SessionStart', { session_id: 'next' })).out).toEqual([]);
  });

  it('mentions sendable events the caps deleted (C13), and a drop recorded after it was shown', async () => {
    const paths = tmpHome();
    two(paths);
    writeProjects(paths, { [KEY]: { token: null, none: true, assigned_at: new Date().toISOString() } });
    recordDropped(paths, { held: 0, sendable: 4 }, new Date('2026-10-08T10:00:00.000Z'));
    const first = await run(paths, 'claude-code', 'SessionStart');
    const text = (JSON.parse(first.out[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(text).toContain('deleted 4 events it could not send in time');
    // the worker records more drops after the hook showed the first ones: shown again
    recordDropped(paths, { held: 3, sendable: 0 }, new Date(Date.now() + 60_000));
    expect(readDropped(paths)).toMatchObject({ held_events: 3, sendable_events: 4 });
    const again = await run(paths, 'claude-code', 'SessionStart', { session_id: 'next' });
    expect(again.out).toHaveLength(1);
    expect(again.out[0]).toContain('deleted 3 kept events');
  });

  it('never fails on a damaged config or projects.json, and still writes the job', async () => {
    const paths = tmpHome();
    two(paths);
    writeFileSync(paths.projects, '{not json');
    const r = await run(paths, 'claude-code', 'SessionStart');
    expect(r.code).toBe(0);
    const text = (JSON.parse(r.out[0]!) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(text).toContain('projects.json cannot be read');
    expect(listJobs(paths.jobs)).toHaveLength(1);
    writeFileSync(paths.config, '{broken');
    const r2 = await run(paths, 'codex', 'SessionStart', { session_id: 'x' });
    expect(r2.code).toBe(0);
    expect(r2.out).toEqual([]);
  });

  it('uses the key cache without git, and bounds git on a miss', async () => {
    const paths = tmpHome();
    two(paths);
    rememberPk(paths, CWD, KEY);
    const hit = await run(paths, 'claude-code', 'SessionStart');
    expect(hit.calls).toHaveLength(0);
    expect(hit.out).toHaveLength(1);

    const paths2 = tmpHome();
    two(paths2);
    const miss = await run(paths2, 'claude-code', 'SessionStart');
    expect(miss.calls).toHaveLength(1);
    expect(miss.calls[0]).toMatchObject({ cwd: CWD, bounded: true });
    expect(miss.calls[0]!.timeoutMs).toBeLessThanOrEqual(40);
  });

  it('skips git when 40 ms have already passed since hook entry (stdin held open)', async () => {
    const paths = tmpHome();
    two(paths);
    const stdin = new PassThrough(); // never ends: readStdin gives up after its 50 ms cap
    stdin.write(JSON.stringify({ session_id: 's', cwd: CWD }));
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
    expect(out).toEqual([]); // no key, so nothing key-dependent
    expect(performance.now() - t).toBeLessThan(100);
    expect(listJobs(paths.jobs)).toHaveLength(1);
  });

  it('a key-cache miss with git slower than the 40 ms bound: no question in this session (the next one asks)', async () => {
    const paths = tmpHome();
    two(paths);
    const r = await run(paths, 'claude-code', 'SessionStart', {}, {
      resolveProjectKey: async (_cwd, opts) => {
        expect(opts).toMatchObject({ bounded: true });
        expect(opts.timeoutMs).toBeLessThanOrEqual(40);
        return null; // killed at the bound
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([]);
    expect(listJobs(paths.jobs)).toHaveLength(1); // the worker resolves the key and caches it for the next session
  });

  it('never prints in the summarizer', async () => {
    const paths = tmpHome();
    two(paths);
    const r = await run(paths, 'claude-code', 'SessionStart', {}, { env: { AI_OBS_SUMMARIZING: '1' } });
    expect(r.out).toEqual([]);
    expect(listJobs(paths.jobs)).toHaveLength(0);
  });
});
