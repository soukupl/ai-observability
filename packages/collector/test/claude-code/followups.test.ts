import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TURNS } from '../../src/adapters/claude-code/state.js';
import type { Outcome } from '../../src/protocol-types.js';
import { cleanupHomes } from '../helpers.js';
import { at, SESSION, TranscriptBuilder, text, toolUse } from './fixture.js';
import { assertValid, byType, setup, type Harness } from './helpers.js';

afterEach(cleanupHomes);

const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5';
const NOTE = { origin: { kind: 'task-notification' } };

const transcript = (h: Harness) => join(h.projectDir, `${SESSION}.jsonl`);
const append = (h: Harness, b: TranscriptBuilder) => appendFileSync(transcript(h), b.text());
const outcomes = (h: Harness) => byType(h.events, 'turn_outcome').map((p) => [p.turn_id, p.outcome] as [string, Outcome]);
const success: Outcome = { status: 'success', signals: ['no_failure_signal'], provisional: false };

/** Human turn H launches a background agent and stops; the agent's task notification starts turn N, which stops too. */
function humanThenNotification(h: Harness, opts: { edit?: boolean } = {}) {
  const b = new TranscriptBuilder();
  b.prompt(0, 'H', 'research this in the background');
  if (opts.edit) {
    b.assistant(1, 'msg_e', OPUS, { in: 1, out: 1 }, [toolUse('tu_e', 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b\nc\nd' })]);
    b.toolResult(1.5, 'tu_e', 'ok', false, {});
  }
  b.assistant(2, 'msg_1', OPUS, { in: 1, out: 10 }, [toolUse('tu_bg', 'Agent', { prompt: 'p', subagent_type: 'general-purpose', run_in_background: true })]);
  b.toolResult(3, 'tu_bg', 'launched', false, { status: 'async_launched', agentId: 'bg1', isAsync: true });
  b.assistant(4, 'msg_2', OPUS, { in: 1, out: 10 }, [text('started it')]);
  b.noise(5); // end-of-turn record: H stopped
  b.prompt(20, 'N', '<task-notification>\n<task-id>bg1</task-id>', NOTE);
  b.assistant(21, 'msg_3', OPUS, { in: 1, out: 10 }, [text('the research is done')]);
  b.noise(22);
  append(h, b);
}

/** A human prompt and its turn (written to the transcript). */
function humanTurn(h: Harness, s: number, uuid: string, prompt: string, blocks = [text('ok')]) {
  const b = new TranscriptBuilder();
  b.prompt(s, uuid, prompt);
  blocks.forEach((blk, i) => b.assistant(s + 1 + i, `msg_${uuid}_${i}`, OPUS, { in: 1, out: 1 }, [blk]));
  append(h, b);
}

describe('claude-code: outcomes of turns followed by task-notification turns', () => {
  it('a human prompt after H → task notification N finalizes BOTH turns (UserPromptSubmit)', async () => {
    const h = setup();
    humanThenNotification(h);
    await h.hook('Stop', at(6));
    await h.hook('Stop', at(23));
    expect(byType(h.events, 'turn').map((t) => [t.turn_id, t.outcome.status, t.outcome.provisional])).toEqual([
      ['H', 'unknown', true],
      ['N', 'unknown', true],
    ]);
    expect(outcomes(h)).toEqual([]); // the notification says nothing about H

    await h.hook('UserPromptSubmit', at(30), { prompt: 'great, now write the summary' });
    expect(outcomes(h)).toEqual([
      ['H', success],
      ['N', success],
    ]);

    // the next turn's Stop re-applies the follow-up: nothing new (both are final, no revert)
    humanTurn(h, 30, 'X', 'great, now write the summary');
    await h.hook('Stop', at(40));
    expect(outcomes(h)).toHaveLength(2);
    assertValid(h.events);
  });

  it('without the UserPromptSubmit hook, the next human turn read from the transcript settles both', async () => {
    const h = setup();
    humanThenNotification(h);
    humanTurn(h, 30, 'X', 'thanks, next task please');
    await h.hook('Stop', at(40));
    expect(outcomes(h)).toEqual([
      ['H', success],
      ['N', success],
    ]);
  });

  it('a correction fails the human turn that did the work and its notification turn', async () => {
    const h = setup();
    humanThenNotification(h);
    await h.hook('Stop', at(23));
    await h.hook('UserPromptSubmit', at(30), { prompt: "no, that's wrong - look at the other module" });
    const failed: Outcome = { status: 'failed', signals: ['next_prompt_correction'], provisional: false };
    expect(outcomes(h)).toEqual([
      ['H', failed],
      ['N', failed],
    ]);
  });

  it('a revert in the next human turn fails the turn that made the edits, not only the last turn', async () => {
    const h = setup();
    humanThenNotification(h, { edit: true });
    await h.hook('Stop', at(23));
    await h.hook('UserPromptSubmit', at(30), { prompt: 'put the old version back' });
    expect(outcomes(h)).toEqual([
      ['H', success],
      ['N', success],
    ]);
    humanTurn(h, 30, 'X', 'put the old version back', [toolUse('tu_g', 'Bash', { command: 'git checkout -- a.ts' }), text('reverted')]);
    await h.hook('Stop', at(40));
    const h2 = outcomes(h).filter(([id]) => id === 'H');
    expect(h2).toHaveLength(2);
    expect(h2[1]![1]).toMatchObject({ status: 'failed', provisional: false });
    expect(h2[1]![1].signals).toContain('next_turn_revert');
    expect(outcomes(h).filter(([id]) => id === 'N')).toHaveLength(1); // N made no edits
  });

  it('SessionEnd settles every unsettled turn, not only the last one', async () => {
    const h = setup();
    humanThenNotification(h);
    await h.hook('Stop', at(23));
    await h.hook('SessionEnd', at(60), { reason: 'prompt_input_exit' });
    const ended: Outcome = { status: 'unknown', signals: [], provisional: false };
    expect(outcomes(h)).toEqual([
      ['H', ended],
      ['N', ended],
    ]);
  });

  it('unsettled turns that would fall out of the state file are settled first', async () => {
    const h = setup();
    const b = new TranscriptBuilder();
    b.prompt(0, 'H', 'start the long job');
    b.assistant(1, 'msg_h', OPUS, { in: 1, out: 1 }, [text('started')]);
    b.noise(2);
    const notes = MAX_TURNS + 5;
    for (let i = 0; i < notes; i++) {
      b.prompt(10 + i * 3, `N${i}`, `<task-notification>\n<task-id>${i}</task-id>`, NOTE);
      b.assistant(11 + i * 3, `msg_n${i}`, OPUS, { in: 1, out: 1 }, [text('progress')]);
      b.noise(12 + i * 3);
    }
    append(h, b);
    await h.hook('Stop', at(10 + notes * 3));
    const evicted = notes + 1 - MAX_TURNS;
    expect(outcomes(h).map(([id]) => id)).toEqual(['H', ...Array.from({ length: evicted - 1 }, (_, i) => `N${i}`)]);
    expect(outcomes(h).every(([, o]) => !o.provisional)).toBe(true);

    await h.hook('SessionEnd', at(1000), { reason: 'other' });
    const settled = new Set(outcomes(h).map(([id]) => id));
    expect(settled.size).toBe(notes + 1); // every turn got exactly one final outcome
    expect(outcomes(h)).toHaveLength(notes + 1);
  });
});

describe('claude-code: hooks fired inside a sub-agent', () => {
  /** Main turn T launches a background agent and is still running; the agent hits an API error. */
  function runningTurn(h: Harness) {
    const b = new TranscriptBuilder();
    b.prompt(0, 'T', 'fan out');
    b.assistant(1, 'msg_1', OPUS, { in: 1, out: 10 }, [toolUse('tu_bg', 'Agent', { prompt: 'p', subagent_type: 'general-purpose', run_in_background: true })]);
    b.toolResult(2, 'tu_bg', 'launched', false, { status: 'async_launched', agentId: 'bg1', isAsync: true });
    b.assistant(3, 'msg_2', OPUS, { in: 1, out: 10 }, [toolUse('tu_b', 'Bash', { command: 'pnpm test' })]);
    append(h, b);
    const sub = new TranscriptBuilder(SESSION, { agentId: 'bg1' });
    sub.prompt(2, 'bg-p', 'research');
    sub.assistant(4, 'msg_bg', HAIKU, { in: 40, out: 400 }, [text('partial')]);
    const dir = join(h.projectDir, SESSION, 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-bg1.jsonl'), sub.text());
    writeFileSync(join(dir, 'agent-bg1.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'tu_bg', spawnDepth: 1 }));
  }

  it('a sub-agent StopFailure fails that run only; the running main turn is not cut or failed', async () => {
    const h = setup();
    runningTurn(h);
    await h.hook('StopFailure', at(5), { agent_id: 'bg1', agent_type: 'general-purpose', error: 'overloaded' });
    expect(byType(h.events, 'turn')).toEqual([]); // main turn still running

    const b = new TranscriptBuilder();
    b.toolResult(9, 'tu_b', 'Tests 3 passed', false);
    b.assistant(10, 'msg_3', OPUS, { in: 1, out: 10 }, [text('tests pass')]);
    append(h, b);
    await h.hook('Stop', at(11));
    const turns = byType(h.events, 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ turn_id: 'T', outcome: { status: 'success', signals: ['tests_passed'] } });
    const [run] = byType(h.events, 'run');
    expect(run).toMatchObject({ run_id: 'bg1', outcome: { status: 'failed', signals: ['stop_failure'], provisional: false } });
    expect(turns[0]!.usage.find((x) => x.model === HAIKU)).toMatchObject({ input: 40, output: 400 });
    assertValid(h.events);
  });

  it('Stop and UserPromptSubmit carrying agent_id do not end or settle main turns', async () => {
    const h = setup();
    runningTurn(h);
    await h.hook('Stop', at(5), { agent_id: 'bg1' });
    await h.hook('UserPromptSubmit', at(5.5), { agent_id: 'bg1', prompt: "no, that's wrong" });
    expect(byType(h.events, 'turn')).toEqual([]);
    expect(outcomes(h)).toEqual([]);
  });

  it('a main-thread StopFailure (no agent_id) still fails the turn', async () => {
    const h = setup();
    runningTurn(h);
    await h.hook('StopFailure', at(5), { error: 'rate_limit' });
    expect(byType(h.events, 'turn')[0]).toMatchObject({ turn_id: 'T', outcome: { status: 'failed', signals: ['stop_failure'] } });
  });
});

describe('claude-code: forked sessions', () => {
  it('SessionStart source "fork" does not back-fill the copied parent conversation', async () => {
    const h = setup();
    // the fork's transcript starts with the parent's history (written under the new session id)
    const parent = new TranscriptBuilder();
    parent.prompt(0, 'P1', 'old work in the parent');
    parent.assistant(1, 'msg_parent', OPUS, { in: 100, out: 1000 }, [text('done')]);
    parent.noise(2);
    append(h, parent);
    await h.hook('SessionStart', at(10), { source: 'fork' });
    humanTurn(h, 20, 'F1', 'continue on the branch');
    await h.hook('Stop', at(30));
    const turns = byType(h.events, 'turn');
    expect(turns.map((t) => t.turn_id)).toEqual(['F1']);
    expect(turns[0]!.usage).toEqual([expect.objectContaining({ model: OPUS, input: 1, output: 1 })]);
  });
});
