import type { Plan } from '@ai-obs/db';
import { isPlan } from './plans';

/** Input validation for the console forms. Pure; every function returns a value or an error string. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function parseName(raw: unknown): Result<string> {
  const v = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (v.length < 2 || v.length > 80) return { ok: false, error: 'Company name must be 2 to 80 characters.' };
  return { ok: true, value: v };
}

export function parseSlug(raw: unknown): Result<string> {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!SLUG_RE.test(v)) return { ok: false, error: 'Slug: 1 to 40 characters, a-z, 0-9 and "-", not starting or ending with "-".' };
  return { ok: true, value: v };
}

/** A URL-safe slug suggested from a name (the form pre-fills nothing; used when the slug field is empty). */
export function slugFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
}

export function parseEmail(raw: unknown): Result<string> {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v.length > 254 || !EMAIL_RE.test(v)) return { ok: false, error: 'Enter a valid e-mail address.' };
  return { ok: true, value: v };
}

export function parsePlan(raw: unknown): Result<Plan> {
  return isPlan(raw) ? { ok: true, value: raw } : { ok: false, error: 'Choose a plan: free, team or business.' };
}
