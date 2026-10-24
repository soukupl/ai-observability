import { createHash, randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { AiObsPaths } from './paths.js';
import { RETIRED_TOKEN_PREFIXES, USER_TOKEN_PREFIX, type TokenSource } from './protocol-types.js';

export const CONFIG_VERSION = 3 as const;

export interface DeploymentLabel {
  name: string;
  slug: string;
}

/**
 * One server this machine is logged in to (config.json `servers[]`, brief appendix E). One entry per
 * endpoint; its token is only ever sent to that endpoint.
 */
export interface ServerEntry {
  /** normalized (normalizeEndpoint) */
  endpoint: string;
  /** aiobs_u_… */
  token: string;
  /** `user.email` from collector-config; null for a service user or while unknown */
  email: string | null;
  /** null until the first collector-config fetch */
  deployment: DeploymentLabel | null;
  /** the device-login client name, or the token's label on the server */
  label: string | null;
  /** null = no expiry, or not known yet (a migrated 0.4 token before its first fetch) */
  expires_at: string | null;
  /** from collector-config; null until it answered for this token (a migrated or unchecked login) */
  source: TokenSource | null;
  added_at: string;
}

/** ~/.ai-obs/config.json (mode 0600). Tokens live only here, never in a repository. */
export interface CollectorConfig {
  version: typeof CONFIG_VERSION;
  /** random UUID generated at the first login; identifies this machine */
  machine_id: string;
  created_at: string;
  /** login order = listing and flush order */
  servers: ServerEntry[];
}

/** What loading a pre-0.5 file changed (in memory; `migrateHome` persists it and prints / logs the notes). */
export interface ConfigMigration {
  from: 1 | 2;
  /** human-readable notes: dropped company tokens, merged duplicates */
  notes: string[];
}

export interface LoadedConfig {
  config: CollectorConfig;
  migration: ConfigMigration | null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A token this collector can send with: `aiobs_u_` plus something. */
export function isUserToken(token: unknown): token is string {
  return typeof token === 'string' && token.startsWith(USER_TOKEN_PREFIX) && token.length > USER_TOKEN_PREFIX.length;
}

/** The retired prefix a token starts with (`aiobs_c_`, `aiobs_t_`), else null. */
export function retiredPrefix(token: string): string | null {
  return RETIRED_TOKEN_PREFIXES.find((p) => token.startsWith(p)) ?? null;
}

/** Validates and normalizes an endpoint URL (http/https, no trailing slash, no query or fragment). Throws on garbage. */
export function normalizeEndpoint(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`endpoint must be http(s): ${raw}`);
  if (url.username || url.password) throw new Error(`endpoint must not contain credentials: ${url.host}`);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** normalizeEndpoint, or null instead of throwing. */
export function tryNormalizeEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return normalizeEndpoint(raw);
  } catch {
    return null;
  }
}

/** `host[:port]` of an endpoint: the key of delivery.json and of the collector-config cache (appendix E). */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host.toLowerCase();
  } catch {
    return endpoint;
  }
}

export function maskToken(token: string): string {
  const known = [USER_TOKEN_PREFIX, ...RETIRED_TOKEN_PREFIXES].some((p) => token.startsWith(p));
  const prefix = known ? token.slice(0, 8) : '';
  return token.length >= prefix.length + 12 ? `${prefix}…${token.slice(-4)}` : `${prefix}…`;
}

/** sha256(token), first 16 hex: stored instead of the token wherever a token must be recognised (caches, delivery state). */
export function tokenFingerprint(token: string): string {
  return sha256(token).slice(0, 16);
}

export function findServer(config: Pick<CollectorConfig, 'servers'>, endpoint: string): ServerEntry | undefined {
  return config.servers.find((s) => s.endpoint === endpoint);
}

/**
 * `--server` argument → registered entry: a full URL (normalized) or a bare host (`obs.example.com`,
 * `localhost:3000`) that matches exactly one entry.
 */
export function matchServer(config: Pick<CollectorConfig, 'servers'>, arg: string): ServerEntry | undefined {
  const ep = tryNormalizeEndpoint(arg);
  if (ep) {
    const hit = findServer(config, ep);
    if (hit) return hit;
  }
  const host = arg.trim().toLowerCase().replace(/\/+$/, '');
  const byHost = config.servers.filter((s) => endpointHost(s.endpoint) === host);
  return byHost.length === 1 ? byHost[0] : undefined;
}

