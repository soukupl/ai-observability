'use client';

import { useEffect, useRef } from 'react';

/**
 * "Download PDF": opens the browser's print dialog (every browser offers "Save as PDF" there). With `autoPrint`
 * (`?print=1`) the dialog opens once after the page has rendered. Hidden on paper (`print:hidden`).
 */
export function PrintButton({ autoPrint = false }: { autoPrint?: boolean }) {
  const fired = useRef(false);
  useEffect(() => {
    if (!autoPrint || fired.current) return;
    fired.current = true;
    const t = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(t);
  }, [autoPrint]);
  return (
    <div className="flex flex-col items-end gap-1 print:hidden">
      <button
        type="button"
        onClick={() => window.print()}
        className="inline-flex h-9 items-center rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700"
      >
        Download PDF
      </button>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">Uses your browser&apos;s Save as PDF.</span>
    </div>
  );
}
