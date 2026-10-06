/**
 * Global dashboard filters (BRIEF §8) <-> URL search params. Pure and isomorphic: the FilterBar
 * (client) and the pages / export route (server) share it, so a URL always means the same thing.
 */

export const RANGE_PRESETS = ['7d', '30d', '90d', '12m'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export type RangeKind = RangePreset | 'custom';
export const DEFAULT_RANGE: RangePreset = '30d';

/** Longest custom range accepted (days); longer ones fall back to the default. */
export const MAX_CUSTOM_DAYS = 800;

export interface Filters {
  range: RangeKind;
  /** Custom range only: first day, YYYY-MM-DD (UTC). */
  from: string | null;
  /** Custom range only: last day INCLUDED, YYYY-MM-DD (UTC). */
  to: string | null;
  teamId: string | null;
  projectId: string | null;
  /** Only honoured when the viewer may see individuals (see queries/scope canSeeUsers). */
  userId: string | null;
  harness: string | null;
  model: string | null;
  effort: string | null;
}

export type SearchParamsInput = URLSearchParams | Record<string, string | string[] | undefined>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** harness / model / effort values: ids such as `claude-opus-5-5`, `gpt-5.4`, `high`. */
const WORD_RE = /^[\w.:/+ -]{1,100}$/;

export function defaultFilters(): Filters {
  return { range: DEFAULT_RANGE, from: null, to: null, teamId: null, projectId: null, userId: null, harness: null, model: null, effort: null };
}

function first(input: SearchParamsInput, key: string): string | null {
  const v = input instanceof URLSearchParams ? input.get(key) : input[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === '' ? null : s;
}

/** True for a real calendar day in YYYY-MM-DD form. */
export function isValidDay(s: string | null | undefined): s is string {
  if (!s || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function uuid(v: string | null): string | null {
  return v && UUID_RE.test(v) ? v.toLowerCase() : null;
}
function word(v: string | null): string | null {
  return v && WORD_RE.test(v) ? v : null;
}

/** Parses untrusted search params. Anything invalid falls back to the default instead of throwing. */
export function parseFilters(input: SearchParamsInput, opts: { allowUser?: boolean } = {}): Filters {
  const f = defaultFilters();
  const range = first(input, 'range');
  if ((RANGE_PRESETS as readonly string[]).includes(range ?? '')) {
    f.range = range as RangePreset;
  } else if (range === 'custom') {
    const from = first(input, 'from');
    const to = first(input, 'to');
    if (isValidDay(from) && isValidDay(to) && from <= to) {
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
      if (days <= MAX_CUSTOM_DAYS) Object.assign(f, { range: 'custom', from, to });
    }
  }
  f.teamId = uuid(first(input, 'teamId'));
  f.projectId = uuid(first(input, 'projectId'));
  f.userId = opts.allowUser ? uuid(first(input, 'userId')) : null;
  f.harness = word(first(input, 'harness'));
  f.model = word(first(input, 'model'));
  f.effort = word(first(input, 'effort'));
  return f;
}

/** Serializes filters; defaults are omitted so the default view has a clean URL. */
export function serializeFilters(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.range === 'custom' && f.from && f.to) {
    p.set('range', 'custom');
    p.set('from', f.from);
    p.set('to', f.to);
  } else if (f.range !== DEFAULT_RANGE && f.range !== 'custom') {
    p.set('range', f.range);
  }
  for (const key of ['teamId', 'projectId', 'userId', 'harness', 'model', 'effort'] as const) {
    const v = f[key];
    if (v) p.set(key, v);
  }
  return p;
}

/** `?a=b&c=d` or '' — for building links that keep the current filters. */
export function filtersQuery(f: Filters, extra: Record<string, string | number | null | undefined> = {}): string {
  const p = serializeFilters(f);
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Plain-object form for the audit log (`meta.filters`): only non-default fields. */
export function filtersForAudit(f: Filters): Record<string, string> {
  return Object.fromEntries(serializeFilters(f).entries());
}
