'use client';

import { useSyncExternalStore } from 'react';
import { paletteColor } from './chart-palette';

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
  return {
    dark,
    color: (index, name) => paletteColor(dark, index, name),
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
