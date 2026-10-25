import { platform } from 'node:os';
import { gzipSync } from 'node:zlib';
import { applyUsageNaming } from './analysis/usage.js';
import { readCache, writeCache, parseCollectorConfigValue } from './cc-cache.js';
import { endpointHost, isExpired, loadConfig, saveConfig, type CollectorConfig, type ServerEntry } from './config.js';
import { readDelivery, serverDelivery, writeServerDelivery, type ServerDeliveryState } from './delivery.js';
import { errorMessage } from './fsutil.js';
import { nodeTransport, type Transport } from './http.js';
import { nullLogger, type Logger } from './log.js';
import type { AiObsPaths } from './paths.js';
import { loadPathSecret, resolveProjectKey, RESOLVE_TIMEOUT_MS, sendRef } from './project-key.js';
import {
  MAX_BATCH_EVENTS,
  SCHEMA_VERSION,
  type CollectorConfigResponse,
  type IngestBatch,
  type IngestEvent,
  type IngestResponse,
  type ProjectNamingMode,
} from './protocol-types.js';
import { identityOfRef, loggableKey, type BatchLimits, type QueueStore, type StreamRef } from './queue.js';
import { loadRouting, resolveStream, type HeldReason, type RoutingView, type StreamIdentity } from './routing.js';
import { COLLECTOR_NAME, COLLECTOR_VERSION } from './version.js';

export const INGEST_PATH = '/api/v1/ingest';
export const COLLECTOR_CONFIG_PATH = '/api/v1/collector-config';
const POST_TIMEOUT_MS = 15_000;
const GET_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 3600_000;
const BASE_BACKOFF_MS = 30_000;
/** Routing passes per flush: another one only when a stream's resolution changed mid-flush (C17). */
const MAX_PASSES = 3;

/** The message of a server that refused the token (401): the only fix is a new login. */
export function rejectedMessage(endpoint: string): string {
  return `token expired or revoked: run ai-obs login --server ${endpoint}`;
}
/** The message of a token past its local `expires_at` (nothing is sent with it). */
export function expiredMessage(endpoint: string): string {
  return `token expired: run ai-obs login --server ${endpoint}`;
}

export interface SenderDeps {
  paths: AiObsPaths;
  log?: Logger;
  transport?: Transport;
  now?: () => number;
  /** default: () => loadRouting(paths, now()) (fresh read per decision, C17); tests inject */
  routing?: () => RoutingView | null;
  /** key resolution for unresolved streams (default resolveProjectKey, 5 s) */
  resolveProjectKey?: (cwd: string, o: { timeoutMs: number }) => Promise<string | null>;
}

/**
 * Per-server result of one flush. `blocked` = skipped, still refused by an earlier 401 / 403; `expired` =
 * skipped, the token is past its `expires_at`; `auth_error` = refused (401 / 403) in this flush.
 */
export type ServerFlushStatus = 'ok' | 'empty' | 'backoff' | 'blocked' | 'expired' | 'auth_error' | 'failed';

export interface ServerFlushResult {
  status: ServerFlushStatus;
  batches: number;
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  /** events still queued for this server after the flush */
  left: number;
  error?: string;
}

export type FlushStatus = 'ok' | 'empty' | 'backoff' | 'auth_error' | 'failed' | 'held';

export interface FlushResult {
  status: FlushStatus;
  batches: number;
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  error?: string;
  /** per server endpoint, for every server a stream resolved to in this flush */
  servers: Record<string, ServerFlushResult>;
  /** streams not sent because no server can take them now */
  held: { events: number; projects: string[]; byReason: Partial<Record<HeldReason, number>> };
  /** this run's cap drops (C13) */
  dropped: { events: number; heldEvents: number };
}

export interface FlushOptions {
  /** ignore the backoff window and retry refused servers once (manual `ai-obs flush`) */
  force?: boolean;
  /** safety stop per server (default 50 batches per flush, C14) */
  maxBatches?: number;
  limits?: BatchLimits;
}

