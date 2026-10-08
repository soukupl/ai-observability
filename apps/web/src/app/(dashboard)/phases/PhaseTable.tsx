import { modelTitle } from '@/lib/model-name';
import { PHASES, type PhaseGroup, type PhaseRow } from '@/lib/queries/phases';
import { formatHours, formatShare, rowLabel, totalRow } from './helpers';

/** Same numbers as the chart: hours and share of the row's time per phase. Scrolls inside its wrapper. */
export function PhaseTable({ rows, group, groupLabel, exportHref }: { rows: PhaseRow[]; group: PhaseGroup; groupLabel: string; exportHref: string }) {
  const total = totalRow(rows);
  const cell = 'whitespace-nowrap px-2 py-2 text-right align-middle tabular-nums';
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <a
          href={exportHref}
          download
          className="inline-flex h-8 items-center rounded-md border border-zinc-300 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Export CSV
        </a>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Time per phase by {groupLabel.toLowerCase()}, in hours and share of the row</caption>
          <thead>
            <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th scope="col" className="whitespace-nowrap px-2 py-2 text-left font-medium">{groupLabel}</th>
              {PHASES.map((p) => (
                <th key={p} scope="col" className="whitespace-nowrap px-2 py-2 text-right font-medium capitalize">{p}</th>
              ))}
              <th scope="col" className="whitespace-nowrap px-2 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {[...rows.map((r) => ({ ...r, rowKey: r.key ?? '__none' })), { ...total, rowKey: '__total', label: 'All' }].map((r, i, all) => (
              <tr
                key={r.rowKey}
                className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800/60 ${i === all.length - 1 && all.length > 2 ? 'font-semibold' : ''}`}
              >
                <th scope="row" className="whitespace-nowrap px-2 py-2 text-left font-medium text-zinc-900 dark:text-zinc-100" title={group === 'model' && 'key' in r && typeof r.key === 'string' ? modelTitle(r.key) : undefined}>{rowLabel(r, group)}</th>
                {PHASES.map((p) => (
                  <td key={p} className={cell}>
                    {formatHours(r.ms[p])} <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatShare(r.share[p])}</span>
                  </td>
                ))}
                <td className={cell}>{formatHours(r.totalMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
