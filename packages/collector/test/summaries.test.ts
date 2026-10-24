import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDigest } from '../src/analysis/digest.js';
import {
  buildSummaryPrompt,
  countStagedDigests,
  listStagedDigests,
  parseSummaryResponse,
  pendingSummariesPath,
  runSummaryBatch,
  runSummaryCommand,
  scrubPaths,
  stagedSummariesDir,
  stageDigests,
  SUMMARY_CHUNK,
  summarizeWithCommand,
} from '../src/analysis/summaries.js';
import { createContext } from '../src/context.js';
import { nullLogger } from '../src/log.js';
import { writeJsonAtomic } from '../src/fsutil.js';
import type { IngestEvent } from '../src/protocol-types.js';
import type { StreamKey } from '../src/queue.js';
import { cleanupHomes, fakeAdapter, tmpHome, writeTestConfig } from './helpers.js';

afterEach(cleanupHomes);

const digests = [
  buildDigest({ turnId: 'turn-aaa', prompt: 'Add JWT refresh '.repeat(40), toolNames: ['Read', 'Edit', 'Edit', 'Bash'], lastAssistantMessage: 'Done.' }),
  buildDigest({ turnId: 'turn-bbb', prompt: 'Fix flaky test', toolNames: [], lastAssistantMessage: 'x'.repeat(1000) }),
];

describe('digest', () => {
  it('truncates prompt and last message to 300 chars and de-dupes tools', () => {
    expect(digests[0]!.prompt.length).toBeLessThanOrEqual(300);
    expect(digests[1]!.lastAssistantMessage.length).toBe(300);
    expect(digests[0]!.tools).toEqual(['Read', 'Edit', 'Bash']);
  });
});

describe('summary prompt', () => {
  it('is one batched prompt with short ids', () => {
    const { prompt, ids } = buildSummaryPrompt(digests);
    expect(prompt).toContain('"id":"t1"');
    expect(prompt).toContain('"id":"t2"');
    expect(prompt).toContain('140 characters');
    expect(prompt).not.toContain('turn-aaa');
    expect(ids.get('t2')).toBe('turn-bbb');
  });

  const ids = new Map([['t1', 'turn-aaa'], ['t2', 'turn-bbb']]);
  it.each([
    ['plain object', '{"t1": "Added JWT refresh", "t2": "Fixed flaky test"}'],
    ['fenced with prose', 'Sure!\n```json\n{"t1": "Added JWT refresh", "t2": "Fixed flaky test"}\n```\nHope this helps.'],
    ['array form', '[{"id":"t1","summary":"Added JWT refresh"},{"id":"t2","summary":"Fixed flaky test"}]'],
    ['wrapped', '{"summaries": {"t1": "Added JWT refresh", "t2": "Fixed flaky test"}}'],
    ['lines', 't1: Added JWT refresh\nt2: "Fixed flaky test"'],
  ])('parses %s', (_name, text) => {
    const r = parseSummaryResponse(text, ids);
    expect(Object.fromEntries(r)).toEqual({ 'turn-aaa': 'Added JWT refresh', 'turn-bbb': 'Fixed flaky test' });
  });

  it('truncates to 140 chars, ignores unknown ids and garbage', () => {
    const r = parseSummaryResponse(JSON.stringify({ t1: 'a'.repeat(500), t9: 'x', t2: 42 }), ids);
    expect(r.get('turn-aaa')!.length).toBe(140);
    expect(r.size).toBe(1);
    expect(parseSummaryResponse('I cannot help with that.', ids).size).toBe(0);
  });

  it('scrubs file paths but keeps prose', () => {
    expect(scrubPaths('Fixed bug in /Users/dev/app/src/auth.ts and src/db/pool.ts')).toBe('Fixed bug in auth.ts and pool.ts');
    expect(scrubPaths('Updated login/logout flow (see ~/notes/x.md).')).toBe('Updated login/logout flow (see x.md).');
  });
});

