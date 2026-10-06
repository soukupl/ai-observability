'use client';

import { useSyncExternalStore } from 'react';

/** One categorical palette for every chart (distinguishable in light and dark, colour-blind friendly order). */
const LIGHT = ['#2563eb', '#d97706', '#059669', '#db2777', '#7c3aed', '#0891b2', '#65a30d', '#dc2626'];
const DARK = ['#60a5fa', '#fbbf24', '#34d399', '#f472b6', '#a78bfa', '#22d3ee', '#a3e635', '#f87171'];
const OTHER = { light: '#71717a', dark: '#a1a1aa' };

/** Fixed colours so a phase or outcome looks the same on every page. */
const NAMED: Record<string, [light: string, dark: string]> = {
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

export interface ChartTheme {
  dark: boolean;
  /** Colour of series number `i` (cycles), or the fixed colour of a named series. */
  color: (index: number, name?: string) => string;
  text: string;
  grid: string;
  axis: string;
  tooltipBg: string;
  tooltipBorder: string;
}

export function makeChartTheme(dark: boolean): ChartTheme {
  const palette = dark ? DARK : LIGHT;
  return {
    dark,
    color: (index, name) => {
      const fixed = name ? NAMED[name] : undefined;
      if (fixed) return dark ? fixed[1] : fixed[0];
      return palette[index % palette.length]!;
    },
    text: dark ? '#e4e4e7' : '#27272a',
    grid: dark ? '#3f3f46' : '#e4e4e7',
    axis: dark ? '#a1a1aa' : '#71717a',
    tooltipBg: dark ? '#18181b' : '#ffffff',
    tooltipBorder: dark ? '#3f3f46' : '#e4e4e7',
  };
}

function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => obs.disconnect();
}

/** Follows the `.dark` class on <html> (theme toggle, system preference script) without a re-render of the page. */
export function useChartTheme(): ChartTheme {
  const dark = useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );
  return makeChartTheme(dark);
}
