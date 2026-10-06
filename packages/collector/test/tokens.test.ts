import { describe, expect, it } from 'vitest';
import { mergeUsage, primaryModel, sumUsage, totalTokens } from '../src/analysis/tokens.js';

describe('sumUsage', () => {
  it('de-duplicates per API response id and sums per model × effort', () => {
    const usage = sumUsage([
      // one response written as three transcript entries (one per content block)
      { responseId: 'msg_1', model: 'opus', effort: 'high', input: 10, output: 5, cacheRead: 100, cacheWrite: 50 },
      { responseId: 'msg_1', model: 'opus', effort: 'high', input: 10, output: 5, cacheRead: 100, cacheWrite: 50 },
      { responseId: 'msg_1', model: 'opus', effort: 'high', input: 10, output: 40, cacheRead: 100, cacheWrite: 50, reasoning: 20 },
      { responseId: 'msg_2', model: 'opus', effort: 'high', input: 1, output: 2 },
      { responseId: 'msg_3', model: 'haiku', effort: null, input: 7, output: 3 },
      { model: 'haiku', effort: null, input: 1, output: 1 }, // no id: counted on its own
    ]);
    expect(usage).toEqual([
      { model: 'opus', effort: 'high', input: 11, output: 42, cache_read: 100, cache_write: 50, reasoning: 20, requests: 2 },
      { model: 'haiku', effort: null, input: 8, output: 4, cache_read: 0, cache_write: 0, reasoning: 0, requests: 2 },
    ]);
  });

  it('clamps garbage to zero and skips records without a model', () => {
    const [u] = sumUsage([{ model: 'm', input: -5, output: Number.NaN }, { model: '', input: 100 }]);
    expect(u).toMatchObject({ input: 0, output: 0, requests: 1 });
  });

  it('merges usage lists and picks the primary model', () => {
    const a = sumUsage([{ responseId: '1', model: 'opus', effort: 'high', output: 100 }]);
    const b = sumUsage([{ responseId: '2', model: 'opus', effort: 'high', output: 10 }, { responseId: '3', model: 'haiku', output: 50 }]);
    const m = mergeUsage(a, b);
    expect(m.find((x) => x.model === 'opus')).toMatchObject({ output: 110, requests: 2 });
    expect(primaryModel(m)).toEqual({ model: 'opus', effort: 'high' });
    expect(totalTokens(m[0]!)).toBe(110);
    expect(primaryModel([])).toBeNull();
  });
});