describe('runSummaryCommand', () => {
  it('passes the prompt on stdin and sets AI_OBS_SUMMARIZING=1', async () => {
    const r = await runSummaryCommand({
      argv: [process.execPath, '-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(process.env.AI_OBS_SUMMARIZING+":"+s))'],
      input: 'hello',
    });
    expect(r).toMatchObject({ ok: true, stdout: '1:hello' });
  });

  it('times out and kills the process', async () => {
    const t = Date.now();
    const r = await runSummaryCommand({ argv: [process.execPath, '-e', 'setTimeout(()=>{}, 60000)'], timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('reports a missing binary without throwing', async () => {
    const r = await runSummaryCommand({ argv: ['definitely-not-a-binary-xyz'] });
    expect(r.ok).toBe(false);
  });

  it('summarizeWithCommand runs one batched call and parses it', async () => {
    const script = 'process.stdout.write(JSON.stringify({t1:"Added JWT refresh",t2:"Fixed flaky test"}))';
    const r = await summarizeWithCommand(digests, { command: () => ({ argv: [process.execPath, '-e', script] }) });
    expect(r.get('turn-bbb')).toBe('Fixed flaky test');
  });
});

describe('staged summaries (ADR-0027)', () => {
  const KEY: StreamKey = { kind: 'project', pk: 'github.com/acme/billing', endpoint: 'http://127.0.0.1:9', team: '' };
  const OTHER: StreamKey = { kind: 'project', pk: 'github.com/acme/web', endpoint: 'http://127.0.0.1:9', team: '' };

  function ctxFor(summarize: (d: unknown[]) => Promise<Map<string, string>>) {
    const paths = tmpHome();
    const config = writeTestConfig(paths);
    const queued: IngestEvent[] = [];
    const calls: Array<{ events: IngestEvent[]; key: StreamKey | null }> = [];
    let summarizeCalls = 0;
    const adapter = fakeAdapter({
      summarize: async (d) => {
        summarizeCalls++;
        return summarize(d);
      },
    });
    const ctx = createContext({
      adapter,
      config,
      paths,
      queue: {
        enqueue: (e, key) => {
          queued.push(...e);
          calls.push({ events: [...e], key });
        },
      },
      log: nullLogger,
    });
    /** the worker's summary phase, committing into ctx.queue */
    const run = (opts: { retry?: boolean; commit?: boolean; deadline?: number; chunkTimeoutMs?: number } = {}) =>
      runSummaryBatch(adapter, ctx, {
        ...(opts.retry ? { retry: true } : {}),
        ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
        ...(opts.chunkTimeoutMs !== undefined ? { chunkTimeoutMs: opts.chunkTimeoutMs } : {}),
        commit: async (gs) => {
          if (opts.commit === false) return false;
          for (const g of gs) ctx.queue.enqueue(g.events, g.key);
          return true;
        },
      });
    const pendingFile = pendingSummariesPath(paths.state, 'claude-code');
    return { paths, ctx, queued, calls, adapter, run, pendingFile, summarizeCalls: () => summarizeCalls };
  }

  it('enqueues turn_summary events only (never digests) into the session stream', async () => {
    const { ctx, queued, calls, run } = ctxFor(async () => new Map([['turn-aaa', 'Added JWT refresh'], ['turn-bbb', 'Fixed flaky test']]));
    expect(ctx.scheduleSummaries(digests, KEY)).toBe(true);
    await run();
    expect(calls.map((c) => c.key)).toEqual([KEY]);
    expect(queued.map((e) => e.type)).toEqual(['turn_summary', 'turn_summary']);
    expect(JSON.stringify(queued)).not.toContain('Add JWT refresh Add JWT');
    expect(listStagedDigests(ctx.paths.state, 'claude-code')).toEqual([]);
  });

  it('stageDigests: one file per call (mode 0600, attempts 0, the key); a null key or no digests writes nothing', () => {
    const paths = tmpHome();
    stageDigests(paths.state, 'claude-code', digests, KEY, 1_000, nullLogger);
    stageDigests(paths.state, 'claude-code', [digests[1]!], OTHER, 2_000, nullLogger);
    stageDigests(paths.state, 'claude-code', [digests[0]!], null, 3_000, nullLogger);
    stageDigests(paths.state, 'claude-code', [], KEY, 4_000, nullLogger);
    const files = listStagedDigests(paths.state, 'claude-code');
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.startsWith(stagedSummariesDir(paths.state, 'claude-code')))).toBe(true);
    expect(files.map((f) => statSync(f).mode & 0o777)).toEqual([0o600, 0o600]);
    const first = JSON.parse(readFileSync(files[0]!, 'utf8')) as Array<Record<string, unknown>>;
    expect(first.map((d) => [d.turnId, d.attempts, d.firstFailedAt, d.key])).toEqual([
      ['turn-aaa', 0, 1_000, KEY],
      ['turn-bbb', 0, 1_000, KEY],
    ]);
    expect(countStagedDigests(paths.state, 'claude-code')).toBe(3);
    expect(countStagedDigests(paths.state, 'codex')).toBe(0);
  });

  it('stores failed digests and retries them on the next run', async () => {
    let fail = true;
    const { ctx, queued, run, pendingFile } = ctxFor(async (d) => {
      if (fail) throw new Error('rate limited');
      return new Map((d as Array<{ turnId: string }>).map((x) => [x.turnId, `S ${x.turnId}`]));
    });
    ctx.scheduleSummaries(digests, KEY);
    await run();
    expect(queued).toHaveLength(0);
    expect(JSON.parse(readFileSync(pendingFile, 'utf8')) as unknown[]).toHaveLength(2);
    expect(listStagedDigests(ctx.paths.state, 'claude-code')).toEqual([]);

    fail = false;
    ctx.scheduleSummaries([buildDigest({ turnId: 'turn-ccc', prompt: 'p', toolNames: [], lastAssistantMessage: 'm' })], KEY);
    await run();
    expect(queued.map((e) => (e as { turn_id: string }).turn_id).sort()).toEqual(['turn-aaa', 'turn-bbb', 'turn-ccc']);
    expect(JSON.parse(readFileSync(pendingFile, 'utf8'))).toEqual([]);
  });

  it('a digest staged again merges by turnId and keeps its attempts', async () => {
    const { ctx, run, pendingFile } = ctxFor(async () => new Map());
    const failedAt = Date.now() - 3600_000;
    writeJsonAtomic(pendingFile, [{ ...digests[0], attempts: 2, firstFailedAt: failedAt, key: KEY }]);
    ctx.scheduleSummaries([digests[0]!], KEY);
    await run();
    const pending = JSON.parse(readFileSync(pendingFile, 'utf8')) as Array<{ turnId: string; attempts: number; firstFailedAt: number }>;
    expect(pending.map((p) => [p.turnId, p.attempts, p.firstFailedAt])).toEqual([['turn-aaa', 3, failedAt]]);
  });

  it('a refused commit leaves the staged and pending files byte-identical', async () => {
    const { ctx, run, pendingFile, queued } = ctxFor(async (d) => new Map((d as Array<{ turnId: string }>).map((x) => [x.turnId, `S ${x.turnId}`])));
    writeJsonAtomic(pendingFile, [{ ...digests[1], attempts: 1, firstFailedAt: Date.now(), key: OTHER }]);
    ctx.scheduleSummaries([digests[0]!], KEY);
    const [staged] = listStagedDigests(ctx.paths.state, 'claude-code');
    const before = [readFileSync(staged!, 'utf8'), readFileSync(pendingFile, 'utf8')];
    expect(await run({ commit: false })).toBeNull();
    expect([readFileSync(staged!, 'utf8'), readFileSync(pendingFile, 'utf8')]).toEqual(before);
    expect(queued).toEqual([]);
  });

  it('nothing staged and no retry: null, the model is not called', async () => {
    const { run, pendingFile, summarizeCalls } = ctxFor(async () => new Map([['turn-aaa', 'x']]));
    writeJsonAtomic(pendingFile, [{ ...digests[0], attempts: 1, firstFailedAt: Date.now(), key: KEY }]);
    expect(await run()).toBeNull();
    expect(summarizeCalls()).toBe(0);
    expect(await run({ retry: true })).toEqual({ summarized: 1, pending: 0 });
  });

  it('a chunk that hangs counts as a failed attempt; the batch still commits and clears the staged files', async () => {
    const { ctx, run, pendingFile } = ctxFor(() => new Promise(() => {}));
    ctx.scheduleSummaries(digests, KEY);
    expect(await run({ chunkTimeoutMs: 50 })).toEqual({ summarized: 0, pending: 2 });
    const pending = JSON.parse(readFileSync(pendingFile, 'utf8')) as Array<{ turnId: string; attempts: number }>;
    expect(pending.map((p) => [p.turnId, p.attempts])).toEqual([
      ['turn-aaa', 1],
      ['turn-bbb', 1],
    ]);
    expect(listStagedDigests(ctx.paths.state, 'claude-code')).toEqual([]);
  });

  it('past the deadline no chunk starts: what was summarised is committed, the rest waits as pending without an attempt', async () => {
    const many = Array.from({ length: SUMMARY_CHUNK + 3 }, (_, i) => buildDigest({ turnId: `turn-${String(i).padStart(3, '0')}`, prompt: 'p', toolNames: [], lastAssistantMessage: 'm' }));
    let deadline = Number.POSITIVE_INFINITY;
    const { ctx, adapter, pendingFile, queued, summarizeCalls } = ctxFor(async (d) => {
      deadline = 0; // the first chunk used up the time
      return new Map((d as Array<{ turnId: string }>).map((x) => [x.turnId, `S ${x.turnId}`]));
    });
    ctx.scheduleSummaries(many, KEY);
    const res = await runSummaryBatch(adapter, ctx, {
      get deadline() {
        return deadline;
      },
      commit: async (gs) => {
        for (const g of gs) ctx.queue.enqueue(g.events, g.key);
        return true;
      },
    });
    expect(res).toEqual({ summarized: SUMMARY_CHUNK, pending: 3 });
    expect(summarizeCalls()).toBe(1);
    expect(queued).toHaveLength(SUMMARY_CHUNK);
    const pending = JSON.parse(readFileSync(pendingFile, 'utf8')) as Array<{ attempts: number }>;
    expect(pending.map((p) => p.attempts)).toEqual([0, 0, 0]);
    expect(listStagedDigests(ctx.paths.state, 'claude-code')).toEqual([]);
  });

  it('a staged digest older than 7 days is dropped like a pending one', async () => {
    const { ctx, run, pendingFile, summarizeCalls } = ctxFor(async () => new Map([['turn-aaa', 'x']]));
    stageDigests(ctx.paths.state, 'claude-code', [digests[0]!], KEY, Date.now() - 8 * 24 * 3600_000, nullLogger);
    expect(await run()).toEqual({ summarized: 0, pending: 0 });
    expect(summarizeCalls()).toBe(0);
    expect(JSON.parse(readFileSync(pendingFile, 'utf8'))).toEqual([]);
    expect(listStagedDigests(ctx.paths.state, 'claude-code')).toEqual([]);
  });

  it('gives up after 5 attempts', async () => {
    const { ctx, run, pendingFile } = ctxFor(async () => new Map());
    ctx.scheduleSummaries(digests, KEY);
    for (let i = 0; i < 6; i++) await run({ retry: true });
    expect(JSON.parse(readFileSync(pendingFile, 'utf8'))).toEqual([]);
  });

  it('a turn_summary keeps its event id across runs (time = the digest\'s firstFailedAt)', async () => {
    const { ctx, run } = ctxFor(async () => new Map([['turn-aaa', 'Added JWT refresh']]));
    ctx.scheduleSummaries([digests[0]!], KEY);
    const ids: string[][] = [];
    for (const commit of [false, true]) {
      await runSummaryBatch(fakeAdapter({ summarize: async () => new Map([['turn-aaa', 'Added JWT refresh']]) }), ctx, {
        commit: async (gs) => {
          ids.push(gs.flatMap((g) => g.events.map((e) => e.event_id)));
          return commit;
        },
      });
    }
    expect(ids[0]).toHaveLength(1);
    expect(ids[1]).toEqual(ids[0]);
    expect(await run()).toBeNull(); // committed: nothing staged any more
  });

  it('reports counts', async () => {
    const { ctx, run } = ctxFor(async () => new Map([['turn-aaa', 'ok']]));
    ctx.scheduleSummaries(digests, KEY);
    expect(await run()).toEqual({ summarized: 1, pending: 1 });
  });

  it('retried digests keep their own stream; summaries are grouped by stream', async () => {
    let fail = true;
    const { ctx, calls, run } = ctxFor(async (d) => {
      if (fail) throw new Error('rate limited');
      return new Map((d as Array<{ turnId: string }>).map((x) => [x.turnId, `S ${x.turnId}`]));
    });
    ctx.scheduleSummaries(digests, KEY);
    await run();
    fail = false;
    ctx.scheduleSummaries([buildDigest({ turnId: 'turn-ccc', prompt: 'p', toolNames: [], lastAssistantMessage: 'm' })], OTHER);
    await run();
    const byKey = calls.map((c) => [c.key, c.events.map((e) => (e as { turn_id: string }).turn_id).sort()]);
    expect(byKey).toEqual([
      [KEY, ['turn-aaa', 'turn-bbb']],
      [OTHER, ['turn-ccc']],
    ]);
  });

  it('drops pending digests written by 0.1.x (no stream) and new digests of an unrecorded session', async () => {
    const summarize = async (d: unknown[]) => new Map((d as Array<{ turnId: string }>).map((x) => [x.turnId, `S ${x.turnId}`]));
    const { ctx, calls, run, pendingFile } = ctxFor(summarize);
    writeJsonAtomic(pendingFile, [{ ...digests[0], attempts: 1, firstFailedAt: Date.now() }]);
    expect(ctx.scheduleSummaries([digests[1]!], null)).toBe(true);
    expect(listStagedDigests(ctx.paths.state, 'claude-code')).toEqual([]);
    await run({ retry: true });
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(pendingFile, 'utf8'))).toEqual([]);
  });

  it('an unreadable staged file is dropped', async () => {
    const { ctx, run } = ctxFor(async () => new Map());
    ctx.scheduleSummaries(digests, KEY);
    const [staged] = listStagedDigests(ctx.paths.state, 'claude-code');
    writeFileSync(staged!, '{not json');
    expect(await run()).toEqual({ summarized: 0, pending: 0 });
    expect(listStagedDigests(ctx.paths.state, 'claude-code')).toEqual([]);
  });
});

