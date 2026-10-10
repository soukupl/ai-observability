import { validateBatch } from '@ai-obs/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig } from '../../src/config.js';
import type { IngestEvent } from '../../src/protocol-types.js';
import { buildEnvelope } from '../../src/sender.js';
import { cleanupHomes } from '../helpers.js';
import { CHILD, codexTestEnv, copyFixtures, fixtureLines, ofType, SESSION, T1, T2, T3 } from './codex-helpers.js';

afterEach(() => cleanupHomes());

/** Event without its (deterministic but opaque) id and the constant harness. */
const strip = (e: IngestEvent) => {
  const { event_id: _id, harness, ...rest } = e;
  expect(harness).toBe('codex');
  return rest;
};

const usage = (model: string, effort: string, input: number, output: number, cacheRead: number, reasoning: number, requests: number) => ({
  model, effort, input, output, cache_read: cacheRead, cache_write: 0, reasoning, requests,
});

/*
 * Token math (fixtures/main-rollout.jsonl). Codex token_count events carry CUMULATIVE
 * total_token_usage; a request's usage = difference to the previous distinct snapshot. Codex counts
 * cached input inside input_tokens, ai-obs wants it apart: input = Δinput − Δcached.
 *
 *   T1 snapshots (input/cached/output/reasoning): 1000/200/100/40 → 2500/1200/250/90 → 4000/2600/400/120
 *      → (repeated 4000/2600/400/120: ignored) → 5000/3500/500/150
 *      deltas: 1000/200/100/40, 1500/1000/150/50, 1500/1400/150/30, 1000/900/100/30
 *      input = 800+500+100+100 = 1500, cache_read = 3500, output = 500, reasoning = 150, requests = 4
 *   T2: 5000/3500 → 6000/4200/600/170: input = 1000−700 = 300, cache_read 700, output 100, reasoning 20
 *   T3: → 7000/5000/700/200: input = 1000−800 = 200, cache_read 800, output 100, reasoning 30
 *   Sub-agent (child-rollout.jsonl, own totals): 800/0/60/20 → 2000/700/160/50
 *      input = 800 + (1200−700) = 1300, cache_read 700, output 160, reasoning 50, requests 2
 *   The T1 turn carries main + sub-agent usage (a turn's rows are its whole usage); the run carries
 *   only the sub-agent's.
 */
const T1_MAIN = usage('gpt-5.6-terra', 'medium', 1500, 500, 3500, 150, 4);
const CHILD_USAGE = usage('gpt-5.6-luna', 'low', 1300, 160, 700, 50, 2);

