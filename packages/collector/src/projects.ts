import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { cacheInfo, readCache, type CacheInfo } from './cc-cache.js';
import {
  epochAt,
  identityMatches,
  identityOf,
  loadConfig,
  type CollectorConfig,
  type CompanyLabel,
  type TokenEntry,
  type TokenIdentity,
} from './config.js';
import { readDelivery, tokenDelivery, type Blocked } from './delivery.js';
import { errorMessage, writeJsonAtomic } from './fsutil.js';
import type { AiObsPaths } from './paths.js';
import { ulid } from './ulid.js';

/**
 * One repository's choice in projects.json (written only by `ai-obs use`, C23). `token` is the name at
 * assignment time, for display only; routing uses the identity fields (C8). A hand-written entry without
 * `endpoint` / `token_fp` loads with empty strings and never matches a token (dangling).
 */
export type Assignment =
  | { token: string; endpoint: string; company_slug?: string; token_fp: string; assigned_at: string }
  | { token: null; none: true; assigned_at: string };
export type ExplicitAssignment = Extract<Assignment, { token: string }>;

/** Missing file → ok with no entries. `mode` = the file's permission bits when it exists (doctor). */
export type ProjectsState =
  | { status: 'ok'; entries: Record<string, Assignment>; mode?: number }
  | { status: 'unreadable'; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseAssignment(v: unknown): Assignment | null {
  if (!isObject(v)) return null;
  const at = typeof v.assigned_at === 'string' ? v.assigned_at : null;
  if (at === null) return null;
  if (v.token === null && v.none === true) return { token: null, none: true, assigned_at: at };
  if (typeof v.token !== 'string' || !v.token) return null;
  return {
    token: v.token,
    endpoint: typeof v.endpoint === 'string' ? v.endpoint : '',
    ...(typeof v.company_slug === 'string' && v.company_slug ? { company_slug: v.company_slug } : {}),
    token_fp: typeof v.token_fp === 'string' ? v.token_fp : '',
    assigned_at: at,
  };
}

/**
 * Reads projects.json. Any entry that is not a valid assignment makes the whole file unreadable: a
 * damaged `--none` must not silently turn into "no choice" (C23). Never throws.
 */
export function loadProjects(paths: Pick<AiObsPaths, 'projects'>): ProjectsState {
  let text: string;
  let mode: number;
  try {
    if (!existsSync(paths.projects)) return { status: 'ok', entries: {} };
    text = readFileSync(paths.projects, 'utf8');
    mode = statSync(paths.projects).mode & 0o777;
  } catch (err) {
    return { status: 'unreadable', error: errorMessage(err) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { status: 'unreadable', error: `not valid JSON (${errorMessage(err)})` };
  }
  if (!isObject(raw)) return { status: 'unreadable', error: 'not a JSON object' };
  const entries: Record<string, Assignment> = Object.create(null) as Record<string, Assignment>;
  for (const [key, v] of Object.entries(raw)) {
    const a = parseAssignment(v);
    if (!a) return { status: 'unreadable', error: `entry ${JSON.stringify(key)} is not a valid assignment` };
    entries[key] = a;
  }
  return { status: 'ok', entries, mode };
}

/** Writes projects.json (0600, temp + rename). Only `ai-obs use` calls this. */
export function saveProjects(paths: Pick<AiObsPaths, 'projects'>, entries: Record<string, Assignment>): void {
  writeJsonAtomic(paths.projects, { ...entries }, 0o600);
}

/**
 * `use --reset-projects`: renames the unreadable file aside (`projects.json.broken-<ulid>`, never
 * deleted) and starts an empty one. Returns the path the old file was moved to.
 */
export function resetProjects(paths: Pick<AiObsPaths, 'projects'>, now: Date): string {
  const aside = `${paths.projects}.broken-${ulid(now.getTime())}`;
  renameSync(paths.projects, aside);
  saveProjects(paths, {});
  return aside;
}

export function assignmentFor(entry: TokenEntry, eff: CompanyLabel | undefined, now: Date): Assignment {
  const id = identityOf(entry, eff);
  return {
    token: entry.name,
    endpoint: id.endpoint,
    ...(id.company_slug ? { company_slug: id.company_slug } : {}),
    token_fp: id.token_fp,
    assigned_at: now.toISOString(),
  };
}

export function isExplicit(a: Assignment | undefined): a is ExplicitAssignment {
  return !!a && a.token !== null;
}

/** The identity an explicit assignment points to. */
export function assignmentIdentity(a: ExplicitAssignment): TokenIdentity {
  return { endpoint: a.endpoint, ...(a.company_slug ? { company_slug: a.company_slug } : {}), token_fp: a.token_fp };
}

/** Everything routing reads, fresh from disk (C17): config, projects, per-token caches, blocked flags. */
export interface RoutingView {
  config: CollectorConfig;
  projects: ProjectsState;
  /** per token name, from state/collector-config/<name>.json (§3.4) */
  caches: Record<string, CacheInfo>;
  /** per token name, only tokens currently blocked (state/delivery.json, §5.2) */
  blocked: Record<string, Blocked>;
}

/** Sync, never throws, no caching (C17). Null = no (valid) config.json. */
export function loadRouting(paths: AiObsPaths): RoutingView | null {
  let config: CollectorConfig | null;
  try {
    config = loadConfig(paths);
  } catch {
    return null;
  }
  if (!config) return null;
  const caches: Record<string, CacheInfo> = Object.create(null) as Record<string, CacheInfo>;
  const blocked: Record<string, Blocked> = Object.create(null) as Record<string, Blocked>;
  let delivery: ReturnType<typeof readDelivery> | null = null;
  try {
    delivery = readDelivery(paths);
  } catch {
    /* unreadable: nothing blocked */
  }
  for (const t of config.tokens) {
    try {
      caches[t.name] = cacheInfo(readCache(paths, t));
    } catch {
      caches[t.name] = { fetched: false };
    }
    const b = delivery ? tokenDelivery(delivery, t).blocked : null;
    if (b) blocked[t.name] = b;
  }
  return { config, projects: loadProjects(paths), caches, blocked };
}

/** Where a session's events are sent: a token identity fixed at capture, or open (C12). */
export type Binding = { kind: 'open' } | { kind: 'token'; id: TokenIdentity; name: string };
export const OPEN: Binding = { kind: 'open' };

/** Stable tag of a binding (stream directory hash input): the name is a label and never part of it. */
export function bindingTag(b: Binding): string {
  if (b.kind === 'open') return 'open';
  return `tok:${b.id.endpoint}|${b.id.company_slug ? `s:${b.id.company_slug}` : `f:${b.id.token_fp}`}`;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const prefixOf = (b: Binding) => (b.kind === 'open' ? 'o-' : 't-');

/** Directory name of a project stream under queue/p/: `o-` / `t-` + first 32 hex of sha256(pk + '\n' + tag). */
export function streamDirName(pk: string, bind: Binding): string {
  return prefixOf(bind) + sha256(`${pk}\n${bindingTag(bind)}`).slice(0, 32);
}

/** Directory name of an unresolved stream under queue/u/: `o-` / `t-` + first 32 hex of sha256('cwd:' + cwd + '\n' + tag). */
export function unresolvedDirName(cwd: string, bind: Binding): string {
  return prefixOf(bind) + sha256(`cwd:${cwd}\n${bindingTag(bind)}`).slice(0, 32);
}

/** What a queue stream is, as far as routing cares. The pre-upgrade stream (root segments) is never sent. */
export type StreamIdentity =
  | { kind: 'project'; pk: string; bind: Binding }
  | { kind: 'unresolved'; cwd: string; bind: Binding }
  | { kind: 'pre-upgrade' }
  | { kind: 'unknown' };

export type HeldReason =
  | 'no-tokens'
  | 'projects-unreadable'
  | 'unassigned'
  | 'dangling'
  | 'unverified'
  | 'company-mismatch'
  | 'opted-out'
  | 'pre-upgrade'
  | 'unresolved'
  | 'unknown-stream';
export type OpenReason = 'unassigned' | 'dangling' | 'config-damaged' | 'projects-unreadable';
export type CaptureDecision = { kind: 'drop' } | { kind: 'bind'; bind: Binding; openReason?: OpenReason };
export type Resolution =
  | { kind: 'token'; token: TokenEntry; via: 'bound' | 'explicit' }
  | { kind: 'held'; reason: HeldReason; assignedTo?: string; token?: TokenEntry };

/** The entry's company: `company` when stored, else its cache's company when that slug equals its name (C9). */
export function effectiveCompany(entry: TokenEntry, cache: CacheInfo | undefined): CompanyLabel | undefined {
  if (entry.company) return entry.company;
  return cache?.company && cache.company.slug === entry.name ? cache.company : undefined;
}

/** Whether a token may send: its company is known and the server has not reported another one. */
export function routable(entry: TokenEntry, cache: CacheInfo | undefined): 'ok' | 'unverified' | 'company-mismatch' {
  const eff = effectiveCompany(entry, cache);
  if (!eff) return 'unverified';
  if (cache?.company && cache.company.slug !== eff.slug) return 'company-mismatch';
  return 'ok';
}

const cacheOf = (view: RoutingView, t: TokenEntry): CacheInfo | undefined =>
  Object.prototype.hasOwnProperty.call(view.caches, t.name) ? view.caches[t.name] : undefined;

/** The registered entry an identity points to (C8), if any. */
export function entryFor(view: RoutingView, id: TokenIdentity): TokenEntry | undefined {
  return view.config.tokens.find((t) => identityMatches(id, t, effectiveCompany(t, cacheOf(view, t))));
}

/** Binding to a registered entry, by its current (richest) identity. */
function bindTo(view: RoutingView, t: TokenEntry): Binding {
  return { kind: 'token', id: identityOf(t, effectiveCompany(t, cacheOf(view, t))), name: t.name };
}

function projectEntry(view: RoutingView, pk: string | null): Assignment | undefined {
  if (pk === null || view.projects.status !== 'ok') return undefined;
  return Object.prototype.hasOwnProperty.call(view.projects.entries, pk) ? view.projects.entries[pk] : undefined;
}

/**
 * THE capture rule (§3.2 table A, first match wins). Pure. `capturedAt` = `received_at` (ms) of the
 * session's first hook. `pk` null = unresolved: only the epoch rows apply. An explicit choice made
 * after `capturedAt` does not take a session captured under a single token away from it (C12, C18).
 */
export function captureBinding(view: RoutingView, pk: string | null, capturedAt: number): CaptureDecision {
  const T = view.config.tokens;
  if (!T.length) return { kind: 'drop' }; // A1: nothing is recorded without a token (C6)
  const a = projectEntry(view, pk);
  if (a && !isExplicit(a)) return { kind: 'drop' }; // A2: --none
  const single = epochAt(view.config, capturedAt)?.single;
  const only = single ? entryFor(view, single) : undefined;
  if (isExplicit(a)) {
    const chosenAt = Date.parse(a.assigned_at);
    if (only && Number.isFinite(chosenAt) && capturedAt < chosenAt) return { kind: 'bind', bind: bindTo(view, only) }; // A5: captured before the choice
    const t = entryFor(view, assignmentIdentity(a));
    return t ? { kind: 'bind', bind: bindTo(view, t) } : { kind: 'bind', bind: OPEN, openReason: 'dangling' }; // A3 / A4
  }
  if (only) return { kind: 'bind', bind: bindTo(view, only) }; // A5
  if (T.length >= 2 && view.projects.status !== 'ok') return { kind: 'bind', bind: OPEN, openReason: 'projects-unreadable' }; // A6
  if (view.config.invalidTokens.length) return { kind: 'bind', bind: OPEN, openReason: 'config-damaged' }; // A7
  return { kind: 'bind', bind: OPEN, openReason: 'unassigned' }; // A8
}

/**
 * The token binding of a project's explicit choice, when it matches a registered token. An open
 * session pinned before the choice binds to it from its next event on (C12: what is recorded after
 * `use <name>` belongs to `<name>`, whatever a later `use` says).
 */
export function explicitBinding(view: RoutingView, pk: string): Binding | null {
  const a = projectEntry(view, pk);
  if (!isExplicit(a)) return null;
  const t = entryFor(view, assignmentIdentity(a));
  return t ? bindTo(view, t) : null;
}

/**
 * Binding of an unresolved stream once its key is known (§3.1). Data bound at capture keeps its token
 * (C12: a later `use` does not move it); open data takes the project's explicit choice (it was recorded
 * while the project had no choice), else stays open. `--none` keeps the data (held `opted-out`, C19).
 */
export function adoptKey(view: RoutingView, pk: string, uBind: Binding): Extract<CaptureDecision, { kind: 'bind' }> {
  if (uBind.kind === 'token') return { kind: 'bind', bind: uBind };
  const a = projectEntry(view, pk);
  if (a && !isExplicit(a)) return { kind: 'bind', bind: OPEN };
  const t = explicitBinding(view, pk);
  if (t) return { kind: 'bind', bind: t };
  return { kind: 'bind', bind: OPEN, openReason: isExplicit(a) ? 'dangling' : 'unassigned' };
}

function resolveIdentity(view: RoutingView, id: TokenIdentity, via: 'bound' | 'explicit', assignedTo: string): Resolution {
  const t = entryFor(view, id);
  if (!t) return { kind: 'held', reason: 'dangling', assignedTo };
  const r = routable(t, cacheOf(view, t));
  if (r !== 'ok') return { kind: 'held', reason: r, assignedTo, token: t };
  return { kind: 'token', token: t, via };
}

/**
 * THE send rule (§3.2 table B, first match wins). Pure. Blocked / backoff / never-fetched tokens still
 * resolve to the token; the sender decides whether it can send now. Pre-upgrade data (root segments of
 * the 0.1.x collector) is never sent: the tokens it was recorded with were reset (owner decision).
 */
export function resolveStream(view: RoutingView, stream: StreamIdentity): Resolution {
  if (stream.kind === 'unknown') return { kind: 'held', reason: 'unknown-stream' }; // B1
  if (stream.kind === 'unresolved') return { kind: 'held', reason: 'unresolved' }; // B1
  if (!view.config.tokens.length) return { kind: 'held', reason: 'no-tokens' }; // B2
  if (stream.kind === 'pre-upgrade') return { kind: 'held', reason: 'pre-upgrade' };
  const a = projectEntry(view, stream.pk);
  if (a && !isExplicit(a)) return { kind: 'held', reason: 'opted-out' }; // B3
  if (stream.bind.kind === 'token') return resolveIdentity(view, stream.bind.id, 'bound', stream.bind.name); // B4
  if (view.projects.status !== 'ok') return { kind: 'held', reason: 'projects-unreadable' }; // B5
  if (isExplicit(a)) return resolveIdentity(view, assignmentIdentity(a), 'explicit', a.token); // B6
  return { kind: 'held', reason: 'unassigned' }; // B7
}

/** Explicit assignments that point to this entry (token list PROJECTS, token remove). */
export function assignedKeys(view: RoutingView, entry: TokenEntry): string[] {
  if (view.projects.status !== 'ok') return [];
  const eff = effectiveCompany(entry, cacheOf(view, entry));
  return Object.entries(view.projects.entries)
    .filter(([, a]) => isExplicit(a) && identityMatches(assignmentIdentity(a), entry, eff))
    .map(([k]) => k);
}
