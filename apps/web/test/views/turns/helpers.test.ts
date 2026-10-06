import { describe, expect, it } from 'vitest';
import { listHref, parseStartedMs, parseTurnParams, phaseRow, toRunTree } from '../../../src/app/(dashboard)/turns/_helpers';

describe('turns helpers', () => {
  it('parses page and outcome defensively', () => {
    expect(parseTurnParams({})).toEqual({ page: 1, outcome: null });
    expect(parseTurnParams({ page: '3', outcome: 'failed' })).toEqual({ page: 3, outcome: 'failed' });
    expect(parseTurnParams({ page: '-2', outcome: 'bogus' })).toEqual({ page: 1, outcome: null });
    expect(parseTurnParams({ page: ['4', '5'] }).page).toBe(4);
  });
  it('parses startedMs', () => {
    expect(parseStartedMs('1700000000000')).toBe(1700000000000);
    expect(parseStartedMs('x')).toBeUndefined();
    expect(parseStartedMs(undefined)).toBeUndefined();
  });
  it('builds list hrefs keeping filters and resetting page', () => {
    expect(listHref({ range: '7d', page: '2' }, { outcome: 'failed' })).toBe('/turns?range=7d&outcome=failed');
    expect(listHref({ outcome: 'failed' }, { outcome: null })).toBe('/turns');
    expect(listHref({ range: '7d', outcome: 'failed' }, { page: 2 })).toBe('/turns?range=7d&outcome=failed&page=2');
  });
  it('phaseRow sorts and drops zeros', () => {
    expect(phaseRow(null)).toBeNull();
    expect(phaseRow({ a: 0 })).toBeNull();
    expect(phaseRow({ a: 1, b: 5, c: 0 })?.keys).toEqual(['b', 'a']);
  });
  it('toRunTree roots at the main agent', () => {
    const tokens = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3 };
    const t = toRunTree({
      turn: { model: 'm', effort: 'high', durationMs: 10, tokens, outcome: 'success' },
      tree: [{ id: 'r1', agentType: 'explore', model: null, effort: null, durationMs: 4, tokens, outcome: 'unknown', children: [] }],
    } as never);
    expect(t.label).toBe('main agent');
    expect(t.children[0]).toMatchObject({ id: 'r1', label: 'explore', tokens: 3 });
  });
});
