/**
 * The chart palette as plain data (no React, no 'use client'), so server-rendered output (the printable flow report)
 * can use the same colours as the client charts. `chart-theme.ts` builds its theme from these.
 */

/** One categorical palette for every chart (distinguishable in light and dark, colour-blind friendly order). */
export const LIGHT = ['#2563eb', '#d97706', '#059669', '#db2777', '#7c3aed', '#0891b2', '#65a30d', '#dc2626'];
export const DARK = ['#60a5fa', '#fbbf24', '#34d399', '#f472b6', '#a78bfa', '#22d3ee', '#a3e635', '#f87171'];
export const OTHER = { light: '#71717a', dark: '#a1a1aa' };

/** Fixed colours so a phase or outcome looks the same on every page. */
export const NAMED: Record<string, [light: string, dark: string]> = {
  thinking: ['#7c3aed', '#a78bfa'],
  exploring: ['#0891b2', '#22d3ee'],
  coding: ['#2563eb', '#60a5fa'],
  documenting: ['#d97706', '#fbbf24'],
  testing: ['#059669', '#34d399'],
  validating: ['#db2777', '#f472b6'],
  other: [OTHER.light, OTHER.dark],
  success: ['#059669', '#34d399'],
  failed: ['#dc2626', '#f87171'],
  abandoned: ['#d97706', '#fbbf24'],
  unknown: [OTHER.light, OTHER.dark],
};

/** Colour of series `index` (cycles), or the fixed colour of a named series; `null` index = the grey "other". */
export function paletteColor(dark: boolean, index: number | null, name?: string): string {
  const fixed = name ? NAMED[name] : undefined;
  if (fixed) return dark ? fixed[1] : fixed[0];
  if (index === null) return dark ? OTHER.dark : OTHER.light;
  const palette = dark ? DARK : LIGHT;
  return palette[index % palette.length]!;
}
