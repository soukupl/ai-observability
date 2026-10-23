import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IngestEvent, RunEvent, TurnEvent } from '../../src/protocol-types.js';
import { cleanupHomes } from '../helpers.js';
import { at, SESSION, TranscriptBuilder, text, threeTurnSession, toolUse, writeSession } from './fixture.js';
import { assertValid, byType, setup } from './helpers.js';

afterEach(cleanupHomes);

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5';
const u = (model: string, effort: string | null, input: number, output: number, cache_read: number, cache_write: number, reasoning: number, requests: number) => ({
  model, effort, input, output, cache_read, cache_write, reasoning, requests,
});

/** whole transcript, one Stop, SessionEnd */
async function runWhole() {
  const h = setup();
  const fx = threeTurnSession();
  writeSession(h.projectDir, fx);
  await h.hook('SessionStart', at(-1), { source: 'startup' });
  await h.hook('Stop', at(406.5));
  await h.hook('SessionEnd', at(600), { reason: 'prompt_input_exit' });
  return h;
}

const sortById = (events: IngestEvent[]) => [...events].sort((a, b) => a.event_id.localeCompare(b.event_id));
const turn = (events: IngestEvent[], id: string) => byType(events, 'turn').find((t) => t.turn_id === id) as TurnEvent;
const sumPhases = (p: Record<string, number | undefined>) => Object.values(p).reduce<number>((a, b) => a + (b ?? 0), 0);

