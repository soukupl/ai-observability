import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_PRICES, estimateCostUsd } from '../src/prices.js';
import { generateTurns } from '../src/seed-data.js';

const opts = {
  actors: [{ key: 'a', team: 'T1' }, { key: 'b', team: 'T2' }],
  projects: [{ key: 'github.com/x/one', team: 'T1' }, { key: 'github.com/x/two', team: 'T2' }],
  count: 300,
  days: 60,
  now: new Date('2026-10-05T12:00:00Z'),
};

describe('generateTurns', () => {
  const turns = generateTurns(opts);

  it('is deterministic for a given seed', () => {
    expect(generateTurns(opts)).toEqual(turns);
    expect(generateTurns({ ...opts, seed: 7 })).not.toEqual(turns);
  });

  it('spreads turns over the window and keeps external ids unique', () => {
    expect(turns).toHaveLength(300);
    const oldest = Math.min(...turns.map((t) => t.startedAt.getTime()));
    expect(opts.now.getTime() - oldest).toBeLessThanOrEqual(61 * 86_400_000);
    expect(new Set(turns.map((t) => t.externalId)).size).toBe(300);
  });

  it('turn token totals equal the sum of its usage rows (main + sub-agent runs)', () => {
    for (const t of turns) {
      const rows = [...t.usage, ...t.runs.map((r) => r.usage)];
      expect(rows.reduce((a, u) => a + u.input, 0)).toBe(t.input);
      expect(rows.reduce((a, u) => a + u.cacheRead, 0)).toBe(t.cacheRead);
      expect(t.reasoning).toBeLessThanOrEqual(t.output);
      for (const u of rows) expect(Number.isInteger(u.input) && Number.isInteger(u.cacheRead) && Number.isInteger(u.output)).toBe(true);
    }
  });

  it('phases add up to the turn time not spent waiting on depth-1 sub-agents', () => {
    for (const t of turns) {
      const delegated = t.runs.filter((r) => r.depth === 1).reduce((a, r) => a + r.durationMs, 0);
      const phases = Object.values(t.phasesMs).reduce((a, ms) => a! + (ms ?? 0), 0);
      expect(phases).toBe(t.durationMs - delegated);
      expect(Object.values(t.phasesMs).every((ms) => (ms ?? 0) >= 0)).toBe(true);
    }
  });

  it('only references models that have a default price', () => {
    const priced = new Set(DEFAULT_MODEL_PRICES.map((p) => p.model));
    for (const t of turns) for (const u of [...t.usage, ...t.runs.map((r) => r.usage)]) expect(priced.has(u.model), u.model).toBe(true);
  });
});

describe('estimateCostUsd', () => {
  it('prices per million tokens and does not bill reasoning separately', () => {
    const opus = DEFAULT_MODEL_PRICES.find((p) => p.model === 'claude-opus-5-5')!;
    expect(estimateCostUsd(opus, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(4 + 20 + 0.2 + 5);
  });
});