const EXPECTED = [
  { type: 'session_start', session_id: SESSION, harness_version: '0.154.0', project: { key: 'github.com/acme/app', name: 'app' }, at: '2026-10-05T09:59:58.000Z' },
  {
    type: 'turn', session_id: SESSION, turn_id: T1, started_at: '2026-10-05T10:00:00.000Z', ended_at: '2026-10-05T10:00:52.000Z',
    model: 'gpt-5.6-terra', effort: 'medium', usage: [T1_MAIN, CHILD_USAGE],
    // 0→2 thinking, 2→5 exploring (rg), 5→40 delegating (spawn_agent + wait_agent; dropped), 40→46 coding (apply_patch), 46→52 thinking
    phases_ms: { thinking: 8000, exploring: 3000, coding: 6000 },
    tools: { exec_command: 1, spawn_agent: 1, wait_agent: 1, apply_patch: 1 },
    files_touched: 2, lines_added: 6, lines_removed: 1,
    outcome: { status: 'unknown', signals: [], provisional: true }, phase_rules_version: 1,
  },
  {
    type: 'run', turn_id: T1, run_id: CHILD, parent_run_id: null, agent_type: 'explorer', agent_group: 'explorer', depth: 1,
    started_at: '2026-10-05T10:00:09.000Z', ended_at: '2026-10-05T10:00:39.000Z', model: 'gpt-5.6-luna', effort: 'low',
    usage: [CHILD_USAGE], phases_ms: { thinking: 27000, exploring: 3000 }, tools: { exec_command: 1 },
    outcome: { status: 'unknown', signals: [], provisional: true },
  },
  // next prompt "Now run the tests" is not a correction → T1 succeeded
  { type: 'turn_outcome', turn_id: T1, outcome: { status: 'success', signals: ['no_failure_signal'], provisional: false } },
  {
    type: 'turn', session_id: SESSION, turn_id: T2, started_at: '2026-10-05T10:05:00.000Z', ended_at: '2026-10-05T10:05:26.000Z',
    model: 'gpt-5.6-terra', effort: 'medium', usage: [usage('gpt-5.6-terra', 'medium', 300, 100, 700, 20, 1)],
    phases_ms: { thinking: 8000, testing: 18000 }, tools: { exec_command: 1 }, files_touched: 0, lines_added: 0, lines_removed: 0,
    outcome: { status: 'failed', signals: ['tests_failed'], provisional: true }, phase_rules_version: 1,
  },
  // next prompt "no, that's wrong …" is a correction
  { type: 'turn_outcome', turn_id: T2, outcome: { status: 'failed', signals: ['tests_failed', 'next_prompt_correction'], provisional: false } },
  {
    type: 'turn', session_id: SESSION, turn_id: T3, started_at: '2026-10-05T10:10:00.000Z', ended_at: '2026-10-05T10:10:31.000Z',
    model: 'gpt-5.6-terra', effort: 'medium', usage: [usage('gpt-5.6-terra', 'medium', 200, 100, 800, 30, 1)],
    // `pnpm vitest run` keeps running; write_stdin polls the same process → still testing until the abort
    phases_ms: { testing: 31000 }, tools: { exec_command: 1, write_stdin: 1 }, files_touched: 0, lines_added: 0, lines_removed: 0,
    outcome: { status: 'abandoned', signals: ['user_interrupt'], provisional: true }, phase_rules_version: 1,
  },
  { type: 'turn_outcome', turn_id: T3, outcome: { status: 'abandoned', signals: ['user_interrupt'], provisional: false } },
  { type: 'session_end', session_id: SESSION, reason: 'exit', at: '2026-10-05T10:15:00.000Z' },
  // fake `codex exec` answer; the path in the t1 summary is reduced to its last segment
  { type: 'turn_summary', turn_id: T1, summary: 'Added a retry helper via retry.ts' },
  { type: 'turn_summary', turn_id: T2, summary: 'Ran the test suite' },
  { type: 'turn_summary', turn_id: T3, summary: 'Re-ran tests' },
];

describe('codex adapter: synthetic 3-turn rollout', () => {
  it('produces the exact events (sub-agent run, failing tests, interrupt, corrections, summaries)', async () => {
    const env = codexTestEnv();
    copyFixtures(env);
    await env.hook('SessionStart', { source: 'startup' }, '2026-10-05T09:59:59Z');
    await env.hook('SessionEnd', { reason: 'other' }, '2026-10-05T10:15:00Z');
    expect(env.events.map(strip)).toEqual(EXPECTED);
  });

  it('every event passes the protocol validator and carries no prompt / path', async () => {
    const env = codexTestEnv();
    copyFixtures(env);
    await env.hook('SessionStart', {});
    await env.hook('SessionEnd', {});
    const batch = buildEnvelope(buildConfig({ endpoint: 'https://obs.example.com', token: 'aiobs_u_x' }), env.events);
    const r = validateBatch(JSON.parse(JSON.stringify(batch)));
    expect(r.ok && r.rejected).toEqual([]);
    const wire = JSON.stringify(env.events);
    for (const secret of ['/work/acme-app', 'src/retry', 'Now run the tests', 'pnpm test', 'Add a retry helper', 'README']) expect(wire).not.toContain(secret);
  });

  it('is idempotent: replaying the same hooks on a fresh state yields the same event ids', async () => {
    const a = codexTestEnv();
    copyFixtures(a);
    await a.hook('SessionStart', {});
    await a.hook('SessionEnd', {}, '2026-10-05T10:15:00Z');
    const b = codexTestEnv();
    copyFixtures(b);
    await b.hook('SessionStart', {});
    await b.hook('SessionEnd', {}, '2026-10-05T10:15:00Z');
    const ids = (e: IngestEvent[]) => e.filter((x) => x.type !== 'turn_summary').map((x) => x.event_id);
    expect(ids(b.events)).toEqual(ids(a.events));
  });
});

