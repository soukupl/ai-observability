import { createHash, randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { AiObsPaths } from './paths.js';
import { COMPANY_TOKEN_PREFIX, LEGACY_TEAM_TOKEN_PREFIX, USER_TOKEN_PREFIX } from './protocol-types.js';

/** Token names: 1–63 chars of a-z, 0-9 and '-', not starting or ending with '-' (CLI argument, projects.json value, file name). */
export const TOKEN_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Fingerprints of replaced tokens of the same company kept per entry (rotation). */
export const MAX_PRIOR_FPS = 10;
/** Routing epochs kept in config.json (oldest dropped). */
export const MAX_ROUTING_EPOCHS = 50;
/** Name of a token registered offline without --name while it is the only one (C9). */
export const PROVISIONAL_TOKEN_NAME = 'default';

export type TokenKind = 'user' | 'company';
export interface CompanyLabel {
  name: string;
  slug: string;
}

/**
 * Who a token reports to (C8). An entry matches when the endpoint is equal and, when `company_slug` is
 * set, its effective company slug is equal; without a slug, its fingerprint (or a prior one) is equal.
 */
export interface TokenIdentity {
  endpoint: string;
  company_slug?: string;
  token_fp: string;
}

/** One registered token (config.json `tokens[]`). The name is a CLI handle and label only, never the routing identity. */
export interface TokenEntry {
  name: string;
  /** absent while the token is unverified (C9) */
  company?: CompanyLabel;
  /** `user.email` from collector-config (user tokens only) */
  email?: string;
  /** git user.email of the directory this token was registered in (`init --token`): sent with this token's batches only */
  git_email?: string;
  /** normalized (normalizeEndpoint) */
  endpoint: string;
  /** aiobs_u_… | aiobs_c_… */
  token: string;
  added_at: string;
  /** fingerprints of tokens this entry replaced for the same proven company (at most MAX_PRIOR_FPS) */
  prior_fps?: string[];
  /** offline single-token registration named `default` (C9) */
  provisional_name?: true;
}

/** What the first registration after the upgrade remembers of the 0.1.x config (C5). */
export interface LegacyInfo {
  endpoint?: string;
  token_mask: string;
  found_at: string;
}

/** `single` = the token identity in force from `since` when exactly one valid token and no malformed entry exist (C18). */
export interface RoutingEpoch {
  since: string;
  single: TokenIdentity | null;
}

/** ~/.ai-obs/config.json (mode 0600). Tokens live only here — never in a repo. */
export interface CollectorConfig {
  /** default endpoint for the next `init` / `token add` without --endpoint (the last registered one) */
  endpoint?: string;
  /** random UUID generated at first init; identifies this machine */
  machine_id: string;
  created_at: string;
  /** git user.email of the first `init` on this machine: sent with tokens that have no `git_email` of their own */
  git_email?: string;
  /** registration order = listing and flush order */
  tokens: TokenEntry[];
  legacy?: LegacyInfo;
  routingEpochs: RoutingEpoch[];
  /** malformed token entries, raw; persisted as `invalid_tokens` (C22) */
  invalidTokens: unknown[];
  /** in memory only: masked token of a pre-upgrade file that has not been migrated yet */
  legacyToken?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function tokenKind(token: string): TokenKind | null {
  if (token.startsWith(USER_TOKEN_PREFIX)) return 'user';
  if (token.startsWith(COMPANY_TOKEN_PREFIX)) return 'company';
  return null;
}

export function isIngestToken(token: string): boolean {
  return typeof token === 'string' && tokenKind(token) !== null && token.length > USER_TOKEN_PREFIX.length;
}

export function isTokenName(name: unknown): name is string {
  return typeof name === 'string' && TOKEN_NAME_RE.test(name);
}

/** Validates and normalizes an endpoint URL (http/https, no trailing slash, no query). Throws on garbage. */
export function normalizeEndpoint(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`endpoint must be http(s): ${raw}`);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function maskToken(token: string): string {
  const known = [USER_TOKEN_PREFIX, COMPANY_TOKEN_PREFIX, LEGACY_TEAM_TOKEN_PREFIX].some((p) => token.startsWith(p));
  const prefix = known ? token.slice(0, 8) : '';
  return token.length >= prefix.length + 12 ? `${prefix}…${token.slice(-4)}` : `${prefix}…`;
}

/** sha256(token), first 16 hex: stored instead of the token wherever a token must be recognised (bindings, caches). */
export function tokenFingerprint(token: string): string {
  return sha256(token).slice(0, 16);
}

export function identityOf(entry: TokenEntry, eff?: CompanyLabel): TokenIdentity {
  const slug = (eff ?? entry.company)?.slug;
  return { endpoint: entry.endpoint, ...(slug ? { company_slug: slug } : {}), token_fp: tokenFingerprint(entry.token) };
}

/** C8: endpoint equal and (slug given ? effective slug equal : fingerprint or a prior fingerprint equal). */
export function identityMatches(id: TokenIdentity, entry: TokenEntry, eff?: CompanyLabel): boolean {
  if (id.endpoint !== entry.endpoint) return false;
  if (id.company_slug) return (eff ?? entry.company)?.slug === id.company_slug;
  return id.token_fp === tokenFingerprint(entry.token) || (entry.prior_fps ?? []).includes(id.token_fp);
}

/** Same reporting target: endpoint equal and (both slugs known ? slugs equal : fingerprints equal). */
export function sameIdentity(a: TokenIdentity | null, b: TokenIdentity | null): boolean {
  if (!a || !b) return a === b;
  if (a.endpoint !== b.endpoint) return false;
  if (a.company_slug && b.company_slug) return a.company_slug === b.company_slug;
  return a.token_fp === b.token_fp;
}

/** The identity new sessions bind to implicitly: exactly one valid token and no malformed entry (C18, C22). */
export function singleIdentity(config: Pick<CollectorConfig, 'tokens' | 'invalidTokens'>): TokenIdentity | null {
  const [only] = config.tokens;
  return config.tokens.length === 1 && config.invalidTokens.length === 0 && only ? identityOf(only) : null;
}

/** The epoch in force at `at` (ms): the last whose `since` ≤ at, else the first; null when there is none. */
export function epochAt(config: Pick<CollectorConfig, 'routingEpochs'>, at: number): RoutingEpoch | null {
  let found: RoutingEpoch | null = null;
  for (const e of config.routingEpochs) {
    const since = Date.parse(e.since);
    if (Number.isFinite(since) && since <= at) found = e;
  }
  return found ?? config.routingEpochs[0] ?? null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function parseCompany(v: unknown): CompanyLabel | undefined {
  return isObject(v) && nonEmpty(v.name) && nonEmpty(v.slug) ? { name: v.name, slug: v.slug } : undefined;
}

function parseIdentity(v: unknown): TokenIdentity | null | undefined {
  if (v === null) return null;
  if (!isObject(v) || !nonEmpty(v.endpoint) || !nonEmpty(v.token_fp)) return undefined;
  return { endpoint: v.endpoint, ...(nonEmpty(v.company_slug) ? { company_slug: v.company_slug } : {}), token_fp: v.token_fp };
}

/** A valid entry, or null (the raw value then goes to `invalidTokens`). */
function parseEntry(v: unknown, taken: Set<string>): TokenEntry | null {
  if (!isObject(v) || !isTokenName(v.name) || taken.has(v.name) || typeof v.token !== 'string' || !isIngestToken(v.token)) return null;
  if (typeof v.endpoint !== 'string' || typeof v.added_at !== 'string') return null;
  let endpoint: string;
  try {
    endpoint = normalizeEndpoint(v.endpoint);
  } catch {
    return null;
  }
  const company = parseCompany(v.company);
  const priorFps = Array.isArray(v.prior_fps) ? v.prior_fps.filter((x): x is string => typeof x === 'string') : [];
  return {
    name: v.name,
    ...(company ? { company } : {}),
    ...(typeof v.email === 'string' ? { email: v.email } : {}),
    ...(typeof v.git_email === 'string' && v.git_email ? { git_email: v.git_email } : {}),
    endpoint,
    token: v.token,
    added_at: v.added_at,
    ...(priorFps.length ? { prior_fps: priorFps.slice(-MAX_PRIOR_FPS) } : {}),
    ...(v.provisional_name === true ? { provisional_name: true as const } : {}),
  };
}

/**
 * Reads config.json; null when missing, unparsable or without a machine_id (not configured). A
 * pre-upgrade (0.1.x) file loads with `tokens: []` and the masked old token in `legacyToken` (C5).
 * Malformed token entries are kept raw in `invalidTokens` (C22).
 */
export function loadConfig(paths: Pick<AiObsPaths, 'config'>): CollectorConfig | null {
  const raw = readJsonFile<unknown>(paths.config);
  if (!isObject(raw) || typeof raw.machine_id !== 'string') return null;
  const config: CollectorConfig = {
    ...(typeof raw.endpoint === 'string' && raw.endpoint ? { endpoint: raw.endpoint } : {}),
    machine_id: raw.machine_id,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date(0).toISOString(),
    ...(typeof raw.git_email === 'string' && raw.git_email ? { git_email: raw.git_email } : {}),
    tokens: [],
    routingEpochs: [],
    invalidTokens: [],
  };
  if (Array.isArray(raw.tokens)) {
    const taken = new Set<string>();
    for (const item of raw.tokens) {
      const entry = parseEntry(item, taken);
      if (entry) {
        taken.add(entry.name);
        config.tokens.push(entry);
      } else {
        config.invalidTokens.push(item);
      }
    }
  } else if (typeof raw.token === 'string') {
    config.legacyToken = maskToken(raw.token);
  }
  if (Array.isArray(raw.invalid_tokens)) config.invalidTokens.push(...raw.invalid_tokens);
  const legacy = raw.legacy;
  if (isObject(legacy) && typeof legacy.token_mask === 'string' && typeof legacy.found_at === 'string') {
    config.legacy = {
      ...(typeof legacy.endpoint === 'string' ? { endpoint: legacy.endpoint } : {}),
      token_mask: legacy.token_mask,
      found_at: legacy.found_at,
    };
  }
  if (Array.isArray(raw.routing_epochs)) {
    for (const e of raw.routing_epochs) {
      if (!isObject(e) || typeof e.since !== 'string') continue;
      const single = parseIdentity(e.single);
      if (single !== undefined) config.routingEpochs.push({ since: e.since, single });
    }
  }
  return config;
}

function serializeEntry(e: TokenEntry): Record<string, unknown> {
  return {
    name: e.name,
    ...(e.company ? { company: { name: e.company.name, slug: e.company.slug } } : {}),
    ...(e.email !== undefined ? { email: e.email } : {}),
    ...(e.git_email ? { git_email: e.git_email } : {}),
    endpoint: e.endpoint,
    token: e.token,
    added_at: e.added_at,
    ...(e.prior_fps?.length ? { prior_fps: e.prior_fps.slice(-MAX_PRIOR_FPS) } : {}),
    ...(e.provisional_name ? { provisional_name: true } : {}),
  };
}

/**
 * Writes config.json (0600, atomic): `v: 2`, `invalid_tokens` kept, in-memory fields dropped. Appends a
 * routing epoch `{since: now, single}` when the single token identity changed or no epoch exists yet
 * (C18); `config.routingEpochs` is updated in place so a second save does not append again.
 */
export function saveConfig(paths: Pick<AiObsPaths, 'config'>, config: CollectorConfig, now: Date = new Date()): void {
  const single = singleIdentity(config);
  const last = config.routingEpochs.at(-1);
  let epochs = config.routingEpochs;
  if (!last || !sameIdentity(last.single, single)) epochs = [...epochs, { since: now.toISOString(), single }];
  epochs = epochs.slice(-MAX_ROUTING_EPOCHS);
  writeJsonAtomic(
    paths.config,
    {
      v: 2,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      machine_id: config.machine_id,
      created_at: config.created_at,
      ...(config.git_email ? { git_email: config.git_email } : {}),
      ...(config.legacy ? { legacy: config.legacy } : {}),
      tokens: config.tokens.map(serializeEntry),
      invalid_tokens: config.invalidTokens,
      routing_epochs: epochs,
    },
    0o600,
  );
  config.routingEpochs = epochs;
}

export function findToken(config: Pick<CollectorConfig, 'tokens'>, name: string): TokenEntry | undefined {
  return config.tokens.find((t) => t.name === name);
}

export type UpsertResult =
  | { kind: 'added'; config: CollectorConfig; entry: TokenEntry }
  | { kind: 'replaced'; config: CollectorConfig; entry: TokenEntry; previous: TokenEntry; sameCompany: boolean }
  | { kind: 'conflict'; message: string };

export interface UpsertOptions {
  /** --name was given (the entry's name is the user's choice, not the server slug / `default`) */
  nameGiven: boolean;
  /** effective company of a registered entry: `company`, else its cache's company when that slug equals its name */
  effOf: (e: TokenEntry) => CompanyLabel | undefined;
  /** company slug the entry's collector-config cache reports, whatever its name (rule 4, unverified old entry) */
  cachedSlugOf?: (e: TokenEntry) => string | undefined;
}

function withPriorFp(prior: string[] | undefined, fp: string, current: string): string[] | undefined {
  const list = [...(prior ?? []).filter((x) => x !== fp && x !== current), fp].slice(-MAX_PRIOR_FPS);
  return list.length ? list : undefined;
}

/**
 * Adds or replaces a token (contract §5.5, design §1.1 rules 1–5, first match wins). Pure: returns a new
 * config (epochs are appended by saveConfig). A verified entry has `company`.
 */
export function upsertToken(config: CollectorConfig, entry: TokenEntry, opts: UpsertOptions): UpsertResult {
  const tokens = config.tokens;
  const slug = entry.company?.slug;
  const newFp = tokenFingerprint(entry.token);
  const replaceAt = (i: number, next: TokenEntry, sameCompany: boolean): UpsertResult => {
    const previous = tokens[i] as TokenEntry;
    const list = tokens.slice();
    list[i] = next;
    return { kind: 'replaced', config: { ...config, tokens: list }, entry: next, previous, sameCompany };
  };
  const nameTakenBy = (name: string, except: number) => tokens.findIndex((t, i) => i !== except && t.name === name);
  const conflict = (message: string): UpsertResult => ({ kind: 'conflict', message });

  // 1. same token string
  const same = tokens.findIndex((t) => t.token === entry.token);
  if (same >= 0) {
    const old = tokens[same] as TokenEntry;
    const oldSlug = opts.effOf(old)?.slug;
    let name = old.name;
    if (opts.nameGiven) name = entry.name;
    else if (old.provisional_name && slug && entry.name !== old.name && nameTakenBy(entry.name, same) < 0) name = entry.name;
    if (nameTakenBy(name, same) >= 0) return conflict(`a token named ${name} is already registered; pass another --name`);
    const company = entry.company ?? old.company;
    const email = entry.company ? entry.email : (entry.email ?? old.email);
    const gitEmail = entry.git_email ?? old.git_email;
    const next: TokenEntry = {
      name,
      ...(company ? { company } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(gitEmail ? { git_email: gitEmail } : {}),
      endpoint: entry.endpoint,
      token: entry.token,
      added_at: entry.added_at,
      ...(old.prior_fps?.length ? { prior_fps: old.prior_fps } : {}),
      ...(name === old.name && old.provisional_name && !company ? { provisional_name: true as const } : {}),
    };
    return replaceAt(same, next, !(slug && oldSlug && slug !== oldSlug));
  }

  if (slug) {
    // 2. verified, same endpoint + same effective slug → rotation of that company's token
    const rot = tokens.findIndex((t) => t.endpoint === entry.endpoint && opts.effOf(t)?.slug === slug);
    if (rot >= 0) {
      const old = tokens[rot] as TokenEntry;
      if (opts.nameGiven && entry.name !== old.name) {
        return conflict(`${slug} at ${entry.endpoint} is already registered as ${old.name}; run without --name to replace it, or \`ai-obs token remove ${old.name}\` first`);
      }
      const prior = withPriorFp(old.prior_fps, tokenFingerprint(old.token), newFp);
      const { provisional_name: _p, prior_fps: _f, ...rest } = entry;
      const gitEmail = entry.git_email ?? old.git_email;
      return replaceAt(rot, { ...rest, name: old.name, ...(gitEmail ? { git_email: gitEmail } : {}), ...(prior ? { prior_fps: prior } : {}) }, true);
    }
    // 3. verified, no --name, same slug at another endpoint → ask for --name
    if (!opts.nameGiven) {
      const other = tokens.find((t) => t.endpoint !== entry.endpoint && opts.effOf(t)?.slug === slug);
      if (other) {
        return conflict(`company slug ${slug} is already registered as ${other.name} for ${other.endpoint}; pass --name <other-name> to register this one as well`);
      }
    }
  }

  // 4. same name
  const byName = tokens.findIndex((t) => t.name === entry.name);
  if (byName >= 0) {
    const old = tokens[byName] as TokenEntry;
    const oldEff = opts.effOf(old);
    if (old.endpoint !== entry.endpoint) {
      return conflict(`a token named ${entry.name} is already registered for ${old.endpoint}; pass --name <other-name>`);
    }
    if (oldEff && !slug) {
      return conflict(
        `token ${entry.name} belongs to company ${oldEff.slug}; the new token could not be checked: try again when ${entry.endpoint} is reachable, or pass another --name`,
      );
    }
    if (oldEff && slug && oldEff.slug !== slug) {
      return conflict(`${entry.name} is company ${oldEff.slug}, the new token is ${slug}: pass --name ${slug}`);
    }
    // old entry unverified → replace; same company only when its cache already reported the new slug
    const sameCompany = !!slug && opts.cachedSlugOf?.(old) === slug;
    const prior = sameCompany ? withPriorFp(old.prior_fps, tokenFingerprint(old.token), newFp) : undefined;
    const { prior_fps: _f, ...rest } = entry;
    const gitEmail = entry.git_email ?? old.git_email;
    return replaceAt(byName, { ...rest, ...(gitEmail ? { git_email: gitEmail } : {}), ...(prior ? { prior_fps: prior } : {}) }, sameCompany);
  }

  // 5. new
  return { kind: 'added', config: { ...config, tokens: [...tokens, entry] }, entry };
}

export function removeToken(config: CollectorConfig, name: string): CollectorConfig {
  return { ...config, tokens: config.tokens.filter((t) => t.name !== name) };
}

/** A config with no tokens, keeping the machine identity (and the legacy record) of `existing`. */
export function newMachineConfig(existing: CollectorConfig | null, now: Date = new Date()): CollectorConfig {
  return {
    ...(existing?.endpoint ? { endpoint: existing.endpoint } : {}),
    machine_id: existing?.machine_id ?? randomUUID(),
    created_at: existing?.created_at ?? now.toISOString(),
    ...(existing?.git_email ? { git_email: existing.git_email } : {}),
    ...(existing?.legacy ? { legacy: existing.legacy } : {}),
    tokens: [],
    routingEpochs: [],
    invalidTokens: [],
  };
}

/**
 * Single-token convenience (tests, protocol-conformance): one token named `name ?? company.slug ??
 * 'default'`, one routing epoch; keeps machine_id / created_at of `existing`. Throws on a bad token.
 */
export function buildConfig(input: {
  endpoint: string;
  token: string;
  gitEmail?: string | null;
  existing?: CollectorConfig | null;
  now?: Date;
  name?: string;
  company?: CompanyLabel;
  email?: string;
}): CollectorConfig {
  if (!isIngestToken(input.token)) {
    throw new Error(`token must start with ${USER_TOKEN_PREFIX} or ${COMPANY_TOKEN_PREFIX}`);
  }
  const now = input.now ?? new Date();
  const endpoint = normalizeEndpoint(input.endpoint);
  const entry: TokenEntry = {
    name: input.name ?? input.company?.slug ?? PROVISIONAL_TOKEN_NAME,
    ...(input.company ? { company: input.company } : {}),
    ...(input.email ? { email: input.email } : {}),
    endpoint,
    token: input.token,
    added_at: now.toISOString(),
  };
  return {
    endpoint,
    machine_id: input.existing?.machine_id ?? randomUUID(),
    created_at: input.existing?.created_at ?? now.toISOString(),
    ...(input.gitEmail ? { git_email: input.gitEmail } : {}),
    tokens: [entry],
    routingEpochs: [{ since: now.toISOString(), single: identityOf(entry) }],
    invalidTokens: [],
  };
}