describe('claude-code adapter: 3-turn session', () => {
  it('emits exactly the expected session, turn, run and outcome events', async () => {
    const h = await runWhole();
    const ev = h.events;
    assertValid(ev);
    expect(ev.map((e) => e.type)).toEqual([
      'session_start', // SessionStart
      'turn', 'run', 'run', // Stop: turn 1 + sub-agents
      'turn_outcome', 'turn', // turn 1 settled by turn 2's prompt, turn 2
      'turn_outcome', 'turn', // turn 2 corrected by turn 3's prompt, turn 3
      'turn_outcome', 'session_end', // SessionEnd
      'turn_summary', 'turn_summary', 'turn_summary', // one batched headless call (fake here)
    ]);

    const [start] = byType(ev, 'session_start');
    expect(start).toMatchObject({ session_id: SESSION, harness_version: '2.1.289', project: { key: 'github.com/acme/billing', name: 'billing' } });
    expect(start!.at).toBe(new Date(at(-1)).toISOString());

    // ---- turn 1: tokens = main (4 responses, each written as 1–2 entries) + sub-agents
    const t1 = turn(ev, 'cc-fixture-turn-1');
    expect(t1).toMatchObject({
      session_id: SESSION,
      started_at: new Date(at(0)).toISOString(),
      ended_at: new Date(at(30)).toISOString(),
      model: OPUS,
      effort: 'xhigh',
      tools: { read: 1, agent: 1, edit: 1 },
      files_touched: 1,
      lines_added: 2,
      lines_removed: 1,
      outcome: { status: 'unknown', signals: [], provisional: true },
      phase_rules_version: 1,
    });
    expect(t1.usage).toEqual([
      u(OPUS, 'xhigh', 20, 180, 4900, 350, 20, 4), // de-duplicated: msg_1 has 2 entries
      u(HAIKU, 'xhigh', 128, 112, 1020, 500, 0, 3), // sub-agent a1 (msg_s3 written twice)
      u(HAIKU, null, 7, 9, 0, 0, 0, 1), // nested a2
    ]);
    // delegating (16 s waiting for the Explore agent) is excluded from the parent
    expect(t1.phases_ms).toEqual({ thinking: 6000, exploring: 3000, coding: 5000 });
    expect(sumPhases(t1.phases_ms)).toBe(30_000 - 16_000);

    const runs = byType(ev, 'run') as RunEvent[];
    expect(runs.map((r) => [r.run_id, r.parent_run_id, r.depth, r.agent_type, r.turn_id])).toEqual([
      ['a1', null, 1, 'Explore', 'cc-fixture-turn-1'],
      ['a2', 'a1', 2, 'Explore', 'cc-fixture-turn-1'],
    ]);
    expect(runs.map((r) => r.agent_group)).toEqual(['Explore', 'Explore']);
    expect(runs[0]!.orchestration_id).toBeUndefined();
    expect(runs[0]).toMatchObject({
      model: HAIKU,
      effort: 'xhigh',
      started_at: new Date(at(9)).toISOString(),
      ended_at: new Date(at(20)).toISOString(),
      usage: [u(HAIKU, 'xhigh', 128, 112, 1020, 500, 0, 3)],
      phases_ms: { exploring: 5000, thinking: 1000 }, // its own 5 s waiting for a2 is delegating
      tools: { grep: 1, agent: 1 },
      outcome: { status: 'success', signals: ['no_failure_signal'], provisional: false },
    });
    expect(runs[1]).toMatchObject({ usage: [u(HAIKU, null, 7, 9, 0, 0, 0, 1)], phases_ms: { thinking: 2000 } });

    // ---- turn 2: interrupted during `npm test`
    const t2 = turn(ev, 'cc-fixture-turn-2');
    expect(t2).toMatchObject({
      usage: [u(OPUS, 'xhigh', 4, 40, 1500, 10, 0, 1)],
      phases_ms: { testing: 10_000 },
      tools: { bash: 1 },
      outcome: { status: 'abandoned', signals: ['user_interrupt'], provisional: true },
    });

    // ---- turn 3: failing then passing tests, a docs file written
    const t3 = turn(ev, 'cc-fixture-turn-3');
    expect(t3).toMatchObject({
      usage: [u(OPUS, 'xhigh', 11, 200, 9000, 50, 0, 5)],
      phases_ms: { coding: 5000, testing: 29_000, documenting: 6000, thinking: 5000 },
      tools: { edit: 1, bash: 2, write: 1 },
      files_touched: 2,
      lines_added: 4,
      lines_removed: 1,
      outcome: { status: 'success', signals: ['tests_passed'], provisional: true },
    });
    expect(sumPhases(t3.phases_ms)).toBe(at(405) - at(360));

    // ---- outcome patches
    expect(byType(ev, 'turn_outcome').map((p) => [p.turn_id, p.outcome])).toEqual([
      ['cc-fixture-turn-1', { status: 'success', signals: ['no_failure_signal'], provisional: false }],
      ['cc-fixture-turn-2', { status: 'abandoned', signals: ['user_interrupt', 'next_prompt_correction'], provisional: false }],
      ['cc-fixture-turn-3', { status: 'success', signals: ['tests_passed'], provisional: false }],
    ]);
    expect(byType(ev, 'session_end')[0]).toMatchObject({ reason: 'prompt_input_exit', at: new Date(at(600)).toISOString() });
    expect(byType(ev, 'turn_summary').map((s) => [s.turn_id, s.summary])).toEqual([
      ['cc-fixture-turn-1', 'Summary 1 (3 tools)'],
      ['cc-fixture-turn-2', 'Summary 2 (1 tools)'],
      ['cc-fixture-turn-3', 'Summary 3 (3 tools)'],
    ]);
  });

  it('never puts prompts, messages, commands or paths into events', async () => {
    const h = await runWhole();
    const json = JSON.stringify(h.events);
    for (const secret of ['auth.ts', 'acme-billing/', 'exponential', 'Fixed the expiry', 'npm test', 'vitest', 'retry.md', '/work']) {
      expect(json).not.toContain(secret);
    }
  });

  it('cursor resume: reading in two halves (cut mid-line) yields the same events', async () => {
    const whole = await runWhole();

    const h = setup();
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn1End, partialNext: true });
    await h.hook('SessionStart', at(-1), { source: 'startup' });
    await h.hook('Stop', at(31.5));
    expect(byType(h.events, 'turn').map((t) => t.turn_id)).toEqual(['cc-fixture-turn-1']);
    writeSession(h.projectDir, fx); // the rest arrives (incl. the completed half line)
    await h.hook('Stop', at(406.5));
    await h.hook('SessionEnd', at(600), { reason: 'prompt_input_exit' });

    expect(sortById(h.events)).toEqual(sortById(whole.events));
  });

  it('a UserPromptSubmit settles the interrupted turn and checks the new prompt for a correction', async () => {
    const h = setup();
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End }); // turn 3's prompt not written yet
    await h.hook('SessionStart', at(-1), { source: 'startup' });
    await h.hook('UserPromptSubmit', at(359.9), { prompt: "no, that's wrong - use exponential backoff" });
    expect(h.events.map((e) => e.type)).toEqual(['session_start', 'turn', 'run', 'run', 'turn_outcome', 'turn', 'turn_outcome', 'turn_started']);
    const patches = byType(h.events, 'turn_outcome');
    expect(patches[1]).toMatchObject({ turn_id: 'cc-fixture-turn-2', outcome: { status: 'abandoned', signals: ['user_interrupt', 'next_prompt_correction'] } });
    // turn 3 later: no second patch for turn 2
    writeSession(h.projectDir, fx);
    await h.hook('Stop', at(406.5));
    expect(byType(h.events, 'turn_outcome').filter((p) => p.turn_id === 'cc-fixture-turn-2')).toHaveLength(1);
    expect(byType(h.events, 'turn').map((t) => t.turn_id)).toEqual(['cc-fixture-turn-1', 'cc-fixture-turn-2', 'cc-fixture-turn-3']);
  });

  it('a Stop never ends a turn whose prompt came after the hook fired', async () => {
    const h = setup();
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx); // the worker runs late: turn 3 is already in the file
    await h.hook('Stop', at(31.5));
    expect(byType(h.events, 'turn').map((t) => t.turn_id)).toEqual(['cc-fixture-turn-1', 'cc-fixture-turn-2']); // turn 2: closed by turn 3's prompt
    await h.hook('Stop', at(406.5));
    expect(byType(h.events, 'turn').map((t) => t.turn_id)).toEqual(['cc-fixture-turn-1', 'cc-fixture-turn-2', 'cc-fixture-turn-3']);
  });
});

