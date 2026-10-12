import type { ReactNode } from 'react';

/**
 * Secondary details of a card, collapsed by default behind a "More" toggle (native `<details>`, so it needs no client
 * JS and the browser's find-in-page still opens it). `hint` names what is inside while it is closed.
 */
export function More({ label = 'More', hint, children }: { label?: string; hint?: string; children: ReactNode }) {
  return (
    <details className="group mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
      <summary className="flex cursor-pointer list-none items-baseline gap-1.5 text-sm [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block w-3 text-xs text-zinc-400 transition-transform group-open:rotate-90">
          ▸
        </span>
        <span className="font-medium text-blue-700 hover:underline dark:text-blue-400">
          <span className="group-open:hidden">{label}</span>
          <span className="hidden group-open:inline">Less</span>
        </span>
        {hint && <span className="truncate text-xs text-zinc-500 group-open:hidden dark:text-zinc-400">{hint}</span>}
      </summary>
      <div className="mt-3 space-y-5">{children}</div>
    </details>
  );
}

/** A titled block inside a `More` (a former card, now a sub-section of its parent card). */
export function MoreBlock({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h3>
      {description && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}