/** True when `expires_at` is known and not later than `nowMs`. */
export function isExpired(entry: Pick<ServerEntry, 'expires_at'>, nowMs: number): boolean {
  if (!entry.expires_at) return false;
  const at = Date.parse(entry.expires_at);
  return Number.isFinite(at) && at <= nowMs;
}

/** Whole days until `expires_at` (rounded down, ≥ 0), or null when it has no (known) expiry. */
export function daysLeft(entry: Pick<ServerEntry, 'expires_at'>, nowMs: number): number | null {
  if (!entry.expires_at) return null;
  const at = Date.parse(entry.expires_at);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((at - nowMs) / 86_400_000));
}

function parseDeployment(v: unknown): DeploymentLabel | null {
  return isObject(v) && nonEmpty(v.name) && nonEmpty(v.slug) ? { name: v.name, slug: v.slug } : null;
}

function parseServer(v: unknown): ServerEntry | null {
  if (!isObject(v) || !isUserToken(v.token)) return null;
  const endpoint = tryNormalizeEndpoint(v.endpoint);
  if (!endpoint) return null;
  const source = v.source === 'device' || v.source === 'manual' ? v.source : null;
  return {
    endpoint,
    token: v.token,
    email: nonEmpty(v.email) ? v.email : null,
    deployment: parseDeployment(v.deployment),
    label: nonEmpty(v.label) ? v.label : null,
    expires_at: nonEmpty(v.expires_at) && Number.isFinite(Date.parse(v.expires_at)) ? v.expires_at : null,
    source,
    added_at: nonEmpty(v.added_at) ? v.added_at : new Date(0).toISOString(),
  };
}

/** Keeps the last entry per endpoint of a v3 file (a hand-edited duplicate; `upsertServer` never writes one). */
function dedupe(servers: ServerEntry[]): ServerEntry[] {
  const out: ServerEntry[] = [];
  for (const s of servers) {
    const i = out.findIndex((x) => x.endpoint === s.endpoint);
    if (i < 0) out.push(s);
    else if (Date.parse(s.added_at) >= Date.parse(out[i]!.added_at)) out[i] = s;
  }
  return out;
}

/** A v2 user token being migrated, with what the choice between two tokens of one server needs. */
interface V2Candidate {
  entry: ServerEntry;
  name: string;
  company: string | null;
  /** fingerprints of this token and of the tokens it replaced (v2 `prior_fps`) */
  fps: string[];
  /** projects.json assignments made with this token */
  uses: number;
}

const plainText = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 100);

/** projects.json (0.2 – 0.4) assignments → number per candidate (by fingerprint, else by token name). */
function countAssignments(projects: unknown, candidates: V2Candidate[]): void {
  if (!isObject(projects)) return;
  for (const a of Object.values(projects)) {
    if (!isObject(a) || !nonEmpty(a.token)) continue;
    const fp = nonEmpty(a.token_fp) ? a.token_fp : null;
    const hit = (fp ? candidates.find((c) => c.fps.includes(fp)) : undefined) ?? candidates.find((c) => c.name === a.token);
    if (hit) hit.uses++;
  }
}

const accountLabel = (c: V2Candidate): string =>
  `${c.entry.email ? plainText(c.entry.email) : `token ${maskToken(c.entry.token)}`}${c.company ? ` (${plainText(c.company)})` : ''}, used by ${c.uses} ${c.uses === 1 ? 'repository' : 'repositories'} in projects.json`;

/**
 * One entry per endpoint. Two user tokens of one server (one machine logged in to several companies of a dev
 * server): the one more repositories of projects.json used wins, then the later one. The note names both
 * accounts and how to switch: never a silent choice.
 */
