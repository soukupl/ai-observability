import { existsSync, utimesSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupHomes } from '../helpers.js';
import { at, SESSION, threeTurnSession, writeSession } from './fixture.js';
import { assertValid, byType, setup } from './helpers.js';

afterEach(cleanupHomes);

const age = (path: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
};

describe('claude-code adapter: crash sweep', () => {
  it('finishes a session silent for > 24 h: open turn, outcomes, session_end "crashed", summaries', async () => {
    const h = setup({ now: () => new Date() }); // compared with real file mtimes
    const fx = threeTurnSession();
    writeSession(h.projectDir, fx, { upTo: fx.turn2End });
    await h.hook('SessionStart', at(-1), { source: 'startup' });
    await h.hook('Stop', at(31.5)); // turn 2 is interrupted, never gets a Stop; the app crashes
    const before = h.events.length;

    await h.adapter.sweepCrashedSessions(h.ctx); // too fresh
    expect(h.events).toHaveLength(before);

    age(h.ctx.state.path(SESSION), 25 * 3600_000);
    await h.adapter.sweepCrashedSessions(h.ctx);
    await h.summaries(); // the worker's summary phase after its flush (ADR-0027)
    const swept = h.events.slice(before);
    expect(swept.map((e) => e.type)).toEqual(['turn_outcome', 'turn', 'turn_outcome', 'session_end', 'turn_summary', 'turn_summary']);
    expect(byType(swept, 'turn')[0]).toMatchObject({ turn_id: 'cc-fixture-turn-2', outcome: { status: 'abandoned' } });
    expect(byType(swept, 'turn_outcome').map((p) => [p.turn_id, p.outcome.status, p.outcome.provisional])).toEqual([
      ['cc-fixture-turn-1', 'success', false],
      ['cc-fixture-turn-2', 'abandoned', false],
    ]);
    expect(byType(swept, 'session_end')[0]).toMatchObject({ reason: 'crashed', at: new Date(at(310)).toISOString() });
    assertValid(h.events);

    // swept once only
    age(h.ctx.state.path(SESSION), 25 * 3600_000);
    await h.adapter.sweepCrashedSessions(h.ctx);
    expect(h.events.length).toBe(before + swept.length);

    // ended sessions are forgotten after 30 days
    age(h.ctx.state.path(SESSION), 31 * 24 * 3600_000);
    await h.adapter.sweepCrashedSessions(h.ctx);
    expect(existsSync(h.ctx.state.path(SESSION))).toBe(false);
  });

  it('a resumed session we never saw is not back-filled', async () => {
    const h = setup();
    writeSession(h.projectDir, threeTurnSession());
    await h.hook('SessionStart', at(1000), { source: 'resume' });
    await h.hook('Stop', at(1001));
    expect(h.events.map((e) => e.type)).toEqual(['session_start']);
  });
});
