import { describe, expect, it } from 'vitest';
import { formatCost, formatDuration, formatInt, formatPercent, formatTokens, formatUsd } from '../../src/components/format';
import { ADMIN_NAV, LEAD_NAV, navFor, SUPER_NAV, TOKENS_NAV, VIEW_NAV } from '../../src/components/nav';

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1k'],
    [1_234, '1.2k'],
    [12_345, '12k'],
    [999_499, '999k'],
    [999_999, '1M'],
    [3_400_000, '3.4M'],
    [123_000_000, '123M'],
    [2_100_000_000, '2.1B'],
    [5_000_000_000_000, '5000B'],
    [-1_500, '-1.5k'],
  ])('%d -> %s', (n, out) => expect(formatTokens(n)).toBe(out));
  it('handles missing values', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(Number.NaN)).toBe('—');
  });
});

describe('formatCost', () => {
  it('always says ≈ and uses n/a when no price is known', () => {
    expect(formatCost({ usd: 1.234 })).toBe('≈ $1.23');
    expect(formatCost(0)).toBe('≈ $0.00');
    expect(formatCost({ usd: null })).toBe('n/a');
    expect(formatCost(null)).toBe('n/a');
    expect(formatCost(undefined)).toBe('n/a');
  });
  it('marks partial totals with + and keeps tiny costs visible', () => {
    expect(formatCost({ usd: 12.5, partial: true })).toBe('≈ $12.50+');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(1234.56)).toBe('$1,235');
  });
});

describe('formatDuration / formatPercent / formatInt', () => {
  it.each([
    [850, '850 ms'],
    [1_500, '1.5 s'],
    [12_300, '12 s'],
    [59_600, '1m 00s'],
    [59_000, '59 s'],
    [245_000, '4m 05s'],
    [3_725_000, '1h 02m'],
  ])('%d ms -> %s', (ms, out) => expect(formatDuration(ms)).toBe(out));
  it('percent', () => {
    expect(formatPercent(0.734)).toBe('73%');
    expect(formatPercent(0.734, 1)).toBe('73.4%');
    expect(formatPercent(0.004)).toBe('<1%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(null)).toBe('—');
  });
  it('int', () => {
    expect(formatInt(1234567)).toBe('1,234,567');
    expect(formatInt(null)).toBe('—');
  });
});

describe('navFor', () => {
  const company = { name: 'x' };
  it('members get the views and My tokens', () => {
    expect(navFor({ companyRole: 'member', isSuperAdmin: false, company })).toEqual([...VIEW_NAV, TOKENS_NAV]);
  });
  it('team leads also get Team tokens', () => {
    expect(navFor({ companyRole: 'member', isSuperAdmin: false, company, teams: [{ role: 'lead' }] })).toEqual([...VIEW_NAV, TOKENS_NAV, LEAD_NAV]);
  });
  it('admins get the Admin link, super admins the Super link', () => {
    expect(navFor({ companyRole: 'admin', isSuperAdmin: false, company }).at(-1)).toEqual(ADMIN_NAV);
    expect(navFor({ companyRole: 'member', isSuperAdmin: true, company: null })).toEqual([SUPER_NAV]);
    const both = navFor({ companyRole: 'admin', isSuperAdmin: true, company });
    expect(both.slice(-2)).toEqual([ADMIN_NAV, SUPER_NAV]);
  });
  it('lists all seven dashboard views', () => {
    expect(VIEW_NAV.map((n) => n.href)).toEqual(['/overview', '/projects', '/models', '/phases', '/agents', '/skills-mcp', '/turns']);
  });
});