function chooseV2(candidates: V2Candidate[], notes: string[]): ServerEntry[] {
  const out: V2Candidate[] = [];
  for (const c of candidates) {
    const i = out.findIndex((x) => x.entry.endpoint === c.entry.endpoint);
    if (i < 0) {
      out.push(c);
      continue;
    }
    const cur = out[i]!;
    const later = Date.parse(c.entry.added_at) >= Date.parse(cur.entry.added_at);
    const keep = c.uses > cur.uses || (c.uses === cur.uses && later) ? c : cur;
    const drop = keep === c ? cur : c;
    notes.push(
      `two user tokens for ${c.entry.endpoint}, and a server keeps one: kept ${accountLabel(keep)}; dropped ${accountLabel(drop)}. ` +
        `The dropped token is still in the kept copy of the old config.json. To report as that account on this machine, run \`ai-obs login --server ${c.entry.endpoint}\` and approve with it`,
    );
    out[i] = keep;
  }
  return out.map((c) => c.entry);
}

/**
 * A v2 (0.2 – 0.4) file → v3: user-token entries become server entries (endpoint kept, expiry unknown
 * until the next collector-config fetch); company-token entries are dropped with a note; routing epochs,
 * `legacy`, `invalid_tokens`, `prior_fps`, `git_email` and the default `endpoint` are discarded.
 * `projects` (the 0.2 – 0.4 projects.json) decides between two user tokens of one server.
 */
function migrateV2(raw: Record<string, unknown>, machineId: string, createdAt: string, projects: unknown): LoadedConfig {
  const notes: string[] = [];
  const candidates: V2Candidate[] = [];
  for (const t of Array.isArray(raw.tokens) ? raw.tokens : []) {
    if (!isObject(t)) continue;
    const name = nonEmpty(t.name) ? t.name.replace(/[^a-z0-9-]/g, '?').slice(0, 63) : '?';
    if (typeof t.token === 'string' && retiredPrefix(t.token)) {
      notes.push(`company token ${name} (${maskToken(t.token)}) dropped: company tokens no longer exist; run \`ai-obs login\` for that server`);
      continue;
    }
    const endpoint = tryNormalizeEndpoint(t.endpoint);
    if (!isUserToken(t.token) || !endpoint) continue;
    const company = isObject(t.company) && nonEmpty(t.company.name) ? t.company.name : null;
    const prior = Array.isArray(t.prior_fps) ? t.prior_fps.filter(nonEmpty) : [];
    candidates.push({
      entry: {
        endpoint,
        token: t.token,
        email: nonEmpty(t.email) ? t.email : null,
        deployment: null,
        label: null,
        expires_at: null,
        source: null,
        added_at: nonEmpty(t.added_at) ? t.added_at : new Date(0).toISOString(),
      },
      name,
      company,
      fps: [tokenFingerprint(t.token), ...prior],
      uses: 0,
    });
  }
  countAssignments(projects, candidates);
  return { config: { version: CONFIG_VERSION, machine_id: machineId, created_at: createdAt, servers: chooseV2(candidates, notes) }, migration: { from: 2, notes } };
}

/** The 0.2 – 0.4 projects.json (or the copy a migration kept), only read to migrate a v2 config. */
function readLegacyProjects(paths: Partial<Pick<AiObsPaths, 'legacyProjects'>>): unknown {
  if (!paths.legacyProjects) return null;
  return readJsonFile<unknown>(paths.legacyProjects) ?? readJsonFile<unknown>(`${paths.legacyProjects}.v2`);
}

/**
 * Reads config.json; null when missing, unparsable or without a machine_id (not configured). A v2 file is
 * migrated in memory (`migration` says what changed; `migrateHome` writes it). A 0.1.x file loads with no
 * servers. Never throws.
 */
export function loadConfigFile(paths: Pick<AiObsPaths, 'config'> & Partial<Pick<AiObsPaths, 'legacyProjects'>>): LoadedConfig | null {
  const raw = readJsonFile<unknown>(paths.config);
  if (!isObject(raw) || typeof raw.machine_id !== 'string' || !raw.machine_id) return null;
  const createdAt = nonEmpty(raw.created_at) ? raw.created_at : new Date(0).toISOString();
  if (raw.version === CONFIG_VERSION || Array.isArray(raw.servers)) {
    const servers: ServerEntry[] = [];
    for (const s of Array.isArray(raw.servers) ? raw.servers : []) {
      const e = parseServer(s);
      if (e) servers.push(e);
    }
    return { config: { version: CONFIG_VERSION, machine_id: raw.machine_id, created_at: createdAt, servers: dedupe(servers) }, migration: null };
  }
  if (Array.isArray(raw.tokens)) return migrateV2(raw, raw.machine_id, createdAt, readLegacyProjects(paths));
  // 0.1.x: one team token the server revoked long ago (ADR-0022)
  return { config: { version: CONFIG_VERSION, machine_id: raw.machine_id, created_at: createdAt, servers: [] }, migration: { from: 1, notes: [] } };
}

