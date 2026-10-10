'use client';

import { useEffect } from 'react';

/**
 * Reports are always light (paper is white): removes `.dark` from <html> while the report is mounted and restores
 * the viewer's theme on unmount. The chart components follow that class, so the SVGs print with dark text too.
 */
export function ForceLight() {
  useEffect(() => {
    const el = document.documentElement;
    const wasDark = el.classList.contains('dark');
    el.classList.remove('dark');
    return () => {
      if (wasDark) el.classList.add('dark');
    };
  }, []);
  return null;
}
