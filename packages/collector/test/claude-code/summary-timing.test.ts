import { afterEach, describe, expect, it } from 'vitest';
import { SUMMARY_BATCH, SUMMARY_MAX_WAIT_MS } from '../../src/analysis/summaries.js';
import { cleanupHomes } from '../helpers.js';
import { at, SESSION, text, threeTurnSession, TranscriptBuilder, writeSession } from './fixture.js';
import { byType, setup } from './helpers.js';

afterEach(cleanupHomes);

const OPUS = 'claude-opus-5-5';

/** `n` plain turns (prompt + one text answer), one per minute from the fixture start. */
function plainTurns(n: number) {
  const m = new TranscriptBuilder();
  for (let i = 0; i < n; i++) {
    const s = i * 60;
    m.prompt(s, `plain-turn-${i + 1}`, `Task number ${i + 1}`);
    m.assistant(s + 5, `msg_p${i + 1}`, OPUS, { in: 3, out: 20, cr: 100, cw: 0 }, [text(`Done ${i + 1}.`)]);
  }
  const fx = threeTurnSession();
  return { ...fx, main: m, subagents: {} };
}

describe('claude-code adapter: mid-session summaries (ADR-0023)', () => {
  it(`summarizes before the session ends once ${SUMMARY_BATCH} turns are waiting`, async () => {
    const h = setup();
    writeSession(h.projectDir, plainTurns(SUMMARY_BATCH) as ReturnType<typeof threeTurnSession>, { subagents: false });
    await h.hook('SessionStart', at(-1), { source: 'startup' });
    await h.hook('Stop', at(SUMMARY_BATCH * 60));
    expect(byType(h.events, 'session_end')).toHaveLength(0);
    expect(byType(h.events, 'turn_summary').map((s) => s.turn_id)).toEqual(Array.from({ length: SUMMARY_BATCH }, (_, i) => `plain-turn-${i + 1}`));
    expect(byType(h.events, 'turn_summary')[0]).toMatchObject({ summary: 'Summary 1 (0 tools)' });
    // the digests were handed over: nothing waits any more
    const st = h.ctx.state.get<{ digests: unknown[]; digestsSince?: number }>(SESSION)!;
    expect(st.digests).toEqual([]);
    expect(st.digestsSince).toBeUndefined();
  });

  it('summarizes one waiting turn after it has waited 10 minutes, not before', async () => {
    const h = setup();
    writeSession(h.projectDir, plainTurns(1) as ReturnType<typeof threeTurnSession>, { subagents: false });
    await h.hook('SessionStart', at(-1), { source: 'startup' });
    await h.hook('Stop', at(40));
    expect(byType(h.events, 'turn')).toHaveLength(1);
    expect(byType(h.events, 'turn_summary')).toHaveLength(0);
    expect(h.ctx.state.get<{ digestsSince?: number }>(SESSION)!.digestsSince).toBe(at(40));

    await h.hook('Stop', at(40 + 120)); // 2 minutes later: still waiting
    expect(byType(h.events, 'turn_summary')).toHaveLength(0);

    await h.hook('Stop', at(40) + SUMMARY_MAX_WAIT_MS + 60_000); // 11 minutes after the first wait began
    expect(byType(h.events, 'turn_summary').map((s) => s.turn_id)).toEqual(['plain-turn-1']);
    expect(h.ctx.state.get<{ digestsSince?: number }>(SESSION)!.digestsSince).toBeUndefined();
  });

  it('a state file without digestsSince (older collector) starts the wait at the next hook', async () => {
    const h = setup();
    writeSession(h.projectDir, plainTurns(1) as ReturnType<typeof threeTurnSession>, { subagents: false });
    await h.hook('SessionStart', at(-1), { source: 'startup' });
    await h.hook('Stop', at(40));
    const st = h.ctx.state.get<Record<string, unknown>>(SESSION)!;
    delete st.digestsSince;
    h.ctx.state.set(SESSION, st);
    await h.hook('Stop', at(40) + SUMMARY_MAX_WAIT_MS + 60_000);
    expect(byType(h.events, 'turn_summary')).toHaveLength(0); // the wait restarted here
    expect(h.ctx.state.get<{ digestsSince?: number }>(SESSION)!.digestsSince).toBe(at(40) + SUMMARY_MAX_WAIT_MS + 60_000);
  });

  it('session end still summarizes a turn that has waited less than 10 minutes', async () => {
    const h = setup();
    writeSession(h.projectDir, plainTurns(1) as ReturnType<typeof threeTurnSession>, { subagents: false });
    await h.hook('SessionStart', at(-1), { source: 'startup' });
    await h.hook('Stop', at(40));
    await h.hook('SessionEnd', at(100), { reason: 'prompt_input_exit' });
    expect(h.events.map((e) => e.type)).toEqual(['session_start', 'turn', 'turn_outcome', 'session_end', 'turn_summary']);
  });
});
