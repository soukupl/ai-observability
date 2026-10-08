import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { HarnessAdapter, HookInvocation } from '../src/adapters/types.js';
import { writeCache } from '../src/cc-cache.js';
import {
  buildConfig,
  newMachineConfig,
  normalizeEndpoint,
  saveConfig,
  type CollectorConfig,
  type CompanyLabel,
  type RoutingEpoch,
  type TokenEntry,
} from '../src/config.js';
import { writeJsonAtomic } from '../src/fsutil.js';
import { aiObsPaths, type AiObsPaths } from '../src/paths.js';
import { saveProjects, type Assignment } from '../src/projects.js';
import type { CollectorConfigResponse, ProjectNamingMode } from '../src/protocol-types.js';

const homes: string[] = [];

export function tmpHome(): AiObsPaths {
  const dir = mkdtempSync(join(tmpdir(), 'ai-obs-test-'));
  homes.push(dir);
  return aiObsPaths(join(dir, '.ai-obs'));
}

export function cleanupHomes(): void {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
}

export const ACME: CompanyLabel = { name: 'Acme', slug: 'acme' };

/**
 * One verified user token `acme` (company Acme, dev@acme.com, `aiobs_u_testtoken`) at `endpoint`, the
 * top-level git_email, one routing epoch, and a fetched collector-config cache (plain, no salt).
 */
export function writeTestConfig(paths: AiObsPaths, endpoint = 'http://127.0.0.1:9'): CollectorConfig {
  const config = buildConfig({ endpoint, token: 'aiobs_u_testtoken', gitEmail: 'dev@acme.com', company: ACME, email: 'dev@acme.com' });
  saveConfig(paths, config);
  const entry = config.tokens[0] as TokenEntry;
  writeCache(paths, entry, {
    fetched_at: new Date().toISOString(),
    value: { project_naming: 'plain', min_collector_version: '0.0.1', company: ACME, user: { email: 'dev@acme.com' } },
  });
  return config;
}

export interface TestTokenSpec {
  name: string;
  /** default http://127.0.0.1:9 */
  endpoint?: string;
  /** default `aiobs_u_test-<name>` */
  token?: string;
  /** default {name: <Name>, slug: <name>}; null = unverified (no company stored) */
  company?: CompanyLabel | null;
  email?: string;
  prior_fps?: string[];
  provisional_name?: true;
  /** collector-config cache: false = none; default a fetched plain cache reporting `company` (or the slug = name) */
  cache?: false | { naming?: ProjectNamingMode; salt?: string; company?: CompanyLabel | null; user?: { email: string } | null };
}

/**
 * Several tokens (registration order) with their caches. `opts.epochs` replaces the routing epochs that
 * saveConfig would write; `opts.invalid` adds raw malformed entries.
 */
export function writeTestTokens(
  paths: AiObsPaths,
  specs: TestTokenSpec[],
  opts: { epochs?: RoutingEpoch[]; invalid?: unknown[]; now?: Date; gitEmail?: string } = {},
): CollectorConfig {
  const now = opts.now ?? new Date();
  const tokens: TokenEntry[] = specs.map((s) => {
    const company = s.company === undefined ? { name: s.name[0]!.toUpperCase() + s.name.slice(1), slug: s.name } : s.company;
    return {
      name: s.name,
      ...(company ? { company } : {}),
      ...(s.email ? { email: s.email } : {}),
      endpoint: normalizeEndpoint(s.endpoint ?? 'http://127.0.0.1:9'),
      token: s.token ?? `aiobs_u_test-${s.name}`,
      added_at: now.toISOString(),
      ...(s.prior_fps ? { prior_fps: s.prior_fps } : {}),
      ...(s.provisional_name ? { provisional_name: true as const } : {}),
    };
  });
  const config: CollectorConfig = {
    ...newMachineConfig(null, now),
    endpoint: tokens.at(-1)?.endpoint ?? 'http://127.0.0.1:9',
    git_email: opts.gitEmail ?? 'dev@acme.com',
    tokens,
    invalidTokens: opts.invalid ?? [],
  };
  saveConfig(paths, config, now);
  if (opts.epochs) {
    const raw = JSON.parse(readFileSync(paths.config, 'utf8')) as Record<string, unknown>;
    writeJsonAtomic(paths.config, { ...raw, routing_epochs: opts.epochs }, 0o600);
    config.routingEpochs = opts.epochs;
  }
  specs.forEach((s, i) => {
    if (s.cache === false) return;
    const entry = tokens[i] as TokenEntry;
    const c = s.cache ?? {};
    const company = c.company === undefined ? (entry.company ?? { name: entry.name, slug: entry.name }) : c.company;
    const value: CollectorConfigResponse = {
      project_naming: c.naming ?? 'plain',
      min_collector_version: '0.0.1',
      ...(c.salt ? { project_salt: c.salt } : {}),
      ...(company ? { company } : {}),
      ...(c.user !== undefined ? { user: c.user } : {}),
    };
    writeCache(paths, entry, { fetched_at: now.toISOString(), value });
  });
  return config;
}

