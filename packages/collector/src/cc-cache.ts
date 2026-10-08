import { renameSync, rmSync } from 'node:fs';
import { tokenFingerprint, type CompanyLabel, type TokenEntry } from './config.js';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import { collectorConfigPath, type AiObsPaths } from './paths.js';
import type { CollectorConfigResponse, ProjectNamingMode } from './protocol-types.js';

/**
 * state/collector-config/<name>.json: the token's last GET /api/v1/collector-config (§3.4). A file whose
 * `token_fp` or `endpoint` does not match the entry belongs to a replaced token and reads as empty.
 */
export interface CacheFile {
  token_fp: string;
  endpoint: string;
  fetched_at?: string;
  value?: CollectorConfigResponse;
  failed_at?: string;
}

/** What routing needs from a cache (never the salt). */
export interface CacheInfo {
  /** a 2xx value was fetched at least once (C4) */
  fetched: boolean;
  company?: CompanyLabel;
  user?: { email: string } | null;
  naming?: ProjectNamingMode;
}

type Paths = Pick<AiObsPaths, 'collectorConfigDir'>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Validates a collector-config body (cache or response): null without a known `project_naming`.
 * Keeps `project_salt` (≥ 16 chars), `company` (both strings non-empty) and `user` (`{email}` or null).
 */
export function parseCollectorConfigValue(raw: unknown): CollectorConfigResponse | null {
  if (!isObject(raw) || (raw.project_naming !== 'plain' && raw.project_naming !== 'hashed')) return null;
  const salt = typeof raw.project_salt === 'string' && raw.project_salt.length >= 16 ? raw.project_salt : null;
  const c = raw.company;
  const company = isObject(c) && nonEmpty(c.name) && nonEmpty(c.slug) ? { name: c.name, slug: c.slug } : null;
  const u = raw.user;
  const user = u === null ? null : isObject(u) && nonEmpty(u.email) ? { email: u.email } : undefined;
  return {
    project_naming: raw.project_naming,
    min_collector_version: String(raw.min_collector_version ?? '0.0.0'),
    ...(salt ? { project_salt: salt } : {}),
    ...(company ? { company } : {}),
    ...(user !== undefined ? { user } : {}),
  };
}

/** The entry's cache, or null when missing, unreadable or written for another token / endpoint. */
export function readCache(paths: Paths, entry: TokenEntry): CacheFile | null {
  let raw: unknown;
  try {
    raw = readJsonFile<unknown>(collectorConfigPath(paths, entry.name));
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.token_fp !== tokenFingerprint(entry.token) || raw.endpoint !== entry.endpoint) return null;
  const value = parseCollectorConfigValue(raw.value);
  return {
    token_fp: raw.token_fp,
    endpoint: raw.endpoint,
    ...(typeof raw.fetched_at === 'string' ? { fetched_at: raw.fetched_at } : {}),
    ...(value ? { value } : {}),
    ...(typeof raw.failed_at === 'string' ? { failed_at: raw.failed_at } : {}),
  };
}

/** Merges `patch` into the entry's cache (a cache of another token is replaced). Returns the written file. */
export function writeCache(paths: Paths, entry: TokenEntry, patch: Partial<Omit<CacheFile, 'token_fp' | 'endpoint'>>): CacheFile {
  const next: CacheFile = { ...(readCache(paths, entry) ?? {}), ...patch, token_fp: tokenFingerprint(entry.token), endpoint: entry.endpoint };
  writeJsonAtomic(collectorConfigPath(paths, entry.name), next, 0o600);
  return next;
}

export function cacheInfo(file: CacheFile | null): CacheInfo {
  const value = file?.value;
  if (!file || !value || typeof file.fetched_at !== 'string') return { fetched: false };
  return {
    fetched: true,
    ...(value.company ? { company: value.company } : {}),
    ...(value.user !== undefined ? { user: value.user } : {}),
    naming: value.project_naming,
  };
}

export function dropCache(paths: Paths, name: string): void {
  try {
    rmSync(collectorConfigPath(paths, name), { force: true });
  } catch {
    /* already gone, or an invalid name that never had a cache */
  }
}

/** Follows a token rename (single-token auto-confirm, `default` → slug). */
export function renameCache(paths: Paths, from: string, to: string): void {
  if (from === to) return;
  try {
    renameSync(collectorConfigPath(paths, from), collectorConfigPath(paths, to));
  } catch {
    /* no cache yet */
  }
}
