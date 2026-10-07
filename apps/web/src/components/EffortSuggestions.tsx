import type { EffortAdvice } from '@/lib/queries/effort';
import { ADVISOR_RULES } from '@/lib/effort-advisor';
import { Card } from './Card';
import { formatCost, formatDuration, formatInt, formatPercent } from './format';

/** "Suggestions" card of the effort advisor (docs/briefs/effort-advisor.md); `showProject` lists the project per row. */
export function EffortSuggestions({ advice, showProject = true }: { advice: EffortAdvice; showProject?: boolean }) {
  const r = ADVISOR_RULES;
  return (
    <Card
      title="Effort suggestions"
      description="Where a lower effort level succeeded about as often for clearly less ≈ cost, in this range."
    >
      {!advice.available ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Suggestions compare medians of raw turns: pick a range within the last 35 days (and inside your retention window).
        </p>
      ) : advice.suggestions.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Nothing to suggest: no lower effort level qualified (each level needs {r.minDecided}+ decided turns, success at most{' '}
          {Math.round(r.maxSuccessDrop * 100)} points lower, median ≈ cost at least {Math.round((1 - r.maxCostRatio) * 100)} % lower, and ≈ $
          {r.minSavingsUsd}+ saved).
        </p>
      ) : (
        <ul className="space-y-3">
          {advice.suggestions.map((s) => (
            <li
              key={`${s.projectId}-${s.model}-${s.from.effort}`}
              className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800"
            >
              <p className="font-medium text-zinc-900 dark:text-zinc-100">
                {showProject && <span>{s.projectName ?? 'No project'} · </span>}
                {s.model}: <code>{s.to.effort}</code> instead of <code>{s.from.effort}</code> would have cost ≈ {formatPercent(s.costReduction)} less
                per turn, {formatCost(s.savingsUsd)} over {formatInt(s.from.turns)} turns.
              </p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Success {formatPercent(s.from.successRate)} (n = {formatInt(s.from.decided)}) vs {formatPercent(s.to.successRate)} (n ={' '}
                {formatInt(s.to.decided)}); median {formatCost(s.from.medianCostUsd)} vs {formatCost(s.to.medianCostUsd)} per turn; median time{' '}
                {formatDuration(s.from.medianDurationMs)} vs {formatDuration(s.to.medianDurationMs)}.
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        Observed, not tested: people may pick a higher effort for harder tasks. Costs are ≈ at API list prices.
        {advice.ignoredFilters.includes('effort') && ' The effort filter is not applied here.'}
      </p>
    </Card>
  );
}