describe('claude-code adapter: other turn endings', () => {
  it('StopFailure fails the turn', async () => {
    const h = setup();
    const b = new TranscriptBuilder();
    b.prompt(0, 'tf', 'do something');
    b.assistant(2, 'msg_a', OPUS, { in: 5, out: 5 }, [toolUse('tu1', 'Bash', { command: 'ls' })]);
    b.toolResult(3, 'tu1', 'x', false);
    b.raw({ type: 'assistant', sessionId: SESSION, timestamp: new Date(at(5)).toISOString(), uuid: 'err', isApiErrorMessage: true, message: { id: 'x', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: 429' }], usage: { input_tokens: 0, output_tokens: 0 } } });
    appendFileSync(join(h.projectDir, `${SESSION}.jsonl`), b.text(), { flag: 'a' });
    await h.hook('StopFailure', at(6), { error_type: 'rate_limit' });
    const [t] = byType(h.events, 'turn');
    expect(t).toMatchObject({ model: OPUS, usage: [u(OPUS, 'xhigh', 5, 5, 0, 0, 0, 1)], outcome: { status: 'failed', signals: ['stop_failure'] } });
    assertValid(h.events);
  });

  it('a Stop-hook continuation re-sends the same turn with the extra work (new event id)', async () => {
    const h = setup();
    const file = join(h.projectDir, `${SESSION}.jsonl`);
    const b = new TranscriptBuilder();
    b.prompt(0, 'tc', 'build it');
    b.assistant(2, 'msg_1', OPUS, { in: 1, out: 10 }, [text('done')]);
    appendFileSync(file, b.text());
    await h.hook('Stop', at(3));
    const c = new TranscriptBuilder();
    c.noise(3);
    c.assistant(5, 'msg_2', OPUS, { in: 2, out: 20 }, [toolUse('tu1', 'Bash', { command: 'pnpm typecheck' })]);
    c.toolResult(9, 'tu1', 'Exit code 2\nerrors', true);
    c.assistant(10, 'msg_3', OPUS, { in: 3, out: 30 }, [text('still failing')]);
    appendFileSync(file, c.text());
    await h.hook('Stop', at(11), { stop_hook_active: true });
    const turns = byType(h.events, 'turn');
    expect(turns).toHaveLength(2);
    expect(turns[1]!.event_id).not.toBe(turns[0]!.event_id);
    expect(turns[1]).toMatchObject({
      turn_id: 'tc',
      ended_at: new Date(at(10)).toISOString(),
      usage: [u(OPUS, 'xhigh', 6, 60, 0, 0, 0, 3)],
      phases_ms: { thinking: 3000, validating: 7000 },
      outcome: { status: 'failed', signals: ['validate_failed'], provisional: true },
    });
  });

  it('a background sub-agent finishing after Stop adds a run and re-sends the turn with its usage', async () => {
    const h = setup();
    const file = join(h.projectDir, `${SESSION}.jsonl`);
    const b = new TranscriptBuilder();
    b.prompt(0, 'tb', 'research in background');
    b.assistant(1, 'msg_1', OPUS, { in: 1, out: 10 }, [toolUse('tu_bg', 'Agent', { prompt: 'p', subagent_type: 'general-purpose', run_in_background: true })]);
    b.toolResult(2, 'tu_bg', 'launched', false, { status: 'async_launched', agentId: 'bg1', isAsync: true });
    b.assistant(3, 'msg_2', OPUS, { in: 1, out: 10 }, [text('started it')]);
    appendFileSync(file, b.text());
    const sub = new TranscriptBuilder(SESSION, { agentId: 'bg1' });
    sub.prompt(2, 'bg-p', 'research');
    sub.assistant(50, 'msg_bg', HAIKU, { in: 40, out: 400 }, [text('report')]);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = join(h.projectDir, SESSION, 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-bg1.jsonl'), sub.text());
    writeFileSync(join(dir, 'agent-bg1.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'tu_bg', spawnDepth: 1 }));

    await h.hook('Stop', at(4));
    expect(h.events.map((e) => e.type)).toEqual(['session_start', 'turn']);
    expect(byType(h.events, 'turn')[0]!.usage).toEqual([u(OPUS, 'xhigh', 2, 20, 0, 0, 0, 2)]);

    await h.hook('SubagentStop', at(51), { agent_id: 'bg1', agent_type: 'general-purpose' });
    expect(h.events.map((e) => e.type)).toEqual(['session_start', 'turn', 'turn', 'run']);
    const [, resent] = byType(h.events, 'turn');
    expect(resent!.usage).toEqual([u(OPUS, 'xhigh', 2, 20, 0, 0, 0, 2), u(HAIKU, 'xhigh', 40, 400, 0, 0, 0, 1)]);
    expect(byType(h.events, 'run')[0]).toMatchObject({ run_id: 'bg1', parent_run_id: null, agent_type: 'general-purpose', depth: 1 });
    await h.hook('SubagentStop', at(52), { agent_id: 'bg1' }); // duplicate: nothing new
    expect(h.events).toHaveLength(4);
    assertValid(h.events);
  });

  it('sequence links (ADR-0020): siblings chain to the latest one that ended before they started', async () => {
    const h = setup();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const b = new TranscriptBuilder();
    b.prompt(0, 'tf', 'plan, build, review');
    // two parallel Explore agents, then Plan → general-purpose → code-reviewer one after the other
    b.assistant(1, 'msg_1', OPUS, { in: 1, out: 10 }, [
      toolUse('tu_e1', 'Agent', { prompt: 'p', subagent_type: 'Explore' }),
      toolUse('tu_e2', 'Agent', { prompt: 'p', subagent_type: 'Explore' }),
    ]);
    b.toolResult(9.5, 'tu_e1', 'report', false, { status: 'completed', agentId: 'e1' });
    b.toolResult(10, 'tu_e2', 'report', false, { status: 'completed', agentId: 'e2' });
    b.assistant(10.5, 'msg_2', OPUS, { in: 1, out: 10 }, [toolUse('tu_plan', 'Agent', { prompt: 'p', subagent_type: 'Plan' })]);
    b.toolResult(20, 'tu_plan', 'plan', false, { status: 'completed', agentId: 'pl' });
    b.assistant(20.5, 'msg_3', OPUS, { in: 1, out: 10 }, [toolUse('tu_gp', 'Agent', { prompt: 'p', subagent_type: 'general-purpose' })]);
    b.toolResult(41, 'tu_gp', 'done', false, { status: 'completed', agentId: 'gp' });
    b.assistant(41.5, 'msg_4', OPUS, { in: 1, out: 10 }, [toolUse('tu_rv', 'Agent', { prompt: 'p', subagent_type: 'code-reviewer' })]);
    b.toolResult(51, 'tu_rv', 'lgtm', false, { status: 'completed', agentId: 'rv' });
    b.assistant(52, 'msg_5', OPUS, { in: 1, out: 10 }, [text('all done')]);
    appendFileSync(join(h.projectDir, `${SESSION}.jsonl`), b.text());

    const dir = join(h.projectDir, SESSION, 'subagents');
    mkdirSync(dir, { recursive: true });
    // id, type, tool_use, parent, start, end (fixture seconds)
    const agents: Array<[string, string, string, string | null, number, number]> = [
      ['e1', 'Explore', 'tu_e1', null, 2, 8],
      ['e2', 'Explore', 'tu_e2', null, 3, 9],
      ['pl', 'Plan', 'tu_plan', null, 11, 19],
      ['gp', 'general-purpose', 'tu_gp', null, 21, 40],
      ['n1', 'Explore', 'tu_n1', 'gp', 23, 28], // nested: chain only with gp's other children
      ['n2', 'Explore', 'tu_n2', 'gp', 30, 36],
      ['rv', 'code-reviewer', 'tu_rv', null, 42, 50],
    ];
    for (const [id, type, tu, parent, start, end] of agents) {
      const sub = new TranscriptBuilder(SESSION, { agentId: id });
      sub.prompt(start, `${id}-p`, 'task');
      sub.assistant(end, `msg_${id}`, HAIKU, { in: 1, out: 1 }, [text('ok')]);
      writeFileSync(join(dir, `agent-${id}.jsonl`), sub.text());
      writeFileSync(
        join(dir, `agent-${id}.meta.json`),
        JSON.stringify({ agentType: type, toolUseId: tu, spawnDepth: parent ? 2 : 1, ...(parent ? { parentAgentId: parent } : {}) }),
      );
    }

    await h.hook('Stop', at(53));
    const runs = byType(h.events, 'run');
    expect(runs).toHaveLength(agents.length);
    const links = Object.fromEntries(runs.map((r) => [r.run_id, r.links ?? []]));
    const seq = (from: string) => [{ from_run_id: from, kind: 'sequence' }];
    expect(links).toEqual({ e1: [], e2: [], pl: seq('e2'), gp: seq('pl'), n1: [], n2: seq('n1'), rv: seq('gp') });
    expect(runs.every((r) => r.stage_index === undefined && r.flow_key === undefined)).toBe(true);
    assertValid(h.events);
  });

  it('a revert in the next turn fails the previous one', async () => {
    const h = setup();
    const file = join(h.projectDir, `${SESSION}.jsonl`);
    const b = new TranscriptBuilder();
    b.prompt(0, 'r1', 'change it');
    b.assistant(1, 'msg_1', OPUS, { in: 1, out: 1 }, [toolUse('tu_e', 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b\nc\nd' })]);
    b.toolResult(2, 'tu_e', 'ok', false, {});
    b.assistant(3, 'msg_2', OPUS, { in: 1, out: 1 }, [text('ok')]);
    b.prompt(10, 'r2', 'hmm, put the old version back');
    b.assistant(11, 'msg_3', OPUS, { in: 1, out: 1 }, [toolUse('tu_g', 'Bash', { command: 'git checkout -- a.ts' })]);
    b.toolResult(12, 'tu_g', '', false, {});
    b.assistant(13, 'msg_4', OPUS, { in: 1, out: 1 }, [text('reverted')]);
    appendFileSync(file, b.text());
    await h.hook('Stop', at(14));
    const [patch] = byType(h.events, 'turn_outcome');
    expect(patch).toMatchObject({ turn_id: 'r1', outcome: { status: 'failed', provisional: false } });
    expect(patch!.outcome.signals).toContain('next_turn_revert');
  });

  it('task notifications start turns but do not settle the previous one', async () => {
    const h = setup();
    const b = new TranscriptBuilder();
    b.prompt(0, 'n1', 'start a long job');
    b.assistant(1, 'msg_1', OPUS, { in: 1, out: 1 }, [text('started')]);
    b.noise(2); // end-of-turn record
    b.prompt(20, 'n2', '<task-notification>\n<task-id>x</task-id>', { origin: { kind: 'task-notification' } });
    b.assistant(21, 'msg_2', OPUS, { in: 1, out: 1 }, [text('the job finished')]);
    appendFileSync(join(h.projectDir, `${SESSION}.jsonl`), b.text());
    await h.hook('Stop', at(22));
    expect(byType(h.events, 'turn').map((t) => t.turn_id)).toEqual(['n1', 'n2']);
    expect(byType(h.events, 'turn_outcome')).toEqual([]);
  });

  it('a task notification injected into a running turn stays part of it', async () => {
    const h = setup();
    const b = new TranscriptBuilder();
    b.prompt(0, 'j1', 'watch the build');
    b.assistant(1, 'msg_1', OPUS, { in: 1, out: 1 }, [toolUse('tu1', 'Bash', { command: 'sleep 5' })]);
    b.prompt(3, 'inj', '<task-notification>\n<status>done</status>', { origin: { kind: 'task-notification' } });
    b.toolResult(6, 'tu1', '', false);
    b.assistant(7, 'msg_2', OPUS, { in: 1, out: 1 }, [text('build finished')]);
    appendFileSync(join(h.projectDir, `${SESSION}.jsonl`), b.text());
    await h.hook('Stop', at(8));
    expect(byType(h.events, 'turn').map((t) => [t.turn_id, t.usage[0]!.requests])).toEqual([['j1', 2]]);
  });
});