/**
 * The batch envelope. `identity` stays empty: the token identifies the user, and the server ignores a git
 * e-mail (brief appendix C), so none is sent.
 */
export function buildEnvelope(config: Pick<CollectorConfig, 'machine_id'>, events: IngestEvent[]): IngestBatch {
  return {
    schema: SCHEMA_VERSION,
    collector: { name: COLLECTOR_NAME, version: COLLECTOR_VERSION },
    machine: { id: config.machine_id, os: platform().slice(0, 32) },
    identity: {},
    events,
  };
}

function parseIngestResponse(body: string): IngestResponse {
  try {
    const r = JSON.parse(body) as Partial<IngestResponse>;
    return {
      accepted: Number(r.accepted) || 0,
      duplicates: Number(r.duplicates) || 0,
      rejected: Array.isArray(r.rejected) ? r.rejected : [],
    };
  } catch {
    return { accepted: 0, duplicates: 0, rejected: [] };
  }
}

/** The `error` field of a JSON error body, clipped; null when absent. */
function serverError(body: string): string | null {
  try {
    const e = (JSON.parse(body) as { error?: unknown } | null)?.error;
    return typeof e === 'string' && e ? e.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200) : null;
  } catch {
    return null;
  }
}

function retryAfterMs(header: string | string[] | undefined): number | null {
  const v = Array.isArray(header) ? header[0] : header;
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * Send-time naming (C3): a project stream's `session_start.project` is rebuilt from the plain stream key for
 * the receiving server (path keys always as a keyed hash) and never carries a team, also for streams queued
 * with one before ADR-0035 (an admin maps projects to teams on the server); skill / MCP names are hashed in hashed mode. Event ids depend on neither, so server de-dup is unaffected.
 */
export function prepareForSend(
  events: IngestEvent[],
  stream: StreamIdentity,
  o: { naming: ProjectNamingMode; salt?: string | null; pathSecret: string | null },
): IngestEvent[] {
  const named =
    stream.kind === 'project'
      ? events.map((e) => (e.type === 'session_start' ? { ...e, project: sendRef(stream.pk, o) } : e))
      : events;
  return applyUsageNaming(named, o.naming, o.salt);
}

interface ServerRun {
  entry: ServerEntry;
  result: ServerFlushResult;
  /** no more requests for this server in this flush (failed, blocked, backoff, budget used) */
  done: boolean;
  cc: CollectorConfigResponse | null;
  maxEvents: number;
  streams: Set<string>;
  /** a forced flush retrying a refused server (its blocked flag is cleared only on success) */
  retryBlocked: boolean;
  /** project keys delivered in this flush */
  repos: Set<string>;
}

/**
 * Sends every stream to the server its endpoint resolves to: per server Bearer, naming and salt; held streams
 * stay queued and are counted; a 401 / 403 blocks only that server; an expired token sends nothing; failures
 * back off per server and the flush goes on with the others. Routing is re-read before every POST (C17).
 * Server-side duplicates count as delivered (ADR-0011). Never throws.
 */
export async function flushQueue(store: QueueStore, deps: SenderDeps, opts: FlushOptions = {}): Promise<FlushResult> {
  const log = deps.log ?? nullLogger;
  const now = deps.now ?? Date.now;
  const transport = deps.transport ?? nodeTransport;
  const routing = deps.routing ?? (() => loadRouting(deps.paths, now()));
  const resolveKey = deps.resolveProjectKey ?? ((cwd, o) => resolveProjectKey(cwd, o));
  const maxBatches = opts.maxBatches ?? 50;
  const result: FlushResult = {
    status: 'empty',
    batches: 0,
    sent: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    servers: {},
    held: { events: 0, projects: [], byReason: {} },
    dropped: { events: 0, heldEvents: 0 },
  };

  try {
    // 0. Unresolved streams (git timed out at capture, C16): adopt them once their key is known.
    for (const ref of store.streams()) {
      if (ref.kind !== 'unresolved' || ref.cwd === undefined) continue;
      let pk: string | null = null;
      try {
        pk = await resolveKey(ref.cwd, { timeoutMs: RESOLVE_TIMEOUT_MS });
      } catch {
        pk = null;
      }
      if (pk !== null) store.adopt(ref, pk);
    }

    const pathSecret = loadPathSecret(deps.paths.projectSecret);
    const runs = new Map<string, ServerRun>();
    const heldSeen = new Set<string>();
    const heldProjects = new Set<string>();

    const delivery = (t: ServerEntry): ServerDeliveryState => serverDelivery(readDelivery(deps.paths), t);
    const saveDelivery = (t: ServerEntry, patch: Partial<Omit<ServerDeliveryState, 'token_fp'>>) => {
      try {
        writeServerDelivery(deps.paths, t, patch);
      } catch (err) {
        log.error('sender: cannot write delivery state', { error: errorMessage(err), server: endpointHost(t.endpoint) });
      }
    };
    const fail = (run: ServerRun, error: string, waitMs?: number | null) => {
      const failures = delivery(run.entry).consecutive_failures + 1;
      const backoff = waitMs ?? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
      saveDelivery(run.entry, {
        last_attempt_at: new Date(now()).toISOString(),
        last_error: error,
        consecutive_failures: failures,
        next_attempt_at: new Date(now() + backoff).toISOString(),
      });
      run.result.status = 'failed';
      run.result.error = error;
      run.done = true;
      log.warn('sender: delivery failed, events stay queued', { server: endpointHost(run.entry.endpoint), error, failures });
    };
    const block = (run: ServerRun, status: 401 | 403, body: string) => {
      const message = status === 401 ? rejectedMessage(run.entry.endpoint) : (serverError(body) ?? 'access denied');
      const error = `HTTP ${status}: ${message}`;
      saveDelivery(run.entry, {
        last_attempt_at: new Date(now()).toISOString(),
        last_error: error,
        blocked: { status, at: new Date(now()).toISOString(), message },
      });
      run.result.status = 'auth_error';
      run.result.error = error;
      run.done = true;
      log.warn('sender: token refused by the server, its events stay queued', { server: endpointHost(run.entry.endpoint), status });
    };

    /** First sight of a server in this flush: expired / blocked / backoff / collector-config (C4). */
    const startRun = async (t: ServerEntry): Promise<ServerRun> => {
      const run: ServerRun = {
        entry: t,
        result: { status: 'empty', batches: 0, sent: 0, accepted: 0, duplicates: 0, rejected: 0, left: 0 },
        done: false,
        cc: null,
        maxEvents: opts.limits?.maxEvents ?? MAX_BATCH_EVENTS,
        streams: new Set(),
        retryBlocked: false,
        repos: new Set(),
      };
      runs.set(t.endpoint, run);
      if (isExpired(t, now())) {
        // local pre-check (brief Q6): never send with a token past its expiry, not even on a forced flush
        run.result.status = 'expired';
        run.result.error = expiredMessage(t.endpoint);
        run.done = true;
        return run;
      }
      const st = delivery(t);
      run.retryBlocked = !!st.blocked;
      if (st.blocked && !opts.force) {
        run.result.status = 'blocked';
        run.result.error = `HTTP ${st.blocked.status}: ${st.blocked.message}`;
        run.done = true;
        return run;
      }
      if (!opts.force && st.next_attempt_at && Date.parse(st.next_attempt_at) > now()) {
        run.result.status = 'backoff';
        if (st.last_error) run.result.error = st.last_error;
        run.done = true;
        return run;
      }
      const cc = await getCollectorConfig({ server: t, paths: deps.paths, log, transport, now });
      if (cc.status === 401 || cc.status === 403) {
        block(run, cc.status, cc.body ?? '');
        return run;
      }
      if (cc.source === 'default') {
        fail(run, `collector-config unavailable: ${cc.error ?? 'never fetched'}`);
        return run;
      }
      if (cc.source === 'fresh') syncServerEntry(deps.paths, t, cc.value, log);
      run.cc = cc.value;
      return run;
    };

    const sameServer = (a: ServerEntry, b: ServerEntry) => a.endpoint === b.endpoint && a.token === b.token;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let replan = false;
      const view = routing();
      if (!view) break;
      for (const ref of store.streams()) {
        const identity = identityOfRef(ref);
        const r = resolveStream(view, identity);
        // C13: the age cap counts only time a stream was seen sendable (held, refused, expired time does not count)
        if (pass === 0) {
          const ok = r.kind === 'server' && !Object.prototype.hasOwnProperty.call(view.blocked, endpointHost(r.server.endpoint)) && !isExpired(r.server, now());
          store.observe(ref, ok);
        }
        if (r.kind === 'held') {
          if (!heldSeen.has(ref.dir)) {
            heldSeen.add(ref.dir);
            const events = store.stream(ref).stats().events;
            result.held.events += events;
            result.held.byReason[r.reason] = (result.held.byReason[r.reason] ?? 0) + events;
            if (ref.pk !== undefined) heldProjects.add(ref.pk);
          }
          continue;
        }
        const t = r.server;
        let run = runs.get(t.endpoint);
        if (run && !sameServer(run.entry, t)) continue; // a new login mid-flush: next flush
        run ??= await startRun(t);
        run.streams.add(ref.dir);
        if (run.done) continue;
        const stopped = await sendStream(store, ref, identity, run, { deps, view: routing, transport, log, pathSecret, maxBatches, limits: opts.limits, block, fail, sameServer, now });
        if (stopped === 'replan') replan = true;
      }
      if (!replan) break;
    }

    // per-server success bookkeeping and totals
    for (const run of runs.values()) {
      const r = run.result;
      if (r.status === 'ok') {
        const at = new Date(now()).toISOString();
        const repos = { ...delivery(run.entry).repos };
        for (const pk of run.repos) repos[pk] = at;
        saveDelivery(run.entry, {
          last_attempt_at: at,
          last_success_at: at,
          last_error: null,
          consecutive_failures: 0,
          next_attempt_at: null,
          blocked: null,
          last_result: { accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected },
          repos,
        });
      }
      result.batches += r.batches;
      result.sent += r.sent;
      result.accepted += r.accepted;
      result.duplicates += r.duplicates;
      result.rejected += r.rejected;
    }

    // 2. Housekeeping: empty stream dirs, caps (C13).
    try {
      store.prune();
      const cap = store.enforceCap();
      result.dropped = { events: cap.droppedEvents, heldEvents: cap.droppedHeldEvents };
    } catch (err) {
      log.error('sender: queue housekeeping failed', { error: errorMessage(err) });
    }
    for (const ref of store.streams()) {
      for (const run of runs.values()) if (run.streams.has(ref.dir)) run.result.left += store.stream(ref).stats().events;
    }
    for (const run of runs.values()) result.servers[run.entry.endpoint] = run.result;
    result.held.projects = [...heldProjects];

    const statuses = [...runs.values()].map((r) => r.result);
    const first = (...s: ServerFlushStatus[]) => statuses.find((r) => s.includes(r.status));
    const ok = first('ok');
    const auth = first('auth_error');
    const failed = first('failed');
    const waiting = first('backoff', 'blocked', 'expired');
    if (ok) result.status = 'ok';
    else if (auth) Object.assign(result, { status: 'auth_error', ...(auth.error ? { error: auth.error } : {}) });
    else if (failed) Object.assign(result, { status: 'failed', ...(failed.error ? { error: failed.error } : {}) });
    else if (waiting) Object.assign(result, { status: 'backoff', ...(waiting.error ? { error: waiting.error } : {}) });
    else if (result.held.events > 0) result.status = 'held';
    else result.status = 'empty';
    if (ok && (auth ?? failed)?.error) result.error = (auth ?? failed)!.error;
  } catch (err) {
    log.error('sender: flush failed', { error: errorMessage(err) });
    result.status = 'failed';
    result.error = errorMessage(err);
  }
  return result;
}