describe('summariesDue (ADR-0023)', async () => {
  const { summariesDue, SUMMARY_BATCH, SUMMARY_MAX_WAIT_MS } = await import('../src/analysis/summaries.js');
  const t0 = 1_700_000_000_000;
  it('nothing pending → never', () => {
    expect(summariesDue({ ended: true, pending: 0, since: t0, now: t0 + SUMMARY_MAX_WAIT_MS * 2 })).toBe(false);
  });
  it('session ended → due', () => {
    expect(summariesDue({ ended: true, pending: 1, since: t0, now: t0 })).toBe(true);
  });
  it('a full batch → due', () => {
    expect(summariesDue({ ended: false, pending: SUMMARY_BATCH, since: t0, now: t0 })).toBe(true);
    expect(summariesDue({ ended: false, pending: SUMMARY_BATCH - 1, since: t0, now: t0 })).toBe(false);
  });
  it('the oldest has waited 10 minutes → due; an unknown wait start is not', () => {
    expect(summariesDue({ ended: false, pending: 1, since: t0, now: t0 + SUMMARY_MAX_WAIT_MS })).toBe(true);
    expect(summariesDue({ ended: false, pending: 1, since: t0, now: t0 + SUMMARY_MAX_WAIT_MS - 1 })).toBe(false);
    expect(summariesDue({ ended: false, pending: 1, since: undefined, now: t0 + SUMMARY_MAX_WAIT_MS * 2 })).toBe(false);
  });
});
