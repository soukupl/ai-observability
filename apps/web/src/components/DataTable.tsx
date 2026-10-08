'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { CostValue } from '@/lib/cost';
import { OutcomeBadge } from './Badge';
import { Sparkline } from './charts/Sparkline';
import { formatCost, formatDateTime, formatDuration, formatInt, formatPercent, formatTokens } from './format';

/**
 * How a cell value is shown. Rows are plain serializable objects (a server page passes them to this
 * client component), so formatting is chosen by `kind` instead of a render function.
 *   text      string | null
 *   int       number
 *   tokens    number              compact: 1.2k, 3.4M
 *   cost      CostValue | number  "≈ $1.23", "n/a" when unknown
 *   percent   fraction 0..1
 *   duration  milliseconds
 *   datetime  epoch milliseconds (UTC)
 *   outcome   success | failed | abandoned | unknown
 *   sparkline number[]
 */
export type CellKind = 'text' | 'int' | 'tokens' | 'cost' | 'percent' | 'duration' | 'datetime' | 'outcome' | 'sparkline';

export interface Column {
  key: string;
  header: string;
  kind?: CellKind;
  align?: 'left' | 'right';
  /** Default: true, except sparkline. */
  sortable?: boolean;
  /** Row field holding a URL: the cell becomes a link. */
  hrefKey?: string;
  /** Tooltip on the header (explain a metric). */
  hint?: string;
}

export type Row = Record<string, unknown>;

function sortValue(kind: CellKind, v: unknown): number | string | null {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case 'cost':
      return typeof v === 'number' ? v : (v as CostValue).usd;
    case 'sparkline':
      return (v as number[]).reduce((a, b) => a + b, 0);
    case 'text':
    case 'outcome':
      return String(v).toLowerCase();
    default:
      return typeof v === 'number' ? v : Number(v);
  }
}

function Cell({ kind, value }: { kind: CellKind; value: unknown }) {
  switch (kind) {
    case 'int':
      return <>{formatInt(value as number | null)}</>;
    case 'tokens':
      return <>{formatTokens(value as number | null)}</>;
    case 'cost':
      return <>{formatCost(value as CostValue | number | null)}</>;
    case 'percent':
      return <>{formatPercent(value as number | null)}</>;
    case 'duration':
      return <>{formatDuration(value as number | null)}</>;
    case 'datetime':
      return <>{typeof value === 'number' ? formatDateTime(value) : '—'}</>;
    case 'outcome':
      return value ? <OutcomeBadge outcome={String(value)} /> : <>—</>;
    case 'sparkline':
      return <Sparkline values={(value as number[]) ?? []} />;
    default:
      return <>{value === null || value === undefined || value === '' ? '—' : String(value)}</>;
  }
}

export function DataTable({
  columns,
  rows,
  caption,
  emptyMessage = 'No data for this selection.',
  exportHref,
  defaultSort,
  rowKey,
}: {
  columns: Column[];
  rows: Row[];
  caption?: string;
  emptyMessage?: string;
  /** Link to /api/export (see export-url.ts); shows the "Export CSV" button. */
  exportHref?: string;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /** Row field used as React key (default: row index). */
  rowKey?: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const kind = col.kind ?? 'text';
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = sortValue(kind, a[col.key]);
      const y = sortValue(kind, b[col.key]);
      if (x === null && y === null) return 0;
      if (x === null) return 1; // empty values always last
      if (y === null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * factor;
      return String(x).localeCompare(String(y)) * factor;
    });
  }, [rows, columns, sort]);

  function toggle(col: Column) {
    setSort((s) => (s?.key === col.key ? { key: col.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: col.kind === 'text' || !col.kind ? 'asc' : 'desc' }));
  }

  return (
    <div>
      {exportHref && (
        <div className="mb-2 flex justify-end">
          <a
            href={exportHref}
            download
            className="inline-flex h-8 items-center rounded-md border border-zinc-300 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Export CSV
          </a>
        </div>
      )}
      {sorted.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          {emptyMessage}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            {caption && <caption className="sr-only">{caption}</caption>}
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                {columns.map((c) => {
                  const kind = c.kind ?? 'text';
                  const sortable = c.sortable ?? kind !== 'sparkline';
                  const right = (c.align ?? (kind === 'text' || kind === 'outcome' ? 'left' : 'right')) === 'right';
                  const active = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      title={c.hint}
                      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={`whitespace-nowrap px-2 py-2 font-medium ${right ? 'text-right' : 'text-left'}`}
                    >
                      {sortable ? (
                        <button type="button" onClick={() => toggle(c)} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                          {c.header}
                          <span aria-hidden className={active ? '' : 'opacity-30'}>
                            {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                          </span>
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <tr key={rowKey ? String(row[rowKey]) : i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  {columns.map((c) => {
                    const kind = c.kind ?? 'text';
                    const right = (c.align ?? (kind === 'text' || kind === 'outcome' ? 'left' : 'right')) === 'right';
                    const href = c.hrefKey ? (row[c.hrefKey] as string | undefined) : undefined;
                    const content = <Cell kind={kind} value={row[c.key]} />;
                    return (
                      <td key={c.key} className={`px-2 py-2 align-middle tabular-nums ${right ? 'text-right' : 'text-left'}${kind === 'cost' ? ' whitespace-nowrap' : ''}`}>
                        {href ? (
                          <Link href={href} className="font-medium text-blue-700 hover:underline dark:text-blue-400">
                            {content}
                          </Link>
                        ) : (
                          content
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