interface SendCtx {
  deps: SenderDeps;
  view: () => RoutingView | null;
  transport: Transport;
  log: Logger;
  pathSecret: string | null;
  maxBatches: number;
  limits: BatchLimits | undefined;
  block: (run: ServerRun, status: 401 | 403, body: string) => void;
  fail: (run: ServerRun, error: string, waitMs?: number | null) => void;
  sameServer: (a: ServerEntry, b: ServerEntry) => boolean;
  now: () => number;
}

/** Batch loop of one stream for one server. 'replan' = the stream's resolution changed. */
async function sendStream(store: QueueStore, ref: StreamRef, identity: StreamIdentity, run: ServerRun, c: SendCtx): Promise<'done' | 'replan'> {
  const queue = store.stream(ref);
  const t = run.entry;
  const cc = run.cc!;
  while (!run.done) {
    if (run.result.batches >= c.maxBatches) {
      run.done = true; // budget of this server for this flush (C14)
      break;
    }
    const batch = queue.readBatch({ ...c.limits, maxEvents: run.maxEvents });
    if (!batch) break;
    if (!batch.events.length) {
      queue.ack(batch); // only corrupt / oversized lines were consumed
      continue;
    }
    // C17: a removed server or a new token must take effect for every batch not yet in flight.
    const view = c.view();
    const now = view ? resolveStream(view, identity) : null;
    if (!view || now?.kind !== 'server' || !c.sameServer(now.server, t)) return 'replan';
    if (!run.retryBlocked && Object.prototype.hasOwnProperty.call(view.blocked, endpointHost(t.endpoint))) {
      // refused since this flush started (another process saw a 401 / 403): stop sending with it
      if (run.result.status !== 'ok') run.result.status = 'blocked';
      run.done = true;
      break;
    }
    if (isExpired(t, c.now())) {
      if (run.result.status !== 'ok') run.result.status = 'expired';
      run.done = true;
      break;
    }
    const events = prepareForSend(batch.events, identity, { naming: cc.project_naming, salt: cc.project_salt ?? null, pathSecret: c.pathSecret });
    const body = gzipSync(Buffer.from(JSON.stringify(buildEnvelope(view.config, events))));
    let res;
    try {
      res = await c.transport({
        method: 'POST',
        url: t.endpoint + INGEST_PATH,
        headers: {
          authorization: `Bearer ${t.token}`,
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'user-agent': `${COLLECTOR_NAME}/${COLLECTOR_VERSION}`,
        },
        body,
        timeoutMs: POST_TIMEOUT_MS,
      });
    } catch (err) {
      c.fail(run, `network: ${errorMessage(err)}`);
      break;
    }

    if (res.status === 401 || res.status === 403) {
      c.block(run, res.status, res.body);
      break;
    }
    if (res.status === 413 && batch.events.length > 1) {
      run.maxEvents = Math.max(1, Math.floor(batch.events.length / 2));
      continue;
    }
    if (res.status === 400 || res.status === 413 || res.status === 422) {
      queue.deadLetter(batch, `HTTP ${res.status}: ${res.body.slice(0, 200)}`, { server: endpointHost(t.endpoint), project: loggableKey(ref.pk) });
      run.result.batches++;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      c.fail(run, `HTTP ${res.status}`, res.status === 429 ? retryAfterMs(res.headers['retry-after']) : null);
      break;
    }

    const r = parseIngestResponse(res.body);
    for (const rej of r.rejected.slice(0, 20)) {
      c.log.warn('sender: event rejected by server', { event_id: rej.event_id, reason: String(rej.reason).slice(0, 200) });
    }
    if (identity.kind === 'project') run.repos.add(identity.pk);
    queue.ack(batch);
    run.result.batches++;
    run.result.sent += batch.events.length;
    run.result.accepted += r.accepted;
    run.result.duplicates += r.duplicates;
    run.result.rejected += r.rejected.length;
    run.result.status = 'ok';
  }
  return 'done';
}

