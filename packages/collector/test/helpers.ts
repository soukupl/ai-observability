import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { HarnessAdapter, HookInvocation } from '../src/adapters/types.js';
import { writeCache } from '../src/cc-cache.js';
import { newMachineConfig, normalizeEndpoint, saveConfig, type CollectorConfig, type ServerEntry } from '../src/config.js';
import { DOT_FILE, LOCAL_DOT_FILE } from '../src/dotfile.js';
import { aiObsPaths, type AiObsPaths } from '../src/paths.js';
import type { CollectorConfigResponse, IngestWarning, ProjectNamingMode } from '../src/protocol-types.js';

const homes: string[] = [];

export function tmpHome(): AiObsPaths {
  const dir = mkdtempSync(join(tmpdir(), 'ai-obs-test-'));
  homes.push(dir);
  return aiObsPaths(join(dir, '.ai-obs'));
}

export function cleanupHomes(): void {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
}

export const SPECTADO = { name: 'SPECTADO', slug: 'spectado' };
export const TEAMS = [
  { slug: 'platform', name: 'Platform' },
  { slug: 'spectado', name: 'SPECTADO' },
];

export interface CcOptions {
  naming?: ProjectNamingMode;
  salt?: string;
  teams?: Array<{ slug: string; name: string }>;
  email?: string | null;
  expiresAt?: string | null;
  deployment?: { name: string; slug: string };
  primaryTeam?: string | null;
  label?: string | null;
}

/** A collector-config body as the current server sends it (appendix A). */
export function ccValue(o: CcOptions = {}): CollectorConfigResponse {
  return {
    project_naming: o.naming ?? 'plain',
    min_collector_version: '0.0.1',
    ...(o.salt ? { project_salt: o.salt } : {}),
    deployment: o.deployment ?? SPECTADO,
    user: { email: o.email === undefined ? 'dev@acme.com' : o.email, name: 'Dev', kind: o.email === null ? 'service' : 'person' },
    teams: o.teams ?? TEAMS,
    primary_team: o.primaryTeam === undefined ? 'spectado' : o.primaryTeam,
    token: { expires_at: o.expiresAt === undefined ? null : o.expiresAt, label: o.label === undefined ? 'test-mac' : o.label, source: 'device' },
  };
}

export interface TestServerSpec {
  /** default http://127.0.0.1:9 */
  endpoint?: string;
  /** default aiobs_u_testtoken (first) / aiobs_u_test-<host> */
  token?: string;
  email?: string | null;
  expiresAt?: string | null;
  /** collector-config cache: false = none (never fetched); default a fetched plain cache */
  cache?: false | CcOptions;
}

/** Several servers (login order) with their collector-config caches. */
export function writeTestServers(paths: AiObsPaths, specs: TestServerSpec[], opts: { now?: Date } = {}): CollectorConfig {
  const now = opts.now ?? new Date();
  const servers: ServerEntry[] = specs.map((s, i) => {
    const endpoint = normalizeEndpoint(s.endpoint ?? 'http://127.0.0.1:9');
    return {
      endpoint,
      token: s.token ?? (i === 0 ? 'aiobs_u_testtoken' : `aiobs_u_test-${new URL(endpoint).port || i}`),
      email: s.email === undefined ? 'dev@acme.com' : s.email,
      deployment: SPECTADO,
      label: 'test-mac',
      expires_at: s.expiresAt ?? null,
      source: 'device',
      added_at: now.toISOString(),
    };
  });
  const config: CollectorConfig = { ...newMachineConfig(null, now), servers };
  saveConfig(paths, config);
  specs.forEach((s, i) => {
    if (s.cache === false) return;
    writeCache(paths, servers[i]!, { fetched_at: now.toISOString(), value: ccValue({ ...(s.cache ?? {}), ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}) }) });
  });
  return config;
}

/** One server (`aiobs_u_testtoken`, dev@acme.com, SPECTADO) at `endpoint` with a fetched plain cache. */
export function writeTestConfig(paths: AiObsPaths, endpoint = 'http://127.0.0.1:9', spec: Omit<TestServerSpec, 'endpoint'> = {}): CollectorConfig {
  return writeTestServers(paths, [{ ...spec, endpoint }]);
}

/** Writes `.ai-obs.json` (or `.ai-obs.local.json`) into `dir`. */
export function writeDotFile(dir: string, value: unknown, local = false): string {
  const file = join(dir, local ? LOCAL_DOT_FILE : DOT_FILE);
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return file;
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

export interface OkOptions extends CcOptions {
  /** warnings to attach to an ingest response (per request) */
  warnings?: (events: Array<{ type: string; session_id?: string; project?: { team?: string } }>) => IngestWarning[];
}

/** Accepting ingest + collector-config server (deployment SPECTADO, user dev@acme.com). */
export function okResponder(naming: ProjectNamingMode = 'plain', opts: OkOptions = {}): (req: Received) => ServerReply {
  return (req: Received): ServerReply => {
    if (req.url === '/api/v1/collector-config') return { status: 200, body: ccValue({ ...opts, naming }) };
    const events = ((req.json as { events?: unknown[] } | null)?.events ?? []) as Array<{ type: string }>;
    const warnings = opts.warnings?.(events) ?? [];
    return { status: 200, body: { accepted: events.length, duplicates: 0, rejected: [], ...(warnings.length ? { warnings } : {}) } };
  };
}

export interface TokenResponse extends CcOptions {
  /** default 200 */
  status?: number;
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
    if (!spec) return { status: 401, body: { error: 'expired or revoked, run `ai-obs login`' }, headers: { 'www-authenticate': 'Bearer' } };
    const status = spec.status ?? 200;
    if (status < 200 || status >= 300) {
      return {
        status,
        body: { error: spec.error ?? (status === 429 ? 'rate limit exceeded' : `HTTP ${status}`) },
        ...(spec.retryAfter !== undefined ? { headers: { 'retry-after': String(spec.retryAfter) } } : {}),
      };
    }
    if (req.url === '/api/v1/collector-config') return { status, body: ccValue(spec) };
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
