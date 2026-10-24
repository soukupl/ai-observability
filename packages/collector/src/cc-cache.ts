import { rmSync } from 'node:fs';
import { endpointHost, tokenFingerprint, type ServerEntry } from './config.js';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import { collectorConfigPath, type AiObsPaths } from './paths.js';
import type { CollectorConfigResponse, TokenSource, UserKind } from './protocol-types.js';
import { TEAM_SLUG_RE } from './protocol-types.js';

/**
 * state/collector-config/<host>.json: the server's last GET /api/v1/collector-config. A file whose
 * `token_fp` or `endpoint` does not match the entry belongs to a replaced token and reads as empty.
 */
export interface CacheFile {
  token_fp: string;
  endpoint: string;
  fetched_at?: string;
  value?: CollectorConfigResponse;
  failed_at?: string;
}

type Paths = Pick<AiObsPaths, 'collectorConfigDir'>;
type Server = Pick<ServerEntry, 'endpoint' | 'token'>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Validates a collector-config body (cache or response): null without a known `project_naming`. Keeps the
 * salt (≥ 16 chars) and the appendix A fields that are well formed; anything malformed is left out.
 */
export function parseCollectorConfigValue(raw: unknown): CollectorConfigResponse | null {
  if (!isObject(raw) || (raw.project_naming !== 'plain' && raw.project_naming !== 'hashed')) return null;
  const salt = typeof raw.project_salt === 'string' && raw.project_salt.length >= 16 ? raw.project_salt : null;
  const d = raw.deployment;
  const deployment = isObject(d) && nonEmpty(d.name) && nonEmpty(d.slug) ? { name: d.name, slug: d.slug } : null;
  const u = raw.user;
  const user =
    isObject(u) && (u.email === null || nonEmpty(u.email)) && (u.kind === 'person' || u.kind === 'service')
      ? { email: u.email as string | null, name: typeof u.name === 'string' ? u.name : '', kind: u.kind as UserKind }
      : null;
  const teams = Array.isArray(raw.teams)
    ? raw.teams.filter((t): t is { slug: string; name: string } => isObject(t) && typeof t.slug === 'string' && TEAM_SLUG_RE.test(t.slug) && nonEmpty(t.name)).map((t) => ({ slug: t.slug, name: t.name }))
    : null;
  const primary = raw.primary_team === null ? null : typeof raw.primary_team === 'string' && TEAM_SLUG_RE.test(raw.primary_team) ? raw.primary_team : undefined;
  const t = raw.token;
  const token =
    isObject(t) && (t.source === 'device' || t.source === 'manual') && (t.expires_at === null || (nonEmpty(t.expires_at) && Number.isFinite(Date.parse(t.expires_at))))
      ? { expires_at: t.expires_at as string | null, label: nonEmpty(t.label) ? t.label : null, source: t.source as TokenSource }
      : null;
  return {
    project_naming: raw.project_naming,
    min_collector_version: String(raw.min_collector_version ?? '0.0.0'),
    ...(salt ? { project_salt: salt } : {}),
    ...(deployment ? { deployment } : {}),
    ...(user ? { user } : {}),
    ...(teams ? { teams } : {}),
    ...(primary !== undefined ? { primary_team: primary } : {}),
    ...(token ? { token } : {}),
  };
}

const cachePath = (paths: Paths, entry: Server) => collectorConfigPath(paths, endpointHost(entry.endpoint));

/** The server's cache, or null when missing, unreadable or written for another token / endpoint. */
export function readCache(paths: Paths, entry: Server): CacheFile | null {
  let raw: unknown;
  try {
    raw = readJsonFile<unknown>(cachePath(paths, entry));
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

/** Merges `patch` into the server's cache (a cache of another token is replaced). Returns the written file. */
export function writeCache(paths: Paths, entry: Server, patch: Partial<Omit<CacheFile, 'token_fp' | 'endpoint'>>): CacheFile {
  const next: CacheFile = { ...(readCache(paths, entry) ?? {}), ...patch, token_fp: tokenFingerprint(entry.token), endpoint: entry.endpoint };
  writeJsonAtomic(cachePath(paths, entry), next, 0o600);
  return next;
}

/** The fetched value, or null when the server was never reached with this token (C4). */
export function cachedValue(paths: Paths, entry: Server): CollectorConfigResponse | null {
  const c = readCache(paths, entry);
  return c?.value && typeof c.fetched_at === 'string' ? c.value : null;
}

export function dropCache(paths: Paths, endpoint: string): void {
  try {
    rmSync(collectorConfigPath(paths, endpointHost(endpoint)), { force: true });
  } catch {
    /* already gone, or a host that never had a cache */
  }
}