/**
 * Copies what a fresh collector-config says about the token (e-mail, deployment, label, expiry, source) into
 * its config.json entry when it changed, so `status` and the expiry nudge know it without the network. The
 * caller holds the worker lock. Never throws.
 */
export function syncServerEntry(paths: AiObsPaths, server: ServerEntry, value: CollectorConfigResponse, log: Logger = nullLogger): ServerEntry | null {
  try {
    const config = loadConfig(paths);
    const i = config ? config.servers.findIndex((s) => s.endpoint === server.endpoint && s.token === server.token) : -1;
    if (!config || i < 0) return null;
    const cur = config.servers[i]!;
    const next: ServerEntry = {
      ...cur,
      ...(value.user ? { email: value.user.email } : {}),
      ...(value.deployment ? { deployment: value.deployment } : {}),
      ...(value.token ? { expires_at: value.token.expires_at, label: value.token.label ?? cur.label, source: value.token.source } : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(cur)) return cur;
    config.servers[i] = next;
    saveConfig(paths, config);
    return next;
  } catch (err) {
    log.error('sender: cannot update the server entry', { error: errorMessage(err) });
    return null;
  }
}

// ---------------------------------------------------------------- collector config

export const DEFAULT_CONFIG_TTL_MS = 6 * 3600_000;
const FAILED_FETCH_RETRY_MS = 10 * 60_000;

export interface CollectorConfigResult {
  value: CollectorConfigResponse;
  /** fresh = fetched now; cache = cached (fresh or stale after a failed fetch); default = never fetched */
  source: 'fresh' | 'cache' | 'default';
  fetchedAt: string | null;
  /** HTTP status of this call's fetch (none when served from the cache without a request) */
  status?: number | null;
  /** response body of a non-2xx fetch (401 / 403 message) */
  body?: string;
  error?: string;
}

/**
 * Privacy-first fallback when the server was never reached: hash project keys, so a deployment in
 * `hashed` mode never receives a plain remote. The sender never sends with it (C4).
 */
export const DEFAULT_COLLECTOR_CONFIG: CollectorConfigResponse = { project_naming: 'hashed', min_collector_version: '0.0.0' };

/** Parses a collector-config response body (appendix A); null when invalid. */
export function parseCollectorConfig(body: string): CollectorConfigResponse | null {
  try {
    return parseCollectorConfigValue(JSON.parse(body));
  } catch {
    return null;
  }
}

export interface EndpointCheck {
  reachable: boolean;
  tokenValid: boolean | null;
  status: number | null;
  value: CollectorConfigResponse | null;
  error?: string;
  /** the response's `error` field */
  serverError?: string;
  /** Retry-After of a 429, in ms */
  retryAfterMs?: number | null;
  /** raw response body (non-2xx) */
  body?: string;
}

/** GET /api/v1/collector-config with the token: reachability + token validity in one call. */
export async function checkEndpoint(deps: { endpoint: string; token: string; transport?: Transport }): Promise<EndpointCheck> {
  const transport = deps.transport ?? nodeTransport;
  try {
    const res = await transport({
      method: 'GET',
      url: deps.endpoint + COLLECTOR_CONFIG_PATH,
      headers: { authorization: `Bearer ${deps.token}`, accept: 'application/json', 'user-agent': `${COLLECTOR_NAME}/${COLLECTOR_VERSION}` },
      timeoutMs: GET_TIMEOUT_MS,
    });
    const tokenValid = res.status === 401 || res.status === 403 ? false : res.status >= 200 && res.status < 300 ? true : null;
    const value = tokenValid ? parseCollectorConfig(res.body) : null;
    const ok = !!value;
    const srvErr = ok ? null : serverError(res.body);
    return {
      reachable: true,
      tokenValid,
      status: res.status,
      value,
      ...(ok || tokenValid === false ? {} : { error: `HTTP ${res.status}` }),
      ...(srvErr ? { serverError: srvErr } : {}),
      ...(res.status === 429 ? { retryAfterMs: retryAfterMs(res.headers['retry-after']) } : {}),
      ...(ok ? {} : { body: res.body.slice(0, 2000) }),
    };
  } catch (err) {
    return { reachable: false, tokenValid: null, status: null, value: null, error: errorMessage(err) };
  }
}

const PROBE_ATTEMPTS = 3;
const PROBE_BUDGET_MS = 60_000;
const PROBE_DEFAULT_WAIT_MS = 5_000;

/**
 * checkEndpoint for `login` / `link`: on 429 wait Retry-After (default 5 s) and
 * retry, at most 3 attempts; stops at once when the wait would pass the 60 s budget. `exhausted` =
 * gave up on a 429.
 */
export async function probeCollectorConfig(
  deps: { endpoint: string; token: string; transport?: Transport; sleep?: (ms: number) => Promise<void>; now?: () => number },
  o: { attempts?: number; budgetMs?: number } = {},
): Promise<EndpointCheck & { attempts: number; exhausted: boolean }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const maxAttempts = o.attempts ?? PROBE_ATTEMPTS;
  const budget = o.budgetMs ?? PROBE_BUDGET_MS;
  const start = now();
  let attempts = 0;
  for (;;) {
    attempts++;
    const check = await checkEndpoint(deps);
    if (check.status !== 429) return { ...check, attempts, exhausted: false };
    const wait = check.retryAfterMs ?? PROBE_DEFAULT_WAIT_MS;
    if (attempts >= maxAttempts || now() - start + wait > budget) return { ...check, attempts, exhausted: true };
    await sleep(wait);
  }
}

