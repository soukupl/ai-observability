/**
 * The repository dot file (brief appendix E): `.ai-obs.json` (committed) and `.ai-obs.local.json`
 * (git-ignored) say which server and team a repository reports to. No git call: the lookup walks from the
 * working directory up to the directory that holds `.git`; the first directory with either file wins and
 * the local file overrides the committed one per key. A malformed file counts as absent and is reported.
 * Imports only node built-ins and fs helpers: the hook calls this inside its budget.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { AiObsPaths } from './paths.js';
import { TEAM_SLUG_RE } from './protocol-types.js';

export const DOT_FILE = '.ai-obs.json';
export const LOCAL_DOT_FILE = '.ai-obs.local.json';
/** Entries kept in state/dot-files.json (least recently written dropped first). */
export const DOT_CACHE_MAX = 500;
const MAX_DEPTH = 128;
const MAX_FILE_BYTES = 64 * 1024;
/** Longest `server` value accepted (a longer one would not fit the SessionStart text). */
export const MAX_SERVER_CHARS = 512;
/** Something that looks like an ai-obs token (any kind, retired ones too). */
const TOKEN_RE = /aiobs_[a-z]_[A-Za-z0-9]/i;

export interface DotFileValue {
  /** normalized endpoint */
  server?: string;
  team?: string;
}

export interface DotFileState {
  path: string;
  status: 'absent' | 'ok' | 'malformed';
  error?: string;
  value?: DotFileValue;
  /** the file contains something that looks like an ai-obs token (it is still read: tokens are just ignored) */
  token?: true;
}

export interface DotFileLookup {
  /** the directory that holds `.git` (where the walk stopped); null outside a git repository */
  root: string | null;
  /** the directory the files were read from (first hit); null when there is none */
  dir: string | null;
  committed: DotFileState | null;
  local: DotFileState | null;
  /** merged result: local overrides committed per key, malformed files count as absent */
  server?: string;
  team?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** normalizeEndpoint without importing config.ts (kept tiny for the hook). */
function normalizeServer(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Parses one dot file's text. Unknown keys are ignored; a bad `server` or `team` makes the whole file malformed. */
export function parseDotFile(text: string): { ok: true; value: DotFileValue } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (!isObject(raw)) return { ok: false, error: 'not a JSON object' };
  const value: DotFileValue = {};
  if (raw.server !== undefined) {
    if (typeof raw.server === 'string' && raw.server.length > MAX_SERVER_CHARS) return { ok: false, error: `"server" is longer than ${MAX_SERVER_CHARS} characters` };
    const server = typeof raw.server === 'string' ? normalizeServer(raw.server) : null;
    if (!server) return { ok: false, error: '"server" must be an http(s) URL' };
    value.server = server;
  }
  if (raw.team !== undefined) {
    if (typeof raw.team !== 'string' || !TEAM_SLUG_RE.test(raw.team)) return { ok: false, error: '"team" must be 1–63 characters of a-z, 0-9 and -' };
    value.team = raw.team;
  }
  return { ok: true, value };
}

function readState(path: string): DotFileState {
  let text: string;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { path, status: 'malformed', error: 'not a regular file' };
    if (st.size > MAX_FILE_BYTES) return { path, status: 'malformed', error: 'larger than 64 KB' };
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { path, status: 'absent' } : { path, status: 'malformed', error: 'unreadable' };
  }
  const r = parseDotFile(text);
  const token = TOKEN_RE.test(text) ? { token: true as const } : {};
  return r.ok ? { path, status: 'ok', value: r.value, ...token } : { path, status: 'malformed', error: r.error, ...token };
}

const exists = (p: string): boolean => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

const stampOf = (p: string): string => {
  try {
    const st = statSync(p);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return '-';
  }
};

/** The directories from `cwd` up to the one holding `.git` (inclusive); `root` null when none holds it. */
function walk(cwd: string): { dirs: string[]; root: string | null } {
  const dirs: string[] = [];
  let d = resolve(cwd);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    dirs.push(d);
    if (exists(join(d, '.git'))) return { dirs, root: d };
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return { dirs, root: null };
}

