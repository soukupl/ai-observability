import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDigest } from '../src/analysis/digest.js';
import {
  buildSummaryPrompt,
  parseSummaryResponse,
  pendingSummariesPath,
  runSummaryCommand,
  scrubPaths,
  summarizeAndQueue,
  summarizeWithCommand,
} from '../src/analysis/summaries.js';
import { createContext } from '../src/context.js';
import { nullLogger } from '../src/log.js';
import { writeJsonAtomic } from '../src/fsutil.js';
import type { IngestEvent } from '../src/protocol-types.js';
import type { StreamKey } from '../src/queue.js';
import { cleanupHomes, fakeAdapter, tmpHome, writeTestConfig } from './helpers.js';
import { OPEN } from './queue-helpers.js';

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

describe('summarizeAndQueue', () => {
  const KEY: StreamKey = { kind: 'project', pk: 'github.com/acme/billing', bind: OPEN };
  const OTHER: StreamKey = { kind: 'project', pk: 'github.com/acme/web', bind: OPEN };

  function ctxFor(summarize: (d: unknown[]) => Promise<Map<string, string>>) {
    const paths = tmpHome();
    const config = writeTestConfig(paths);
    const queued: IngestEvent[] = [];
    const calls: Array<{ events: IngestEvent[]; key: StreamKey | null }> = [];
    const adapter = fakeAdapter({ summarize: async (d) => summarize(d) });
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
    return { paths, ctx, queued, calls, adapter };
  }

  it('enqueues turn_summary events only (never digests) into the session stream', async () => {
    const { ctx, queued, calls } = ctxFor(async () => new Map([['turn-aaa', 'Added JWT refresh'], ['turn-bbb', 'Fixed flaky test']]));
    await ctx.summarizeTurns(digests, KEY);
    expect(calls.map((c) => c.key)).toEqual([KEY]);
    expect(queued.map((e) => e.type)).toEqual(['turn_summary', 'turn_summary']);
    expect(JSON.stringify(queued)).not.toContain('Add JWT refresh Add JWT');
  });

  it('stores failed digests and retries them on the next call', async () => {
    let fail = true;
    const { ctx, queued, paths } = ctxFor(async (d) => {
      if (fail) throw new Error('rate limited');
      return new Map((d as Array<{ turnId: string }>).map((x) => [x.turnId, `S ${x.turnId}`]));
    });
    await ctx.summarizeTurns(digests, KEY);
    expect(queued).toHaveLength(0);
    const pending = JSON.parse(readFileSync(pendingSummariesPath(paths.state, 'claude-code'), 'utf8')) as unknown[];
    expect(pending).toHaveLength(2);

    fail = false;
    await ctx.summarizeTurns([buildDigest({ turnId: 'turn-ccc', prompt: 'p', toolNames: [], lastAssistantMessage: 'm' })], KEY);
    expect(queued.map((e) => (e as { turn_id: string }).turn_id).sort()).toEqual(['turn-aaa', 'turn-bbb', 'turn-ccc']);
    expect(JSON.parse(readFileSync(pendingSummariesPath(paths.state, 'claude-code'), 'utf8'))).toEqual([]);
  });

  it('gives up after 5 attempts', async () => {
    const { ctx, paths } = ctxFor(async () => new Map());
    for (let i = 0; i < 6; i++) await ctx.summarizeTurns(i === 0 ? digests : [], KEY);
    expect(JSON.parse(readFileSync(pendingSummariesPath(paths.state, 'claude-code'), 'utf8'))).toEqual([]);
  });

  it('summarizeAndQueue reports counts', async () => {
    const { ctx, adapter } = ctxFor(async () => new Map([['turn-aaa', 'ok']]));
    expect(await summarizeAndQueue(adapter, digests, ctx, KEY)).toEqual({ summarized: 1, pending: 1 });
  });

  it('retried digests keep their own stream; summaries are enqueued grouped by stream', async () => {
    let fail = true;
    const { ctx, calls } = ctxFor(async (d) => {
      if (fail) throw new Error('rate limited');
      return new Map((d as Array<{ turnId: string }>).map((x) => [x.turnId, `S ${x.turnId}`]));
    });
    await ctx.summarizeTurns(digests, KEY);
    fail = false;
    await ctx.summarizeTurns([buildDigest({ turnId: 'turn-ccc', prompt: 'p', toolNames: [], lastAssistantMessage: 'm' })], OTHER);
    const byKey = calls.map((c) => [c.key, c.events.map((e) => (e as { turn_id: string }).turn_id).sort()]);
    expect(byKey).toEqual([
      [KEY, ['turn-aaa', 'turn-bbb']],
      [OTHER, ['turn-ccc']],
    ]);
  });

  it('drops pending digests written by 0.1.x (no stream) and new digests of an unrecorded session', async () => {
    const summarize = async (d: unknown[]) => new Map((d as Array<{ turnId: string }>).map((x) => [x.turnId, `S ${x.turnId}`]));
    const { ctx, calls, paths } = ctxFor(summarize);
    writeJsonAtomic(pendingSummariesPath(paths.state, 'claude-code'), [{ ...digests[0], attempts: 1, firstFailedAt: Date.now() }]);
    await ctx.summarizeTurns([digests[1]!], null);
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(pendingSummariesPath(paths.state, 'claude-code'), 'utf8'))).toEqual([]);
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