export function writeProjects(paths: AiObsPaths, entries: Record<string, Assignment>): void {
  saveProjects(paths, entries);
}

/** A temp git repository (realpath), optionally with an `origin` remote. Removed by cleanupHomes. */
export function gitRepo(opts: { remote?: string } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ai-obs-repo-')));
  homes.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (opts.remote) execFileSync('git', ['remote', 'add', 'origin', opts.remote], { cwd: dir });
  return dir;
}

/** The bearer token of a request (without `Bearer `), or null. */
export function bearerOf(req: Received): string | null {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
}

export interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  json: unknown;
}

/** What a test server's `respond` returns for one request. */
export interface ServerReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

/** Local ingest server; `respond` decides each response. */
export async function startServer(
  respond: (req: Received, n: number) => ServerReply,
): Promise<{ url: string; received: Received[]; close: () => Promise<void>; server: Server }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let raw = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
      let json: unknown = null;
      try {
        json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
      } catch {
        /* not json */
      }
      const r: Received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, json };
      received.push(r);
      const out = respond(r, received.length);
      const send = () => {
        res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
        res.end(out.body === undefined ? '' : JSON.stringify(out.body));
      };
      if (out.delayMs) setTimeout(send, out.delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    server,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Accepting ingest + collector-config server for company Acme (user dev@acme.com). */
export function okResponder(naming: ProjectNamingMode = 'plain', opts: { salt?: string } = {}): (req: Received) => ServerReply {
  return (req: Received): ServerReply => {
    if (req.url === '/api/v1/collector-config') {
      return {
        status: 200,
        body: {
          project_naming: naming,
          min_collector_version: '0.0.1',
          ...(opts.salt ? { project_salt: opts.salt } : {}),
          company: ACME,
          user: { email: 'dev@acme.com' },
        },
      };
    }
    const events = (req.json as { events?: unknown[] } | null)?.events ?? [];
    return { status: 200, body: { accepted: events.length, duplicates: 0, rejected: [] } };
  };
}

export interface TokenResponse {
  /** default 200 */
  status?: number;
  company?: CompanyLabel | null;
  naming?: ProjectNamingMode;
  salt?: string;
  user?: { email: string } | null;
  /** seconds, sent as Retry-After on a non-2xx status */
  retryAfter?: number;
  /** error message of a non-2xx status */
  error?: string;
}

/**
 * A server that answers per bearer token: unknown tokens get 401; a non-2xx `status` is returned for
 * both collector-config and ingest; 2xx accepts every event.
 */
export function tokenResponder(map: Record<string, TokenResponse>): (req: Received) => ServerReply {
  return (req: Received): ServerReply => {
    const bearer = bearerOf(req);
    const spec = bearer !== null && Object.prototype.hasOwnProperty.call(map, bearer) ? map[bearer] : undefined;
    if (!spec) return { status: 401, body: { error: 'invalid or revoked ingest token' }, headers: { 'www-authenticate': 'Bearer' } };
    const status = spec.status ?? 200;
    if (status < 200 || status >= 300) {
      return {
        status,
        body: { error: spec.error ?? (status === 403 ? 'company is suspended' : status === 429 ? 'rate limit exceeded' : `HTTP ${status}`) },
        ...(spec.retryAfter !== undefined ? { headers: { 'retry-after': String(spec.retryAfter) } } : {}),
      };
    }
    if (req.url === '/api/v1/collector-config') {
      return {
        status,
        body: {
          project_naming: spec.naming ?? 'plain',
          min_collector_version: '0.0.1',
          ...(spec.salt ? { project_salt: spec.salt } : {}),
          ...(spec.company ? { company: spec.company } : {}),
          ...(spec.user !== undefined ? { user: spec.user } : {}),
        },
      };
    }
    const events = (req.json as { events?: unknown[] } | null)?.events ?? [];
    return { status, body: { accepted: events.length, duplicates: 0, rejected: [] } };
  };
}

export function fakeAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter & { calls: HookInvocation[]; installs: unknown[]; uninstalls: unknown[] } {
  const calls: HookInvocation[] = [];
  const installs: unknown[] = [];
  const uninstalls: unknown[] = [];
  return {
    name: 'claude-code',
    displayName: 'Fake Claude',
    sessionStartHooks: ['SessionStart'],
    async detect() {
      return { installed: true, version: '2.1.0', versionSupported: true, hooksInstalled: { user: installs.length > 0, project: null } };
    },
    async installHooks(opts) {
      installs.push(opts);
    },
    async uninstallHooks(opts) {
      uninstalls.push(opts);
    },
    async handleHook(event) {
      calls.push(event);
    },
    async sweepCrashedSessions() {},
    async summarize() {
      return new Map();
    },
    ...overrides,
    calls,
    installs,
    uninstalls,
  };
}
