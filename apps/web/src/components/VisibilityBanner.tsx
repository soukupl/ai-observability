type Mode = 'aggregates-only' | 'full';

const TEXT: Record<Mode, { short: string; long: string }> = {
  'aggregates-only': {
    short: 'Individual visibility: aggregates only',
    long: 'Leads and admins see totals by team, project, model, phase and agent, but no per-person rows. You always see your own detail.',
  },
  full: {
    short: 'Individual visibility: full detail',
    long: 'Leads see their teams’ turns by person and admins see everyone’s. You always see your own detail.',
  },
};

/**
 * The deployment's individual-visibility mode (ADR-0008) must be visible to every user: this banner
 * sits on top of the dashboard and `variant="footer"` is the one-line reminder in the page footer.
 */
export function VisibilityBanner({ mode, variant = 'banner' }: { mode: Mode; variant?: 'banner' | 'footer' }) {
  const t = TEXT[mode];
  if (variant === 'footer') {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400" data-visibility-mode={mode}>
        {t.short}. Costs are estimates at API list prices.
      </p>
    );
  }
  return (
    <div
      role="note"
      data-visibility-mode={mode}
      className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
    >
      <strong className="font-semibold">{t.short}.</strong> {t.long}
    </div>
  );
}
