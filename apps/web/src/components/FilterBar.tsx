'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';
import { modelLabels } from '@/lib/model-name';
import { defaultFilters, isValidDay, parseFilters, serializeFilters, type Filters, type RangeKind } from '@/lib/filters';

/** Plain, serializable option lists the server passes in (see lib/queries loadFilterOptions). */
export interface FilterBarOptions {
  teams: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  /** null = the viewer may not filter by person (aggregates-only mode, or a member). */
  users: { id: string; name: string }[] | null;
  harnesses: string[];
  models: string[];
  efforts: string[];
}

const RANGE_LABELS: Record<RangeKind, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  '12m': 'Last 12 months',
  custom: 'Custom range',
};
/** Query params owned by the filter bar; everything else (view options such as `group`) is kept. */
const FILTER_KEYS = ['range', 'from', 'to', 'teamId', 'projectId', 'userId', 'harness', 'model', 'effort'];
const RESET_KEYS = ['page'];

const field =
  'h-9 w-full rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
      {label}
      {children}
    </label>
  );
}

/**
 * The global filter bar (BRIEF §8). It only writes the URL: every page parses the same search
 * params with parseFilters(), so views are linkable and the CSV export re-runs the exact filters.
 */
export function FilterBar({ filters, options }: { filters: Filters; options: FilterBarOptions }) {
  const modelNames = modelLabels(options.models); // friendly labels; values stay raw ids; raw id where names collide
  const router = useRouter();
  const pathname = usePathname();
  const current = useSearchParams();
  const [pending, start] = useTransition();

  function push(next: Filters) {
    const params = new URLSearchParams(current.toString());
    for (const k of [...FILTER_KEYS, ...RESET_KEYS]) params.delete(k);
    for (const [k, v] of serializeFilters(next)) params.set(k, v);
    const q = params.toString();
    start(() => router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false }));
  }
  const set = (patch: Partial<Filters>) => push({ ...filters, ...patch });
  const select = (key: 'teamId' | 'projectId' | 'userId' | 'harness' | 'model' | 'effort') => ({
    value: filters[key] ?? '',
    onChange: (e: { target: { value: string } }) => set({ [key]: e.target.value || null }),
    className: field,
  });

  const isDefault = serializeFilters(filters).toString() === '';
  const custom = filters.range === 'custom';

  function setRange(range: RangeKind) {
    if (range !== 'custom') return set({ range, from: null, to: null });
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    set({ range: 'custom', from: filters.from ?? from, to: filters.to ?? to });
  }
  function setDay(which: 'from' | 'to', value: string) {
    if (!isValidDay(value)) return;
    const next = { ...filters, range: 'custom' as const, [which]: value };
    const reparsed = parseFilters(serializeFilters(next), { allowUser: true });
    if (reparsed.range === 'custom') push(next); // ignores a reversed or too long range
  }

  return (
    <form
      role="search"
      aria-label="Filters"
      aria-busy={pending}
      onSubmit={(e) => e.preventDefault()}
      className={`mb-4 grid grid-cols-2 gap-3 rounded-xl border border-zinc-200 bg-white p-3 sm:grid-cols-3 lg:grid-cols-6 dark:border-zinc-800 dark:bg-zinc-900 ${pending ? 'opacity-70' : ''}`}
    >
      <Field label="Period">
        <select value={filters.range} onChange={(e) => setRange(e.target.value as RangeKind)} className={field}>
          {(Object.keys(RANGE_LABELS) as RangeKind[]).map((k) => (
            <option key={k} value={k}>
              {RANGE_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      {custom && (
        <>
          <Field label="From">
            <input type="date" value={filters.from ?? ''} onChange={(e) => setDay('from', e.target.value)} className={field} />
          </Field>
          <Field label="To">
            <input type="date" value={filters.to ?? ''} onChange={(e) => setDay('to', e.target.value)} className={field} />
          </Field>
        </>
      )}
      <Field label="Team">
        <select {...select('teamId')}>
          <option value="">All teams</option>
          {options.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Project">
        <select {...select('projectId')}>
          <option value="">All projects</option>
          {options.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      {options.users && (
        <Field label="User">
          <select {...select('userId')}>
            <option value="">Everyone</option>
            {options.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Harness">
        <select {...select('harness')}>
          <option value="">All harnesses</option>
          {options.harnesses.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Model">
        <select {...select('model')}>
          <option value="">All models</option>
          {options.models.map((m) => (
            <option key={m} value={m}>
              {modelNames[m] ?? m}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Effort">
        <select {...select('effort')}>
          <option value="">All efforts</option>
          {options.efforts.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </Field>
      {!isDefault && (
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => push(defaultFilters())}
            className="h-9 rounded-md border border-zinc-300 px-3 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Reset
          </button>
        </div>
      )}
    </form>
  );
}
