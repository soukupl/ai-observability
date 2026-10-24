import { describe, expect, it } from 'vitest';
import { decideBudget, measureUsage, type BudgetMarks } from '../src/budgets/evaluate.js';
import { buildBudgetEmail, formatTokens, formatValue, periodLabel } from '../src/budgets/mail.js';
import { indexPrices } from '../src/lib/cost.js';

const period = '2026-10-01';
const fresh: BudgetMarks = { notifiedPeriod: period, notified80: false, notified100: false };
const decide = (used: number, marks: BudgetMarks = fresh, limit = 100) => decideBudget({ period, limit, used, marks });

describe('decideBudget', () => {
  it('stays quiet below 80 %', () => {
    expect(decide(79.99)).toEqual({ reset: false, send: null });
  });
  it('sends 80 % from 80 % up to (excluding) 100 %', () => {
    expect(decide(80).send).toBe(80);
    expect(decide(99.9).send).toBe(80);
  });
  it('sends 100 % at the limit and above', () => {
    expect(decide(100).send).toBe(100);
    expect(decide(250).send).toBe(100);
  });
  it('never repeats a mail once marked', () => {
    expect(decide(90, { ...fresh, notified80: true }).send).toBeNull();
    expect(decide(120, { ...fresh, notified80: true, notified100: true }).send).toBeNull();
  });
  it('sends 100 % after 80 % was sent', () => {
    expect(decide(100, { ...fresh, notified80: true }).send).toBe(100);
  });
  it('jumping straight over 100 % sends only the 100 % mail, never a late 80 %', () => {
    expect(decide(130).send).toBe(100);
    // the caller marks both; with both marked nothing more is sent even if usage dips and rises again
    expect(decide(85, { ...fresh, notified80: true, notified100: true }).send).toBeNull();
  });
  it('a new period resets the marks and notifies again', () => {
    const old: BudgetMarks = { notifiedPeriod: '2026-09-01', notified80: true, notified100: true };
    expect(decide(0, old)).toEqual({ reset: true, send: null });
    expect(decide(85, old)).toEqual({ reset: true, send: 80 });
    expect(decide(100, { notifiedPeriod: null, notified80: false, notified100: false })).toEqual({ reset: true, send: 100 });
  });
  it('ignores non-positive limits', () => {
    expect(decide(5, fresh, 0).send).toBeNull();
  });
});

describe('measureUsage', () => {
  const prices = indexPrices([
    { model: 'opus', effectiveFrom: '2026-01-01', inputPerMtok: '5', outputPerMtok: '25', cacheReadPerMtok: '0.5', cacheWritePerMtok: '6.25' },
    { model: 'opus', effectiveFrom: '2026-10-03', inputPerMtok: '10', outputPerMtok: '50', cacheReadPerMtok: '1', cacheWritePerMtok: '12.5' },
  ]);
  const rows = [
    { day: '2026-10-02', model: 'opus', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 },
    { day: '2026-10-03', model: 'opus', input: 1e6, output: 1e5, cacheRead: 0, cacheWrite: 0 },
    { day: '2026-10-03', model: 'mystery', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 },
  ];
  it('sums tokens across models and days', () => {
    expect(measureUsage(rows, 'tokens', prices).value).toBe(1e6 + 1.1e6 + 1e6);
  });
  it('prices each day at its effective price and reports unpriced models', () => {
    const r = measureUsage(rows, 'cost', prices);
    expect(r.value).toBeCloseTo(5 + (10 + 5), 9);
    expect(r.unpriced).toEqual(['mystery']);
  });
});

describe('budget e-mail', () => {
  const base = { kind: 'cost' as const, used: 85.5, limit: 100, period, deploymentName: 'Acme <script>', scope: 'team Platform', appUrl: 'https://obs.example' };
  it('builds the 80 % mail in plain text and HTML', () => {
    const m = buildBudgetEmail({ ...base, threshold: 80 });
    expect(m.subject).toContain('Budget at 80 %');
    expect(m.text).toContain('86 %');
    expect(m.text).toContain('$85.50 of $100.00');
    expect(m.text).toContain('estimate at API list prices');
    expect(m.text).toContain('https://obs.example/overview');
    expect(m.html).toContain('width:86%');
  });
  it('builds the 100 % mail and escapes HTML in names', () => {
    const m = buildBudgetEmail({ ...base, threshold: 100, used: 120 });
    expect(m.subject).toContain('Budget reached');
    expect(m.html).toContain('Acme &lt;script&gt;');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('width:100%');
  });
  it('formats tokens and periods', () => {
    expect(formatTokens(1_234_567)).toBe('1.23M');
    expect(formatTokens(950)).toBe('950');
    expect(formatValue('tokens', 2_000_000)).toBe('2.00M tokens');
    expect(periodLabel('2026-10-01')).toBe('October 2026');
  });
});
