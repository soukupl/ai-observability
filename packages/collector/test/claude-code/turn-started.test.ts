import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isHookPrompt, PROMPT_MATCH_AFTER_MS, PROMPT_MATCH_BEFORE_MS } from '../../src/adapters/claude-code/handlers.js';
import { loadSession } from '../../src/adapters/claude-code/state.js';
import { cleanupHomes } from '../helpers.js';
import { at, SESSION, text, TranscriptBuilder } from './fixture.js';
import { assertValid, byType, setup, type Harness } from './helpers.js';

afterEach(() => cleanupHomes());

const OPUS = 'claude-opus-5-5';
const write = (h: Harness, b: TranscriptBuilder) => writeFileSync(join(h.projectDir, `${SESSION}.jsonl`), b.text());
const iso = (ms: number) => new Date(ms).toISOString();

describe('claude-code adapter: turn_started (live status, ADR-0027)', () => {
  it('prompt written + payload prompt_id: turn_started carries the prompt uuid, which the later turn keeps', async () => {
    const h = setup();
    const b = new TranscriptBuilder().prompt(10, 'u1', 'fix the expiry check');
    write(h, b);
    await h.hook('UserPromptSubmit', at(10.2), { prompt: 'fix the expiry check', prompt_id: 'p-u1' });
    expect(byType(h.events, 'turn_started').map(({ event_id: _id, ...e }) => e)).toEqual([
      { type: 'turn_started', harness: 'claude-code', session_id: SESSION, turn_id: 'u1', started_at: iso(at(10.2)) },
    ]);
    b.assistant(12, 'msg1', OPUS, { in: 10, out: 5 }, [text('done')]);
    write(h, b);
    await h.hook('Stop', at(13));
    expect(byType(h.events, 'turn').map((t) => t.turn_id)).toEqual(['u1']);
    assertValid(h.events);
  });

  it('prompt not written yet: turn_id null', async () => {
    const h = setup();
    write(h, new TranscriptBuilder());
    await h.hook('UserPromptSubmit', at(10), { prompt: 'hi', prompt_id: 'p-u1' });
    expect(byType(h.events, 'turn_started').map((e) => e.turn_id)).toEqual([null]);
  });

  it('without prompt_id the prompt is matched by time: hook − 3 s matches, an older unfinished prompt does not', async () => {
    const h = setup();
    write(h, new TranscriptBuilder().prompt(57, 'u-near', 'go'));
    await h.hook('UserPromptSubmit', at(60), { prompt: 'go' });
    expect(byType(h.events, 'turn_started').map((e) => e.turn_id)).toEqual(['u-near']);

    const old = setup();
    write(old, new TranscriptBuilder().prompt(0, 'u-old', 'still waiting'));
    await old.hook('UserPromptSubmit', at(60), { prompt: 'go' });
    expect(byType(old.events, 'turn_started').map((e) => e.turn_id)).toEqual([null]);
  });

  it('isHookPrompt: prompt_id wins when both sides have one, else the time window', () => {
    const p = { uuid: 'u', at: 100_000, promptId: 'p-u' };
    expect(isHookPrompt(p, 'p-u', 500_000)).toBe(true);
    expect(isHookPrompt(p, 'p-other', 100_000)).toBe(false);
    expect(isHookPrompt({ ...p, promptId: null }, 'p-u', 100_000 + PROMPT_MATCH_BEFORE_MS)).toBe(true);
    expect(isHookPrompt({ ...p, promptId: null }, 'p-u', 100_000 + PROMPT_MATCH_BEFORE_MS + 1)).toBe(false);
    expect(isHookPrompt(p, null, 100_000 - PROMPT_MATCH_AFTER_MS)).toBe(true);
    expect(isHookPrompt(p, null, 100_000 - PROMPT_MATCH_AFTER_MS - 1)).toBe(false);
  });

  it('a sub-agent UserPromptSubmit (agent_id) sends none', async () => {
    const h = setup();
    write(h, new TranscriptBuilder().prompt(10, 'u1', 'x'));
    await h.hook('SessionStart', at(0), { source: 'startup' });
    await h.hook('UserPromptSubmit', at(10.2), { prompt: 'x', prompt_id: 'p-u1', agent_id: 'a1' });
    expect(byType(h.events, 'turn_started')).toEqual([]);
  });

  it('the id is stable across replays of the same hook and differs per session', async () => {
    const run = async (sessionId: string) => {
      const h = setup();
      write(h, new TranscriptBuilder().prompt(10, 'u1', 'x'));
      await h.hook('UserPromptSubmit', at(10.2), { prompt: 'x', prompt_id: 'p-u1', session_id: sessionId });
      return byType(h.events, 'turn_started')[0]!.event_id;
    };
    const a = await run(SESSION);
    expect(await run(SESSION)).toBe(a);
    expect(await run('99999999-2222-4333-8444-555555555555')).not.toBe(a);
  });

  it('a first hook that is UserPromptSubmit: [session_start, turn_started]', async () => {
    const h = setup();
    write(h, new TranscriptBuilder().prompt(10, 'u1', 'x'));
    await h.hook('UserPromptSubmit', at(10.2), { prompt: 'x', prompt_id: 'p-u1' });
    expect(h.events.map((e) => e.type)).toEqual(['session_start', 'turn_started']);
  });

  it('a late worker that already sees the replies does not end the running turn at UserPromptSubmit', async () => {
    const h = setup();
    const b = new TranscriptBuilder()
      .prompt(10, 'u1', 'x')
      .assistant(11, 'msg1', OPUS, { in: 10, out: 5 }, [text('working on it')])
      .assistant(14, 'msg2', OPUS, { in: 10, out: 5 }, [text('done')]);
    write(h, b);
    await h.hook('UserPromptSubmit', at(10.2), { prompt: 'x', prompt_id: 'p-u1' });
    expect(byType(h.events, 'turn')).toEqual([]);
    expect(byType(h.events, 'turn_started').map((e) => e.turn_id)).toEqual(['u1']);
    await h.hook('Stop', at(15));
    expect(byType(h.events, 'turn').map((t) => t.turn_id)).toEqual(['u1']);
    expect(loadSession(h.ctx.state, SESSION)!.turns.map((t) => [t.turnId, t.rev])).toEqual([['u1', 0]]);
    assertValid(h.events);
  });
});
