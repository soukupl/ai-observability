import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readTranscript, titleOf } from '../../src/adapters/claude-code/transcript.js';
import { cleanupHomes } from '../helpers.js';
import { at, SESSION, threeTurnSession, writeSession } from './fixture.js';
import { assertValid, byType, setup } from './helpers.js';

afterEach(cleanupHomes);

const custom = (title: string, sessionId = SESSION) => `${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })}\n`;
const ai = (title: string, sessionId = SESSION) => `${JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId })}\n`;

describe('claude-code session titles (ADR-0026)', () => {
  it('titleOf reads both kinds, scrubs paths, cleans them and ignores blanks, other sessions and other lines', () => {
    expect(titleOf({ type: 'custom-title', customTitle: '  My\n rename ', sessionId: SESSION }, SESSION)).toEqual({ source: 'custom', title: 'My rename' });
    expect(titleOf({ type: 'ai-title', aiTitle: 'x'.repeat(300) }, SESSION)?.title).toHaveLength(140);
    expect(titleOf({ type: 'ai-title', aiTitle: '   ' }, SESSION)).toBeNull();
    // A stray path keeps only its last segment, as in summaries.
    expect(titleOf({ type: 'custom-title', customTitle: 'Fix /Users/dev/acme/src/auth.ts flake' }, SESSION)?.title).toBe('Fix auth.ts flake');
    expect(titleOf({ type: 'ai-title', aiTitle: 'Other', sessionId: 'other-session' }, SESSION)).toBeNull();
    expect(titleOf({ type: 'user', message: { content: 'hi' } }, SESSION)).toBeNull();
  });

  it('readTranscript returns the latest title of each kind and keeps title lines out of the turn entries', () => {
    const h = setup();
    const fx = threeTurnSession();
    const path = writeSession(h.projectDir, fx);
    const before = readTranscript(path, 0, SESSION);
    appendFileSync(path, ai('First AI') + custom('Mine') + ai('Second AI') + ai('Foreign', 'other-session'));
    const after = readTranscript(path, 0, SESSION);
    expect(after.titles).toEqual({ custom: 'Mine', ai: 'Second AI' });
    expect(after.lines).toEqual(before.lines);
    expect(readTranscript(path, before.end, SESSION).titles).toEqual({ custom: 'Mine', ai: 'Second AI' });
    expect(before.titles).toEqual({});
  });

  it('sends the title once, again only when it changes, and the /rename title wins over the generated one', async () => {
    const h = setup();
    const fx = threeTurnSession();
    const path = writeSession(h.projectDir, fx);
    await h.hook('SessionStart', at(-1), { source: 'startup' });
    expect(byType(h.events, 'session_title')).toEqual([]);

    appendFileSync(path, ai('Generated name'));
    await h.hook('Stop', at(406.5));
    let titles = byType(h.events, 'session_title');
    expect(titles.map((t) => [t.session_id, t.source, t.title])).toEqual([[SESSION, 'ai', 'Generated name']]);

    // Nothing new in the transcript: nothing re-sent.
    await h.hook('Stop', at(407));
    expect(byType(h.events, 'session_title')).toHaveLength(1);

    appendFileSync(path, custom('Auth refresh work'));
    await h.hook('Stop', at(408));
    // A later generated title does not replace the user's own.
    appendFileSync(path, ai('Regenerated name'));
    await h.hook('Stop', at(409));
    appendFileSync(path, custom('Auth refresh, part 2'));
    await h.hook('SessionEnd', at(600), { reason: 'prompt_input_exit' });

    titles = byType(h.events, 'session_title');
    expect(titles.map((t) => [t.source, t.title])).toEqual([
      ['ai', 'Generated name'],
      ['custom', 'Auth refresh work'],
      ['custom', 'Auth refresh, part 2'],
    ]);
    expect(new Set(titles.map((t) => t.event_id)).size).toBe(3);
    assertValid(h.events);
  });

  it('a session without title entries sends no session_title', async () => {
    const h = setup();
    writeSession(h.projectDir, threeTurnSession());
    await h.hook('SessionStart', at(-1), { source: 'startup' });
    await h.hook('Stop', at(406.5));
    await h.hook('SessionEnd', at(600), { reason: 'prompt_input_exit' });
    expect(byType(h.events, 'session_title')).toEqual([]);
  });
});
