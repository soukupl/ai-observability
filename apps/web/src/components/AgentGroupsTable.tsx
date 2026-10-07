'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import type { AgentGroupRow } from '@/app/(dashboard)/agents/agents-view';
import { formatInt, formatPercent, formatTokens } from './format';

/**
 * Agents table: one row per agent group (ADR-0019) that expands to its raw agent types as indented
 * sub-rows. Same columns and visual language as DataTable, plus a "Types" count. Groups start collapsed,
 * except when there is only one. Props are plain data (a server page passes them).
 */

type SortKey = 'group' | 'typeCount' | 'spawns' | 'tokens' | 'tokenShare' | 'successRate' | 'unknownShare' | 'avgDepth' | 'maxDepth';
interface Col {
  key: SortKey;
  header: string;
  align: 'left' | 'right';
  hint?: string;
}

const COLS: Col[] = [
  { key: 'group', header: 'Agent group', align: 'left', hint: 'Logical kind of sub-agent; expand a row to see its raw agent types.' },
  { key: 'typeCount', header: 'Types', align: 'right', hint: 'Distinct raw agent types in the group.' },
  { key: 'spawns', header: 'Spawns', align: 'right', hint: 'Sub-agent runs started.' },
  { key: 'tokens', header: 'Tokens', align: 'right' },
  { key: 'tokenShare', header: 'Token share', align: 'right', hint: 'Share of all sub-agent tokens.' },
  { key: 'successRate', header: 'Success rate', align: 'right', hint: 'Successful runs / runs with a known outcome.' },
  { key: 'unknownShare', header: 'Unknown', align: 'right', hint: 'Runs whose outcome could not be determined; not counted as failures.' },
  { key: 'avgDepth', header: 'Avg depth', align: 'right' },
  { key: 'maxDepth', header: 'Max depth', align: 'right' },
];

function sortValue(g: AgentGroupRow, key: SortKey): number | string | null {
  switch (key) {
    case 'group':
      return g.group.toLowerCase();
    case 'typeCount':
      return g.types.length;
    case 'tokens':
      return g.tokens.total;
    default:
      return g[key];
  }
}

const depth = (v: number | null): string => (v === null ? '—' : String(Math.round(v * 10) / 10));
const domId = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');

export function AgentGroupsTable({
  rows,
  exportHref,
  emptyMessage = 'No sub-agent runs for this selection.',
  caption = 'Sub-agent usage per agent group',
}: {
  rows: AgentGroupRow[];
  /** Link to /api/export (see export-url.ts); shows the "Export CSV" button. */
  exportHref?: string;
  emptyMessage?: string;
  caption?: string;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(rows.length === 1 ? [rows[0]!.group] : []));
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      if (x === null && y === null) return 0;
      if (x === null) return 1; // empty values always last
      if (y === null) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * factor || a.group.localeCompare(b.group);
      return String(x).localeCompare(String(y)) * factor;
    });
  }, [rows, sort]);

  const allOpen = rows.length > 0 && rows.every((g) => open.has(g.group));
  const toggle = (group: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  const toggleSort = (c: Col) =>
    setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.key === 'group' ? 'asc' : 'desc' }));

  const btn =
    'inline-flex h-8 items-center rounded-md border border-zinc-300 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800';

  return (
    <div>
      {(exportHref || rows.length > 1) && (
        <div className="mb-2 flex justify-end gap-2">
          {rows.length > 1 && (
            <button type="button" className={btn} onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map((g) => g.group)))}>
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          {exportHref && (
            <a href={exportHref} download className={btn}>
              Export CSV
            </a>
          )}
        </div>
      )}
      {sorted.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          {emptyMessage}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                {COLS.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      title={c.hint}
                      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                      className={`whitespace-nowrap px-2 py-2 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                    >
                      <button type="button" onClick={() => toggleSort(c)} className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100">
                        {c.header}
                        <span aria-hidden className={active ? '' : 'opacity-30'}>
                          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((g) => {
                const expanded = open.has(g.group);
                const subIds = g.types.map((_, i) => `agent-group-${domId(g.group)}-${i}`);
                return (
                  <Fragment key={g.group}>
                    <tr className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                      <th scope="row" className="px-2 py-2 text-left align-middle font-normal">
                        <button
                          type="button"
                          onClick={() => toggle(g.group)}
                          aria-expanded={expanded}
                          aria-controls={expanded ? subIds.join(' ') : undefined}
                          className="inline-flex items-center gap-1.5 text-left font-medium text-zinc-900 hover:text-blue-700 dark:text-zinc-100 dark:hover:text-blue-400"
                        >
                          <span aria-hidden className={`inline-block w-3 text-[10px] text-zinc-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>
                            ▶
                          </span>
                          <span className="break-all">{g.group}</span>
                          <span className="sr-only">{expanded ? ', hide agent types' : ', show agent types'}</span>
                        </button>
                      </th>
                      <Num>{formatInt(g.types.length)}</Num>
                      <Num>{formatInt(g.spawns)}</Num>
                      <Num>{formatTokens(g.tokens.total)}</Num>
                      <Num>{formatPercent(g.tokenShare)}</Num>
                      <Num>{formatPercent(g.successRate)}</Num>
                      <Num>{formatPercent(g.unknownShare)}</Num>
                      <Num>{depth(g.avgDepth)}</Num>
                      <Num>{formatInt(g.maxDepth)}</Num>
                    </tr>
                    {expanded &&
                      g.types.map((t, i) => (
                        <tr
                          key={`${t.agentType}\u0000${i}`}
                          id={subIds[i]}
                          className="border-b border-zinc-100 bg-zinc-50/60 text-zinc-600 last:border-0 dark:border-zinc-800/60 dark:bg-zinc-900/40 dark:text-zinc-400"
                        >
                          <td className="py-1.5 pl-8 pr-2 text-left align-middle">
                            <span className="break-all font-mono text-xs">{t.agentType}</span>
                          </td>
                          <Num small>{''}</Num>
                          <Num small>{formatInt(t.spawns)}</Num>
                          <Num small>{formatTokens(t.tokens.total)}</Num>
                          <Num small>{formatPercent(t.tokenShare)}</Num>
                          <Num small>{formatPercent(t.successRate)}</Num>
                          <Num small>{formatPercent(t.unknownShare)}</Num>
                          <Num small>{depth(t.avgDepth)}</Num>
                          <Num small>{formatInt(t.maxDepth)}</Num>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Num({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return <td className={`px-2 ${small ? 'py-1.5 text-xs' : 'py-2'} text-right align-middle tabular-nums`}>{children}</td>;
}