/**
 * The server's collector config (per-server cache): from cache when younger than `maxAgeMs`, else fetched
 * (falling back to a stale cache, then the default). A failed fetch is retried after 10 min unless forced.
 */
export async function getCollectorConfig(
  deps: { server: Pick<ServerEntry, 'endpoint' | 'token'>; paths: Pick<AiObsPaths, 'collectorConfigDir'>; log?: Logger; transport?: Transport; now?: () => number },
  opts: { maxAgeMs?: number; force?: boolean } = {},
): Promise<CollectorConfigResult> {
  const now = deps.now ?? Date.now;
  const cached = readCache(deps.paths, deps.server);
  const cachedValue = cached?.value ?? null;
  const fallback = (extra: Partial<CollectorConfigResult> = {}): CollectorConfigResult =>
    cachedValue
      ? { value: cachedValue, source: 'cache', fetchedAt: cached?.fetched_at ?? null, ...extra }
      : { value: DEFAULT_COLLECTOR_CONFIG, source: 'default', fetchedAt: null, ...extra };
  const age = cached?.fetched_at ? now() - Date.parse(cached.fetched_at) : Infinity;
  if (!opts.force && cachedValue && age >= 0 && age < (opts.maxAgeMs ?? DEFAULT_CONFIG_TTL_MS)) return fallback();
  const sinceFail = cached?.failed_at ? now() - Date.parse(cached.failed_at) : Infinity;
  if (!opts.force && sinceFail >= 0 && sinceFail < FAILED_FETCH_RETRY_MS) return fallback({ error: 'last fetch failed less than 10 min ago' });

  const check = await checkEndpoint({ endpoint: deps.server.endpoint, token: deps.server.token, ...(deps.transport ? { transport: deps.transport } : {}) });
  const save = (patch: Parameters<typeof writeCache>[2]) => {
    try {
      writeCache(deps.paths, deps.server, patch);
    } catch (err) {
      deps.log?.error('sender: cannot cache collector config', { error: errorMessage(err), server: endpointHost(deps.server.endpoint) });
    }
  };
  if (check.value) {
    const fetchedAt = new Date(now()).toISOString();
    save({ fetched_at: fetchedAt, value: check.value, failed_at: undefined }); // a fresh value clears an old failure
    return { value: check.value, source: 'fresh', fetchedAt, status: check.status };
  }
  const error = check.error ?? `HTTP ${check.status}${check.serverError ? `: ${check.serverError}` : ''}`;
  deps.log?.warn('sender: collector-config fetch failed', { server: endpointHost(deps.server.endpoint), error });
  save({ failed_at: new Date(now()).toISOString() });
  return fallback({ status: check.status, error, ...(check.body !== undefined ? { body: check.body } : {}) });
}
