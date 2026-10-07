import { describe, expect, it } from 'vitest';
import { RUNAWAY_RULES, runawayReasons } from '../src/runaways/decide.js';
import { buildRunawayEmail } from '../src/runaways/mail.js';

const th = { costUsd: 20, hours: 2 };
const base = { tokens: 1000, durationMs: 60_000, costUsd: 0.1, history: 100, p95: 2000, p99: 5000 };

describe('runawayReasons', () => {
  it('tokens: more than 3 × the user p99, or the absolute floor without enough history', () => {
    expect(runawayReasons({ ...base, tokens: 15_001 }, th)).toEqual(['tokens']);
    expect(runawayReasons({ ...base, tokens: 15_000 }, th)).toEqual([]);
    expect(runawayReasons({ ...base, history: RUNAWAY_RULES.minHistory - 1, tokens: 15_001 }, th)).toEqual([]);
    expect(runawayReasons({ ...base, history: 0, p95: null, p99: null, tokens: RUNAWAY_RULES.floorTokens + 1 }, th)).toEqual(['tokens']);
  });

  it('cost: at or above the company threshold; unknown cost never fires', () => {
    expect(runawayReasons({ ...base, costUsd: 20 }, th)).toEqual(['cost']);
    expect(runawayReasons({ ...base, costUsd: null }, { costUsd: 0.01, hours: 2 })).toEqual([]);
  });

  it('duration: long AND above the user p95 (a long quiet turn is fine)', () => {
    expect(runawayReasons({ ...base, durationMs: 2 * 3_600_000, tokens: 2001 }, th)).toEqual(['duration']);
    expect(runawayReasons({ ...base, durationMs: 5 * 3_600_000, tokens: 1999 }, th)).toEqual([]);
    expect(runawayReasons({ ...base, durationMs: 3 * 3_600_000, tokens: 20_000, costUsd: 25 }, th)).toEqual(['tokens', 'cost', 'duration']);
  });
});

describe('buildRunawayEmail', () => {
  const item = {
    turnId: 't1', startedAt: new Date('2026-10-05T10:00:00Z'), startedMs: Date.parse('2026-10-05T10:00:00Z'), teamName: 'A <b>',
    projectName: 'billing', person: 'carol', tokens: 30_000_000, costUsd: 120.5, durationMs: 9_000_000, reasons: ['tokens', 'cost'] as const,
  };
  it('named digest links each turn; anonymous digest has no person and no links; HTML is escaped', () => {
    const named = buildRunawayEmail({ companyName: 'Acme', appUrl: 'https://x.test', anonymous: false, items: [{ ...item, reasons: [...item.reasons] }] });
    expect(named.subject).toBe('[ai-obs] A runaway turn (Acme)');
    expect(named.text).toContain('carol');
    expect(named.text).toContain('https://x.test/turns/t1?startedMs=');
    expect(named.text).toContain('30.00M tokens, ≈ $120.50, 2.5 h');
    expect(named.html).toContain('A &lt;b&gt;');
    const anon = buildRunawayEmail({ companyName: 'Acme', appUrl: 'https://x.test', anonymous: true, items: [{ ...item, person: null, reasons: [...item.reasons] }, { ...item, person: null, reasons: ['duration'] }] });
    expect(anon.subject).toBe('[ai-obs] 2 runaway turns (Acme)');
    expect(anon.text).not.toContain('carol');
    expect(anon.text).not.toContain('/turns/');
  });
});
