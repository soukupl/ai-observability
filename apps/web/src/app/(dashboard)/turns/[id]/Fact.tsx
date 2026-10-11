import type { ReactNode } from 'react';

/** One label / value pair of a facts grid (`<dl>`), shared by the turn's cards and its flow sections. */
export function Fact({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-zinc-900 dark:text-zinc-100">{children}</dd>
    </div>
  );
}