function compute(cwd: string): { lookup: DotFileLookup; dirs: string[] } {
  const { dirs, root } = walk(cwd);
  const none: DotFileLookup = { root, dir: null, committed: null, local: null };
  if (!root) return { lookup: none, dirs };
  const dir = dirs.find((d) => exists(join(d, DOT_FILE)) || exists(join(d, LOCAL_DOT_FILE)));
  if (!dir) return { lookup: none, dirs };
  const committed = readState(join(dir, DOT_FILE));
  const local = readState(join(dir, LOCAL_DOT_FILE));
  const merged: DotFileValue = { ...(committed.value ?? {}), ...(local.value ?? {}) };
  return { lookup: { root, dir, committed, local, ...merged }, dirs };
}

interface CacheEntry {
  /** every directory walked with its stamp: creating or deleting a dot file changes its directory's stamp */
  dirs: Array<[string, string]>;
  /** the two files of the hit directory with their stamps (edits in place change only the file) */
  files: Array<[string, string]>;
  lookup: DotFileLookup;
  at: number;
}

function readCacheFile(paths: Pick<AiObsPaths, 'dotFileCache'>): Record<string, CacheEntry> {
  const raw = readJsonFile<unknown>(paths.dotFileCache);
  return isObject(raw) ? (raw as Record<string, CacheEntry>) : (Object.create(null) as Record<string, CacheEntry>);
}

function valid(entry: unknown): entry is CacheEntry {
  if (!isObject(entry) || !Array.isArray(entry.dirs) || !Array.isArray(entry.files) || !isObject(entry.lookup)) return false;
  for (const pair of [...entry.dirs, ...entry.files] as unknown[]) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || pair[1] !== stampOf(pair[0])) return false;
  }
  return true;
}

export interface LookupOptions {
  /** read (and with `write`, refresh) state/dot-files.json */
  cache?: Pick<AiObsPaths, 'dotFileCache'>;
  /** the worker refreshes the cache; the hook only reads it */
  write?: boolean;
  now?: number;
}

/**
 * The dot file in force for `cwd`. With `cache`, a cached lookup is used while every directory walked
 * and both files are unchanged (stats only, no reads). Never throws.
 */
export function lookupDotFile(cwd: string, opts: LookupOptions = {}): DotFileLookup {
  try {
    const key = resolve(cwd);
    if (opts.cache) {
      const hit = readCacheFile(opts.cache)[key];
      if (valid(hit)) return hit.lookup;
    }
    const { lookup, dirs } = compute(key);
    if (opts.cache && opts.write) {
      try {
        const cache = readCacheFile(opts.cache);
        const files: Array<[string, string]> = lookup.dir ? [DOT_FILE, LOCAL_DOT_FILE].map((f) => [join(lookup.dir!, f), stampOf(join(lookup.dir!, f))]) : [];
        cache[key] = { dirs: dirs.map((d) => [d, stampOf(d)]), files, lookup, at: opts.now ?? Date.now() };
        const kept = Object.entries(cache)
          .filter(([, e]) => isObject(e) && typeof e.at === 'number')
          .sort((a, b) => b[1].at - a[1].at)
          .slice(0, DOT_CACHE_MAX);
        writeJsonAtomic(opts.cache.dotFileCache, Object.fromEntries(kept), 0o600);
      } catch {
        /* read-only home: the cache is an optimisation only */
      }
    }
    return lookup;
  } catch {
    return { root: null, dir: null, committed: null, local: null };
  }
}

/** One line per malformed file and per file that holds a token (status, doctor). */
export function dotFileProblems(l: DotFileLookup): string[] {
  const out: string[] = [];
  for (const s of [l.committed, l.local]) {
    if (!s) continue;
    if (s.status === 'malformed') out.push(`${s.path}: ${s.error ?? 'malformed'} (ignored): fix or delete it`);
    if (s.token) out.push(`${s.path} contains an ai-obs token: remove it from the file (and from git history if it was committed) and revoke the token under "My tokens"`);
  }
  return out;
}
