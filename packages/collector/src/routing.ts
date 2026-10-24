/**
 * Routing (brief appendix E): a session's events go to a stream keyed by (project key, server endpoint,
 * team slug), fixed at the session's first hook; the sender sends a stream with the token of its endpoint's
 * server entry, and never to an endpoint this machine has not logged in to.
 */
import { createHash } from 'node:crypto';
import { endpointHost, isExpired, loadConfig, tryNormalizeEndpoint, type CollectorConfig, type ServerEntry } from './config.js';
import { readDelivery, serverDelivery, type Blocked } from './delivery.js';
import type { DotFileValue } from './dotfile.js';
import type { AiObsPaths } from './paths.js';
import { TEAM_SLUG_RE } from './protocol-types.js';

/**
 * Where a session's events go, pinned once per session (C15). `endpoint` '' = no server chosen yet (no dot
 * file and two or more servers); `team` '' = no dot-file team. `unresolved` = git timed out at capture (C16).
 */
export type StreamKey =
  | { kind: 'project'; pk: string; endpoint: string; team: string }
  | { kind: 'unresolved'; cwd: string; endpoint: string; team: string };

export interface StreamTarget {
  endpoint: string;
  team: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Directory name of a project stream under queue/p/: `s-` + first 32 hex of sha256(pk \n endpoint \n team). */
export function streamDirName(pk: string, endpoint: string, team: string): string {
  return `s-${sha256(`${pk}\n${endpoint}\n${team}`).slice(0, 32)}`;
}

/** Directory name of an unresolved stream under queue/u/. */
export function unresolvedDirName(cwd: string, endpoint: string, team: string): string {
  return `s-${sha256(`cwd:${cwd}\n${endpoint}\n${team}`).slice(0, 32)}`;
}

export function keyDirName(key: StreamKey): string {
  return key.kind === 'project' ? streamDirName(key.pk, key.endpoint, key.team) : unresolvedDirName(key.cwd, key.endpoint, key.team);
}

/**
 * The target of a new session: the dot file's server, else the only registered server, else none (''); the
 * dot file's team, else ''. A dot-file server this machine is not logged in to is still the target: its
 * events wait (held `no-server`) until `ai-obs login --server <url>`.
 */
export function targetFor(config: Pick<CollectorConfig, 'servers'>, dot: DotFileValue): StreamTarget {
  const endpoint = dot.server ?? (config.servers.length === 1 ? config.servers[0]!.endpoint : '');
  return { endpoint, team: dot.team ?? '' };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isTeam = (v: unknown): v is string => v === '' || (typeof v === 'string' && TEAM_SLUG_RE.test(v));

/**
 * A stored stream key (session state, staged summaries) in the current shape. Keys written by 0.2 – 0.4
 * (`bind`) are converted like their streams: a token binding becomes its endpoint with no team, an open one
 * the only server (else '' = no server chosen). Null for anything else.
 */
export function upgradeStreamKey(raw: unknown, config: Pick<CollectorConfig, 'servers'> | null): StreamKey | null {
  if (!isObject(raw)) return null;
  let target: StreamTarget | null = null;
  if (typeof raw.endpoint === 'string' && isTeam(raw.team)) {
    const endpoint = raw.endpoint === '' ? '' : tryNormalizeEndpoint(raw.endpoint);
    if (endpoint !== null) target = { endpoint, team: raw.team };
  } else if (isObject(raw.bind)) {
    target = legacyTarget(raw.bind, config);
  }
  if (!target) return null;
  if (raw.kind === 'project' && nonEmpty(raw.pk)) return { kind: 'project', pk: raw.pk, ...target };
  if (raw.kind === 'unresolved' && nonEmpty(raw.cwd)) return { kind: 'unresolved', cwd: raw.cwd, ...target };
  return null;
}

/** The target of a 0.2 – 0.4 binding (`{kind: 'open'}` or `{kind: 'token', id: {endpoint, …}}`). */
export function legacyTarget(bind: unknown, config: Pick<CollectorConfig, 'servers'> | null): StreamTarget | null {
  if (!isObject(bind)) return null;
  if (bind.kind === 'open') return { endpoint: config?.servers.length === 1 ? config.servers[0]!.endpoint : '', team: '' };
  if (bind.kind === 'token' && isObject(bind.id)) {
    const endpoint = tryNormalizeEndpoint(bind.id.endpoint);
    return endpoint ? { endpoint, team: '' } : null;
  }
  return null;
}

/** What a queue stream is, as far as routing cares. */
export type StreamIdentity =
  | { kind: 'project'; pk: string; endpoint: string; team: string }
  | { kind: 'unresolved'; cwd: string; endpoint: string; team: string }
  | { kind: 'pre-upgrade' }
  | { kind: 'legacy' }
  | { kind: 'unknown' };

export type HeldReason = 'no-server' | 'unresolved' | 'pre-upgrade' | 'legacy' | 'unknown-stream';
export type Resolution = { kind: 'server'; server: ServerEntry } | { kind: 'held'; reason: HeldReason; endpoint?: string };

/** Everything routing reads, fresh from disk (C17). */
export interface RoutingView {
  config: CollectorConfig;
  /** per endpoint host: servers currently refused with 401 / 403 */
  blocked: Record<string, Blocked>;
  /** wall clock (ms) for the expiry check */
  nowMs: number;
}

/** Sync, never throws, no caching (C17). Null = not configured. */
export function loadRouting(paths: AiObsPaths, nowMs: number = Date.now()): RoutingView | null {
  const config = loadConfig(paths);
  if (!config) return null;
  const blocked: Record<string, Blocked> = Object.create(null) as Record<string, Blocked>;
  try {
    const delivery = readDelivery(paths);
    for (const s of config.servers) {
      const b = serverDelivery(delivery, s).blocked;
      if (b) blocked[endpointHost(s.endpoint)] = b;
    }
  } catch {
    /* unreadable: nothing blocked */
  }
  return { config, blocked, nowMs };
}

/** The server a stream endpoint resolves to: its entry, or the only server for '' (no server chosen). */
export function serverFor(config: Pick<CollectorConfig, 'servers'>, endpoint: string): ServerEntry | undefined {
  if (endpoint === '') return config.servers.length === 1 ? config.servers[0] : undefined;
  return config.servers.find((s) => s.endpoint === endpoint);
}

/**
 * THE send rule. Pure. A project stream goes to the server entry of its endpoint ('' → the only server);
 * none → held `no-server`. Unresolved streams wait for their key; root segments (0.1.x) are never sent;
 * 0.2 – 0.4 stream directories wait for the migration. Blocked / expired / never-fetched servers still
 * resolve: the sender decides whether it can send now.
 */
export function resolveStream(view: Pick<RoutingView, 'config'>, stream: StreamIdentity): Resolution {
  if (stream.kind === 'unknown') return { kind: 'held', reason: 'unknown-stream' };
  if (stream.kind === 'pre-upgrade') return { kind: 'held', reason: 'pre-upgrade' };
  if (stream.kind === 'legacy') return { kind: 'held', reason: 'legacy' };
  if (stream.kind === 'unresolved') return { kind: 'held', reason: 'unresolved', endpoint: stream.endpoint };
  const server = serverFor(view.config, stream.endpoint);
  return server ? { kind: 'server', server } : { kind: 'held', reason: 'no-server', endpoint: stream.endpoint };
}

/** Whether the server's token may be used now: not refused (401 / 403) and not past its expiry. */
export function usable(view: RoutingView, server: ServerEntry): boolean {
  return !Object.prototype.hasOwnProperty.call(view.blocked, endpointHost(server.endpoint)) && !isExpired(server, view.nowMs);
}

/** A resolution that can be sent now (C13: only this time counts against the 30-day age cap). */
export function sendableNow(view: RoutingView, r: Resolution): boolean {
  return r.kind === 'server' && usable(view, r.server);
}
