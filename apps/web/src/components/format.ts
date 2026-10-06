import type { CostValue } from '../lib/cost';

/** Number / cost / time formatting shared by tables, tiles and charts. Pure and locale-independent (en-US). */

const INT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const formatInt = (n: number | null | undefined): string => (n === null || n === undefined || Number.isNaN(n) ? '—' : INT.format(n));

/** 950 -> "950", 1_234 -> "1.2k", 12_345 -> "12k", 3_400_000 -> "3.4M", 2_100_000_000 -> "2.1B". */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1_000) return String(Math.round(n));
  const units: [number, string][] = [
    [1_000, 'k'],
    [1_000_000, 'M'],
    [1_000_000_000, 'B'],
  ];
  let i = units.length - 1;
  while (i > 0 && abs < units[i]![0]) i--;
  const round = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  let rounded = round(abs / units[i]![0]);
  if (rounded >= 1000 && i < units.length - 1) {
    i += 1; // 999_999 -> "1M", not "1000k"
    rounded = round(abs / units[i]![0]);
  }
  return `${n < 0 ? '-' : ''}${rounded}${units[i]![1]}`;
}

/** "$1.23", "$0.004" -> "<$0.01", "$1,234". No "≈": see formatCost. */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  if (n >= 1000) return `$${INT.format(Math.round(n))}`;
  return `$${n.toFixed(2)}`;
}

/** The only way a cost is shown: always "≈" (API list prices), "n/a" when no model had a price, "+" when some did not. */
export function formatCost(cost: Pick<CostValue, 'usd'> & Partial<Pick<CostValue, 'partial'>> | number | null | undefined): string {
  if (cost === null || cost === undefined) return 'n/a';
  const usd = typeof cost === 'number' ? cost : cost.usd;
  if (usd === null) return 'n/a';
  const partial = typeof cost === 'object' && cost.partial;
  return `≈ ${formatUsd(usd)}${partial ? '+' : ''}`;
}

export function formatPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return '—';
  if (fraction > 0 && fraction < 0.01 && digits === 0) return '<1%';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** 850 -> "850 ms", 12_300 -> "12.3 s", 245_000 -> "4m 05s", 3_725_000 -> "1h 02m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 59.5) return `${s < 10 ? s.toFixed(1) : s.toFixed(0)} s`;
  const totalSeconds = Math.round(s);
  const m = Math.floor(totalSeconds / 60);
  if (m < 60) return `${m}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** UTC and fixed format, so server and client render the same text. */
export function formatDateTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
export function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Chart value formats are named (not functions) because chart components are client components and
 * a server page cannot pass functions to them.
 */
export type ValueFormat = 'tokens' | 'int' | 'cost' | 'duration' | 'percent';
export function formatValue(format: ValueFormat, n: number): string {
  switch (format) {
    case 'tokens':
      return formatTokens(n);
    case 'int':
      return formatInt(n);
    case 'cost':
      return formatCost(n);
    case 'duration':
      return formatDuration(n);
    case 'percent':
      return formatPercent(n);
  }
}
