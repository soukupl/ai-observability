/**
 * Friendly model names for display: "claude-opus-5-5" -> provider "Anthropic", name "Opus 5.5".
 * Pure and client-safe (no React, no DB). Display only: filters, grouping keys, chart series keys,
 * React keys and CSV export keep the raw id. Unknown ids (and sentinels such as "(unknown)" or
 * "other") pass through verbatim with provider null. Never throws.
 */

export interface ModelName {
  /** "Anthropic" | "OpenAI" | "Google", or null for an unknown id. */
  provider: string | null;
  /** Display name: "Opus 5.5", "GPT-5.4 mini"; the raw id when unknown. */
  name: string;
  /** The raw id, unchanged. */
  id: string;
}

type Family = { provider: string; parse: (id: string) => string | null };

const DATE = /^\d{8}$/;
const VERSION = /^\d{1,4}(?:\.\d+)*$/;
const capitalise = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);

/** "claude-opus-5-5[1m]", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-haiku-4-5@20251001", "claude-3-5-sonnet-20241022". */
function claude(id: string): string | null {
  let s = id.replace(/^anthropic\//, '').replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '');
  if (!s.startsWith('claude-')) return null;
  let context = '';
  const ctx = /\[(\d+[km])\]$/.exec(s);
  if (ctx) {
    context = ` (${ctx[1]!.toUpperCase()})`;
    s = s.slice(0, ctx.index);
  }
  s = s.replace(/@.*$/, '').replace(/-v\d+(?::\d+)?$/, '');
  const tokens = s.slice('claude-'.length).split('-').filter((t) => t && !DATE.test(t) && t !== 'latest');
  // New ids put the family first ("opus-5-5"); older ones put the version first ("3-5-sonnet").
  const version: string[] = [];
  let family = '';
  let i = 0;
  while (i < tokens.length && VERSION.test(tokens[i]!)) version.push(tokens[i++]!);
  if (i < tokens.length && /^[a-z]+$/.test(tokens[i]!)) family = tokens[i++]!;
  if (version.length === 0) while (i < tokens.length && VERSION.test(tokens[i]!)) version.push(tokens[i++]!);
  const rest = tokens.slice(i);
  if (!family && version.length === 0) return null;
  const parts = [family ? capitalise(family) : 'Claude', version.join('.'), ...rest].filter(Boolean);
  return parts.join(' ') + context;
}

/** "gpt-5.4-mini" -> "GPT-5.4 mini", "o4-mini" -> "o4-mini". A trailing snapshot date is dropped. */
function openai(id: string): string | null {
  const s = id.replace(/^openai\//, '').replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  if (/^o\d+(?:-[a-z0-9]+)*$/.test(s)) return s;
  if (!s.startsWith('gpt-')) return null;
  const [head, ...rest] = s.slice('gpt-'.length).split('-');
  if (!head) return null;
  return [`GPT-${head}`, ...rest].join(' ');
}

/** "gemini-2.5-pro" -> "Gemini 2.5 pro". */
function gemini(id: string): string | null {
  const s = id.replace(/^(?:google\/|models\/)/, '');
  if (!s.startsWith('gemini-') || s.length === 'gemini-'.length) return null;
  return `Gemini ${s.slice('gemini-'.length).split('-').join(' ')}`;
}

/** Known families, tried in order. Extend here. */
const FAMILIES: Family[] = [
  { provider: 'Anthropic', parse: claude },
  { provider: 'OpenAI', parse: openai },
  { provider: 'Google', parse: gemini },
];

/** Parsed ids by raw id: a dashboard sees a handful of distinct models, and table sorts parse per comparison. */
const cache = new Map<string, ModelName>();

/** Split a raw model id into provider and display name; unknown ids keep the raw id as name. */
export function parseModel(id: string): ModelName {
  const raw = typeof id === 'string' ? id : '';
  const hit = cache.get(raw);
  if (hit) return hit;
  const key = raw.trim().toLowerCase();
  let parsed: ModelName = { provider: null, name: raw, id: raw };
  if (key) {
    for (const f of FAMILIES) {
      try {
        const name = f.parse(key);
        if (name) {
          parsed = { provider: f.provider, name, id: raw };
          break;
        }
      } catch {
        // a malformed id falls through to the verbatim fallback
      }
    }
  }
  cache.set(raw, parsed);
  return parsed;
}

/** Display name of a model id ("Opus 5.5"); "—" when missing. */
export function formatModel(id: string | null | undefined): string {
  if (id === null || id === undefined || id === '') return '—';
  return parseModel(id).name;
}

/** Provider of a model id ("Anthropic"); "—" when missing or unknown. */
export function modelProvider(id: string | null | undefined): string {
  if (id === null || id === undefined || id === '') return '—';
  return parseModel(id).provider ?? '—';
}

/** Tooltip for a friendly name: the raw id when it differs from the name, else nothing (no redundant tooltip). */
export function modelTitle(id: string): string | undefined {
  const name = formatModel(id);
  return name !== id ? id : undefined;
}

/** "Opus 5.5 · high"; either part may be missing; "" when both are. */
export function formatModelEffort(model: string | null | undefined, effort: string | null | undefined): string {
  return [model ? formatModel(model) : null, effort || null].filter(Boolean).join(' · ');
}

/**
 * Unique display labels for a list of raw ids shown side by side (chart bars, legends, select options, joined
 * lists): the friendly name, or the raw id for ids whose friendly names collide (a dated and an undated snapshot
 * of one model), so two entries never read the same. Single cells use formatModel + modelTitle instead.
 */
export function modelLabels(ids: readonly string[]): Record<string, string> {
  const names = new Map(ids.map((id) => [id, formatModel(id)]));
  const count = new Map<string, number>();
  for (const name of names.values()) count.set(name, (count.get(name) ?? 0) + 1);
  return Object.fromEntries([...names].map(([id, name]) => [id, (count.get(name) ?? 0) > 1 ? id : name]));
}