describe('codex adapter: incremental processing', () => {
  const lines = fixtureLines('main-rollout.jsonl');
  const idx = (pred: (l: string) => boolean, from = 0) => lines.findIndex((l, i) => i >= from && pred(l));
  const t1Complete = idx((l) => l.includes('"task_complete"'));
  const t2Start = idx((l) => l.includes(`"task_started","turn_id":"${T2}"`));

  it('resumes from the byte cursor: a half-written line waits, nothing is emitted twice', async () => {
    const env = codexTestEnv();
    env.writeChild(fixtureLines('child-rollout.jsonl'));
    const head = lines.slice(0, t1Complete + 1);
    const partial = lines[t1Complete + 1]!;
    env.writeMain(head);
    // append a half-written line (no newline yet)
    const { appendFileSync } = await import('node:fs');
    appendFileSync(env.mainPath, partial.slice(0, 20));
    await env.hook('SessionStart', {});
    await env.hook('Stop', { turn_id: T1, last_assistant_message: 'x' });
    expect(env.events.map((e) => e.type)).toEqual(['session_start', 'turn', 'run']);

    env.writeMain(lines); // the rest arrives (incl. the completed half line)
    await env.hook('Stop', { turn_id: T2 });
    expect(env.events.map((e) => e.type)).toEqual(['session_start', 'turn', 'run', 'turn_outcome', 'turn', 'turn_outcome', 'turn']);
    expect(ofType(env.events, 'turn').map((t) => t.turn_id)).toEqual([T1, T2, T3]);
    const state = env.ctx.state.get<{ offset: number }>(SESSION)!;
    expect(state.offset).toBe(lines.join('\n').length + 1);
  });

  it('Stop before task_complete reaches the rollout: closes the turn at the hook time; the late record is ignored', async () => {
    const env = codexTestEnv();
    env.writeChild(fixtureLines('child-rollout.jsonl'));
    env.writeMain(lines.slice(0, t1Complete)); // no task_complete yet
    await env.hook('Stop', { turn_id: T1, last_assistant_message: 'Added it.' }, '2026-10-05T10:00:53Z');
    const [turn] = ofType(env.events, 'turn');
    expect(turn?.turn_id).toBe(T1);
    expect(turn?.ended_at).toBe('2026-10-05T10:00:53.000Z');
    env.writeMain(lines.slice(0, t2Start));
    await env.hook('UserPromptSubmit', { turn_id: T2, prompt: 'thanks, now run the tests' });
    expect(ofType(env.events, 'turn')).toHaveLength(1);
    expect(ofType(env.events, 'turn_outcome').map((o) => o.outcome.status)).toEqual(['success']);
  });

  it('UserPromptSubmit decides the previous outcome before the rollout shows the new turn', async () => {
    const env = codexTestEnv();
    env.writeChild(fixtureLines('child-rollout.jsonl'));
    env.writeMain(lines.slice(0, t1Complete + 1));
    await env.hook('Stop', { turn_id: T1 });
    await env.hook('UserPromptSubmit', { turn_id: T2, prompt: 'No, revert that — it is broken' });
    expect(ofType(env.events, 'turn_outcome')).toEqual([
      expect.objectContaining({ turn_id: T1, outcome: { status: 'failed', signals: ['next_prompt_correction'], provisional: false } }),
    ]);
    env.writeMain(lines); // the rollout catches up: T1 is not patched twice
    await env.hook('Stop', { turn_id: T2 });
    expect(ofType(env.events, 'turn_outcome').filter((o) => o.turn_id === T1)).toHaveLength(1);
  });

  it('a sub-agent that finishes after the parent turn: SubagentStop emits the run and re-sends the turn with merged usage', async () => {
    const env = codexTestEnv();
    env.writeMain(lines.slice(0, t1Complete + 1)); // child rollout does not exist yet
    await env.hook('Stop', { turn_id: T1 });
    const first = ofType(env.events, 'turn')[0]!;
    expect(first.usage).toEqual([T1_MAIN]);
    expect(ofType(env.events, 'run')).toHaveLength(0);

    env.writeChild(fixtureLines('child-rollout.jsonl'));
    await env.hook('SubagentStop', { turn_id: T1, agent_id: CHILD, agent_type: 'explorer', agent_transcript_path: env.childPath });
    const runs = ofType(env.events, 'run');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_id: CHILD, turn_id: T1, parent_run_id: null, depth: 1, usage: [CHILD_USAGE] });
    const turns = ofType(env.events, 'turn');
    expect(turns).toHaveLength(2);
    expect(turns[1]!.usage).toEqual([T1_MAIN, CHILD_USAGE]);
    expect(turns[1]!.event_id).not.toBe(first.event_id);

    // a repeated SubagentStop with nothing new does not re-send
    await env.hook('SubagentStop', { turn_id: T1, agent_id: CHILD, agent_transcript_path: env.childPath });
    expect(ofType(env.events, 'turn')).toHaveLength(2);
  });

  it('hooks of a sub-agent thread itself are ignored (its usage arrives via the parent)', async () => {
    const env = codexTestEnv();
    env.writeChild(fixtureLines('child-rollout.jsonl'));
    await env.hook('SessionStart', { session_id: CHILD, transcript_path: env.childPath });
    await env.hook('Stop', { session_id: CHILD, transcript_path: env.childPath });
    expect(env.events).toEqual([]);
  });

  it('sweep ends a session idle for > 1 h with reason "crashed" and finalizes its last turn', async () => {
    const early = codexTestEnv({ now: '2026-10-05T10:06:00Z' });
    copyFixtures(early);
    early.writeMain(lines.slice(0, idx((l) => l.includes(`"task_complete","turn_id":"${T2}"`)) + 1));
    await early.hook('Stop', { turn_id: T2 }, '2026-10-05T10:05:27Z');
    expect(early.events.some((e) => e.type === 'session_end')).toBe(false);

    // same homes, two hours later
    const { utimesSync } = await import('node:fs');
    utimesSync(early.mainPath, new Date('2026-10-05T10:05:27Z'), new Date('2026-10-05T10:05:27Z'));
    const later = { ...early.ctx, now: () => new Date('2026-10-05T12:10:00Z') };
    await early.adapter.sweepCrashedSessions(later);
    const end = ofType(early.events, 'session_end');
    expect(end).toEqual([expect.objectContaining({ reason: 'crashed', at: '2026-10-05T10:05:27.000Z' })]);
    // last turn has no next prompt → final keeps its status
    expect(ofType(early.events, 'turn_outcome').at(-1)).toMatchObject({ turn_id: T2, outcome: { status: 'failed', signals: ['tests_failed'], provisional: false } });
    expect(ofType(early.events, 'turn_summary').length).toBe(2);
  });
});