/** The (migrated) config, or null when not configured. Never throws. */
export function loadConfig(paths: Pick<AiObsPaths, 'config'> & Partial<Pick<AiObsPaths, 'legacyProjects'>>): CollectorConfig | null {
  return loadConfigFile(paths)?.config ?? null;
}

function serializeServer(s: ServerEntry): Record<string, unknown> {
  return {
    endpoint: s.endpoint,
    token: s.token,
    email: s.email,
    deployment: s.deployment ? { name: s.deployment.name, slug: s.deployment.slug } : null,
    label: s.label,
    expires_at: s.expires_at,
    source: s.source,
    added_at: s.added_at,
  };
}

/** Writes config.json v3 (0600, atomic). */
export function saveConfig(paths: Pick<AiObsPaths, 'config'>, config: CollectorConfig): void {
  writeJsonAtomic(
    paths.config,
    { version: CONFIG_VERSION, machine_id: config.machine_id, created_at: config.created_at, servers: config.servers.map(serializeServer) },
    0o600,
  );
}

/** A config with no servers, keeping the machine identity of `existing`. */
export function newMachineConfig(existing: CollectorConfig | null, now: Date = new Date()): CollectorConfig {
  return {
    version: CONFIG_VERSION,
    machine_id: existing?.machine_id ?? randomUUID(),
    created_at: existing?.created_at ?? now.toISOString(),
    servers: existing ? [...existing.servers] : [],
  };
}

export type UpsertResult = { kind: 'added' | 'replaced'; config: CollectorConfig; entry: ServerEntry; previous?: ServerEntry };

/**
 * Adds a server, or replaces the token of the entry with the same endpoint (data queued for the old token
 * is sent with the new one: streams are keyed by endpoint, not by token; `registerServer` sets it aside first
 * when the new token belongs to another account). Pure.
 */
export function upsertServer(config: CollectorConfig, entry: ServerEntry): UpsertResult {
  const i = config.servers.findIndex((s) => s.endpoint === entry.endpoint);
  if (i < 0) return { kind: 'added', config: { ...config, servers: [...config.servers, entry] }, entry };
  const servers = config.servers.slice();
  const previous = servers[i]!;
  servers[i] = entry;
  return { kind: 'replaced', config: { ...config, servers }, entry, previous };
}

export function removeServer(config: CollectorConfig, endpoint: string): CollectorConfig {
  return { ...config, servers: config.servers.filter((s) => s.endpoint !== endpoint) };
}

/**
 * Single-server convenience (tests, protocol-conformance): one server entry; keeps machine_id /
 * created_at of `existing`. Throws on a token that is not `aiobs_u_…`.
 */
export function buildConfig(input: {
  endpoint: string;
  token: string;
  existing?: CollectorConfig | null;
  now?: Date;
  email?: string | null;
  deployment?: DeploymentLabel | null;
  label?: string | null;
  expiresAt?: string | null;
  source?: TokenSource | null;
}): CollectorConfig {
  if (!isUserToken(input.token)) throw new Error(`token must start with ${USER_TOKEN_PREFIX}`);
  const now = input.now ?? new Date();
  return {
    version: CONFIG_VERSION,
    machine_id: input.existing?.machine_id ?? randomUUID(),
    created_at: input.existing?.created_at ?? now.toISOString(),
    servers: [
      {
        endpoint: normalizeEndpoint(input.endpoint),
        token: input.token,
        email: input.email ?? null,
        deployment: input.deployment ?? null,
        label: input.label ?? null,
        expires_at: input.expiresAt ?? null,
        source: input.source ?? null,
        added_at: now.toISOString(),
      },
    ],
  };
}
