'use client';

import { useState } from 'react';

/** A value in monospace with a "Copy" button (the session id, the resume command). */
export function CopyText({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="inline-flex max-w-full items-center gap-2">
      <code className="min-w-0 truncate rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800" title={text}>
        {text}
      </code>
      <button
        type="button"
        aria-label={`${label}: ${text}`}
        className="shrink-0 rounded-md border border-zinc-300 px-2 py-0.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setDone(true));
        }}
      >
        {done ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
