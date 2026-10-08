import type { ReactNode } from 'react';

type Tone = 'neutral' | 'good' | 'bad' | 'warn' | 'info';
const TONES: Record<Tone, string> = {
  neutral: 'bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900',
  bad: 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-950 dark:text-red-300 dark:ring-red-900',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900',
  info: 'bg-blue-50 text-blue-800 ring-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-900',
};

export function Badge({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {children}
    </span>
  );
}

const OUTCOME: Record<string, { tone: Tone; title: string }> = {
  success: { tone: 'good', title: 'Last test / validate passed, or no failure signal' },
  failed: { tone: 'bad', title: 'Error, failing test, or the next prompt was a correction' },
  abandoned: { tone: 'warn', title: 'Interrupted by the user' },
  unknown: { tone: 'neutral', title: 'No signal either way (for example no tests ran)' },
};

/** Turn / run outcome (ADR-0003). `unknown` is shown, never hidden. */
export function OutcomeBadge({ outcome }: { outcome: string }) {
  const o = OUTCOME[outcome] ?? OUTCOME.unknown!;
  return (
    <Badge tone={o.tone} title={o.title}>
      {outcome}
    </Badge>
  );
}

const ATTRIBUTION: Record<string, { tone: Tone; title: string }> = {
  verified: { tone: 'good', title: 'Sent with the person\'s own token' },
  matched: { tone: 'info', title: 'Company token, matched to a member by git e-mail' },
  unverified: { tone: 'warn', title: 'Company token, no matching member' },
};

/** How a turn was tied to a user (ADR-0007). Only shown where individuals are visible. */
export function AttributionBadge({ attribution }: { attribution: string }) {
  const a = ATTRIBUTION[attribution] ?? { tone: 'neutral' as Tone, title: attribution };
  return (
    <Badge tone={a.tone} title={a.title}>
      {attribution}
    </Badge>
  );
}
