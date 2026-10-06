import { describe, expect, it } from 'vitest';
import { addDays } from '../src/lib/dates.js';
import { aggregateDay, planDays, type TurnRow, type UsageRow } from '../src/rollups/aggregate.js';

const turn = (id: string, over: Partial<TurnRow> = {}): TurnRow => ({
  id, teamId: 'team1', userId: 'u1', projectId: 'p1', harness: 'claude-code', model: 'opus', effort: 'high',
  durationMs: 1000, phasesMs: { thinking: 600, coding: 400 }, outcome: 'success', ...over,
});
const use = (turnId: string, over: Partial<UsageRow> = {}): UsageRow => ({
  turnId, model: 'opus', effort: 'high', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20,
  reasoningTokens: 2, requests: 1, ...over,
});

describe('aggregateDay', () => {
  it('folds turns of one key into one row with summed tokens, durations, phases and outcomes', () => {
    const rows = aggregateDay(
      [turn('a'), turn('b', { outcome: 'failed', durationMs: 500, phasesMs: { thinking: 500, testing: 10 } })],
      [use('a'), use('b', { inputTokens: 1 })],
      new Map([['a', 2]]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      turns: 2, runs: 2, inputTokens: 11, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 40,
      reasoningTokens: 4, requests: 2, durationMs: 1500, success: 1, failed: 1, abandoned: 0, unknown: 0,
      phasesMs: { thinking: 1100, coding: 400, testing: 10 },
    });
  });

  it('splits by team, user, project, harness, model and effort; null user stays its own key', () => {
    const rows = aggregateDay(
      [turn('a'), turn('b', { userId: null }), turn('c', { effort: null }), turn('d', { harness: 'codex', model: 'gpt' }), turn('e', { projectId: null })],
      [],
      new Map(),
    );
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.userId === null)?.turns).toBe(1);
  });

  it('attributes tokens by usage model/effort, so a mixed-model turn creates a usage-only row with zero turns', () => {
    const rows = aggregateDay([turn('a')], [use('a'), use('a', { model: 'haiku', effort: null, inputTokens: 7 })], new Map());
    const haiku = rows.find((r) => r.model === 'haiku')!;
    expect(haiku).toMatchObject({ turns: 0, inputTokens: 7, effort: null });
    expect(rows.find((r) => r.model === 'opus')).toMatchObject({ turns: 1, inputTokens: 10 });
  });

  it('ignores all-zero usage rows instead of creating a zero-token slice (DP-10)', () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0 };
    const rows = aggregateDay([turn('a')], [use('a'), use('a', { model: 'mystery', ...zero })], new Map());
    expect(rows.map((r) => r.model)).toEqual(['opus']);
    // A row with a request but no tokens still counts.
    const withRequest = aggregateDay([turn('a')], [use('a', { model: 'mystery', ...zero, requests: 1 })], new Map());
    expect(withRequest.find((r) => r.model === 'mystery')?.requests).toBe(1);
  });

  it('totals equal the raw sums regardless of grouping', () => {
    const turns = [turn('a'), turn('b', { userId: 'u2' }), turn('c', { model: null })];
    const usageRows = [use('a'), use('a', { model: 'haiku' }), use('b'), use('c', { model: 'sonnet' })];
    const rows = aggregateDay(turns, usageRows, new Map());
    const sum = (f: (r: { inputTokens: number }) => number) => rows.reduce((s, r) => s + f(r), 0);
    expect(sum((r) => r.inputTokens)).toBe(usageRows.reduce((s, u) => s + u.inputTokens, 0));
    expect(rows.reduce((s, r) => s + r.turns, 0)).toBe(3);
  });

  it('records a missing turn model as unknown and ignores usage of unknown turns', () => {
    const rows = aggregateDay([turn('a', { model: null })], [use('zzz')], new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'unknown', inputTokens: 0 });
  });

  it('is deterministic: input order does not change the output', () => {
    const turns = [turn('a'), turn('b', { userId: 'u2' }), turn('c', { harness: 'codex' })];
    expect(aggregateDay([...turns].reverse(), [], new Map())).toEqual(aggregateDay(turns, [], new Map()));
  });
});

describe('planDays', () => {
  const companies = [
    { id: 'c1', cutoffDay: '2026-09-01' },
    { id: 'c2', cutoffDay: '2026-10-04' },
  ];

  it('always includes today and yesterday for every company', () => {
    const plan = planDays({ today: '2026-10-05', companies, changed: [] }, addDays);
    expect(plan).toEqual([
      { companyId: 'c1', day: '2026-10-05' }, { companyId: 'c2', day: '2026-10-05' },
      { companyId: 'c1', day: '2026-10-04' }, { companyId: 'c2', day: '2026-10-04' },
    ]);
  });

  it('adds changed slices, de-duplicates, and drops days outside the retention window or in the future', () => {
    const plan = planDays(
      {
        today: '2026-10-05',
        companies,
        changed: [
          { companyId: 'c1', day: '2026-09-15' }, { companyId: 'c1', day: '2026-10-05' },
          { companyId: 'c1', day: '2026-08-31' }, // before c1 cutoff
          { companyId: 'c2', day: '2026-10-03' }, // before c2 cutoff
          { companyId: 'c1', day: '2026-10-06' }, // future (clock skew)
          { companyId: 'gone', day: '2026-10-05' }, // unknown company
        ],
      },
      addDays,
    );
    expect(plan.map((p) => `${p.companyId}:${p.day}`)).toEqual([
      'c1:2026-10-05', 'c2:2026-10-05', 'c1:2026-10-04', 'c2:2026-10-04', 'c1:2026-09-15',
    ]);
  });
});