describe('codex adapter: mid-session summaries (ADR-0023)', () => {
  const lines = fixtureLines('main-rollout.jsonl');
  const t1Complete = lines.findIndex((l) => l.includes('"task_complete"'));

  it('summarizes a waiting turn once it has waited 10 minutes, not before', async () => {
    const env = codexTestEnv();
    env.writeChild(fixtureLines('child-rollout.jsonl'));
    env.writeMain(lines.slice(0, t1Complete + 1));
    await env.hook('Stop', { turn_id: T1, last_assistant_message: 'Added it.' }, '2026-10-05T10:00:53Z');
    expect(ofType(env.events, 'turn').map((t) => t.turn_id)).toEqual([T1]);
    expect(ofType(env.events, 'turn_summary')).toHaveLength(0);

    await env.hook('Stop', { turn_id: T1 }, '2026-10-05T10:02:53Z'); // 2 minutes: still waiting
    expect(ofType(env.events, 'turn_summary')).toHaveLength(0);

    await env.hook('Stop', { turn_id: T1 }, '2026-10-05T10:11:53Z'); // 11 minutes after the wait began
    expect(ofType(env.events, 'turn_summary').map((s) => s.turn_id)).toEqual([T1]);
    const state = env.ctx.state.get<{ digests: unknown[]; digestsSince?: number }>(SESSION)!;
    expect(state.digests).toEqual([]);
    expect(state.digestsSince).toBeUndefined();
  });
});
