import { platform } from 'node:os';
import { gzipSync } from 'node:zlib';
import { applyUsageNaming } from './analysis/usage.js';
import { readCache, renameCache, writeCache, parseCollectorConfigValue } from './cc-cache.js';
import { isTokenName, loadConfig, saveConfig, type CollectorConfig, type CompanyLabel, type TokenEntry } from './config.js';
import { readDelivery, renameTokenDelivery, tokenDelivery, writeTokenDelivery, type TokenDeliveryState } from './delivery.js';
import { errorMessage } from './fsutil.js';
import { nodeTransport, type Transport } from './http.js';
import { nullLogger, type Logger } from './log.js';
import type { AiObsPaths } from './paths.js';
import { loadPathSecret, resolveProjectKey, RESOLVE_TIMEOUT_MS, sendRef } from './project-key.js';
import { loadRouting, resolveStream, type HeldReason, type RoutingView, type StreamIdentity } from './projects.js';
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
import { COLLECTOR_NAME, COLLECTOR_VERSION } from './version.js';

export const INGEST_PATH = '/api/v1/ingest';
export const COLLECTOR_CONFIG_PATH = '/api/v1/collector-config';
const POST_TIMEOUT_MS = 15_000;
const GET_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 3600_000;
const BASE_BACKOFF_MS = 30_000;
/** Routing passes per flush: another one only when a stream's resolution changed mid-flush (C17). */
const MAX_PASSES = 3;

export interface SenderDeps {
  paths: AiObsPaths;
  log?: Logger;
  transport?: Transport;
  now?: () => number;
  /** default: () => loadRouting(paths) (fresh read per decision, C17); tests inject */
  routing?: () => RoutingView | null;
  /** key resolution for unresolved streams (default resolveProjectKey, 5 s) */
  resolveProjectKey?: (cwd: string, o: { timeoutMs: number }) => Promise<string | null>;
}

/** Per-token result of one flush. `suspended` = 403 (company suspended); `blocked` = skipped, still blocked by an earlier 401 / 403. */
export type TokenFlushStatus = 'ok' | 'empty' | 'backoff' | 'blocked' | 'auth_error' | 'suspended' | 'failed';

export interface TokenFlushResult {
  status: TokenFlushStatus;
  batches: number;
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  /** events still queued for this token after the flush */
  left: number;
  error?: string;
}

export type FlushStatus = 'ok' | 'empty' | 'backoff' | 'auth_error' | 'failed' | 'held';

export interface FlushResult {
  /** aggregate; one token and nothing held: exactly the 0.1.x values ('suspended' maps to 'auth_error') */
  status: FlushStatus;
  batches: number;
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  error?: string;
  /** per token name, for every token a stream resolved to in this flush */
  tokens: Record<string, TokenFlushResult>;
  /** streams not sent because no token can be proven for them (design §3.2) */
  held: { events: number; projects: string[]; byReason: Partial<Record<HeldReason, number>> };
  /** single-token auto-confirm (C9) */
  confirmed?: { from: string; to: string; company: CompanyLabel };
  /** this run's cap drops (C13) */
  dropped: { events: number; heldEvents: number };
}

export interface FlushOptions {
  /** ignore the backoff window and retry blocked tokens once (manual `ai-obs flush`) */
  force?: boolean;
  /** safety stop per token (default 50 batches per flush, C14) */
  maxBatches?: number;
  limits?: BatchLimits;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The batch envelope for one token: `identity.git_email` is the e-mail registered with that token (the
 * git e-mail of the directory `init --token` ran in), else the machine's first one (config.git_email).
 */
export function buildEnvelope(config: Pick<CollectorConfig, 'machine_id' | 'git_email'>, events: IngestEvent[], token?: Pick<TokenEntry, 'git_email'>): IngestBatch {
  const raw = token?.git_email ?? config.git_email;
  const email = raw && EMAIL_RE.test(raw) && raw.length <= 320 ? raw : undefined;
  return {
    schema: SCHEMA_VERSION,
    collector: { name: COLLECTOR_NAME, version: COLLECTOR_VERSION },
    machine: { id: config.machine_id, os: platform().slice(0, 32) },
    identity: email ? { git_email: email } : {},
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

/** The `error` field of a JSON error body (e.g. "company is suspended"), clipped; null when absent. */
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
 * Send-time naming (design §3.5, C3): a project stream's `session_start.project` is rebuilt from the
 * plain stream key for the receiving token (path keys always as a keyed hash); skill / MCP names are
 * hashed in hashed mode. Event ids do not depend on either, so server de-dup is unaffected.
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

interface TokenRun {
  entry: TokenEntry;
  result: TokenFlushResult;
  /** no more requests for this token in this flush (failed, blocked, backoff, budget used) */
  done: boolean;
  cc: CollectorConfigResponse | null;
  maxEvents: number;
  streams: Set<string>;
  /** a forced flush retrying a blocked token (its blocked flag is cleared only on success) */
  retryBlocked: boolean;
}

/**
 * Sends every stream to the token it resolves to (design §5.3): per token Bearer, endpoint, naming and
 * salt; held streams stay queued and are counted; a 401 / 403 blocks only that token; failures back
 * off per token and the flush goes on with the others. Routing is re-read before every POST (C17).
 * Server-side duplicates count as delivered (ADR-0011). Never throws.
 */
export async function flushQueue(store: QueueStore, deps: SenderDeps, opts: FlushOptions = {}): Promise<FlushResult> {
  const log = deps.log ?? nullLogger;
  const now = deps.now ?? Date.now;
  const transport = deps.transport ?? nodeTransport;
  const routing = deps.routing ?? (() => loadRouting(deps.paths));
  const resolveKey = deps.resolveProjectKey ?? ((cwd, o) => resolveProjectKey(cwd, o));
  const maxBatches = opts.maxBatches ?? 50;
  const result: FlushResult = {
    status: 'empty',
    batches: 0,
    sent: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    tokens: {},
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

    // 0b. Single-token auto-confirm (C9).
    const confirmed = await autoConfirm(deps, routing, log, transport, now);
    if (confirmed) result.confirmed = confirmed;

    const pathSecret = loadPathSecret(deps.paths.projectSecret);
    const runs = new Map<string, TokenRun>();
    const heldSeen = new Set<string>();
    const heldProjects = new Set<string>();

    const delivery = (t: TokenEntry): TokenDeliveryState => tokenDelivery(readDelivery(deps.paths), t);
    const saveDelivery = (t: TokenEntry, patch: Partial<Omit<TokenDeliveryState, 'token_fp'>>) => {
      try {
        writeTokenDelivery(deps.paths, t, patch);
      } catch (err) {
        log.error('sender: cannot write delivery state', { error: errorMessage(err), token: t.name });
      }
    };
    const fail = (run: TokenRun, status: 'failed', error: string, waitMs?: number | null) => {
      const failures = delivery(run.entry).consecutive_failures + 1;
      const backoff = waitMs ?? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
      saveDelivery(run.entry, {
        last_attempt_at: new Date(now()).toISOString(),
        last_error: error,
        consecutive_failures: failures,
        next_attempt_at: new Date(now() + backoff).toISOString(),
      });
      run.result.status = status;
      run.result.error = error;
      run.done = true;
      log.warn('sender: delivery failed, events stay queued', { token: run.entry.name, error, failures });
    };
    const block = (run: TokenRun, status: 401 | 403, body: string) => {
      const message = serverError(body) ?? (status === 403 ? 'company is suspended' : 'token rejected');
      const error = `HTTP ${status}: ${message}`;
      saveDelivery(run.entry, {
        last_attempt_at: new Date(now()).toISOString(),
        last_error: error,
        blocked: { status, at: new Date(now()).toISOString(), message },
      });
      run.result.status = status === 403 ? 'suspended' : 'auth_error';
      run.result.error = error;
      run.done = true;
      log.warn('sender: token refused by the server, its events stay queued', { token: run.entry.name, status });
    };

    /** First sight of a token in this flush: blocked / backoff / collector-config (C4). */
    const startRun = async (t: TokenEntry): Promise<TokenRun> => {
      const run: TokenRun = {
        entry: t,
        result: { status: 'empty', batches: 0, sent: 0, accepted: 0, duplicates: 0, rejected: 0, left: 0 },
        done: false,
        cc: null,
        maxEvents: opts.limits?.maxEvents ?? MAX_BATCH_EVENTS,
        streams: new Set(),
        retryBlocked: false,
      };
      runs.set(t.name, run);
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
      const cc = await getCollectorConfig({ token: t, paths: deps.paths, log, transport, now });
      if (cc.status === 401 || cc.status === 403) {
        block(run, cc.status, cc.body ?? '');
        return run;
      }
      if (cc.source === 'default') {
        fail(run, 'failed', `collector-config unavailable: ${cc.error ?? 'never fetched'}`);
        return run;
      }
      run.cc = cc.value;
      return run;
    };

    const sameToken = (a: TokenEntry, b: TokenEntry) => a.name === b.name && a.token === b.token && a.endpoint === b.endpoint;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let replan = false;
      const view = routing();
      if (!view) break;
      for (const ref of store.streams()) {
        const identity = identityOfRef(ref);
        const r = resolveStream(view, identity);
        // C13: the age cap counts only time a stream was seen sendable (held / blocked time does not count)
        if (pass === 0) store.observe(ref, r.kind === 'token' && !Object.prototype.hasOwnProperty.call(view.blocked, r.token.name));
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
        const t = r.token;
        let run = runs.get(t.name);
        if (run && !sameToken(run.entry, t)) continue; // the token was replaced mid-flush: next flush
        run ??= await startRun(t);
        run.streams.add(ref.dir);
        if (run.done) continue;
        const stopped = await sendStream(store, ref, identity, run, {
          deps,
          view: routing,
          transport,
          log,
          pathSecret,
          maxBatches,
          limits: opts.limits,
          block,
          fail,
          sameToken,
        });
        if (stopped === 'replan') replan = true;
      }
      if (!replan) break;
    }

    // per-token success bookkeeping and totals
    for (const run of runs.values()) {
      const r = run.result;
      if (r.status === 'ok') {
        saveDelivery(run.entry, {
          last_attempt_at: new Date(now()).toISOString(),
          last_success_at: new Date(now()).toISOString(),
          last_error: null,
          consecutive_failures: 0,
          next_attempt_at: null,
          blocked: null,
          last_result: { accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected },
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
    for (const run of runs.values()) result.tokens[run.entry.name] = run.result;
    result.held.projects = [...heldProjects];

    const statuses = [...runs.values()].map((r) => r.result);
    const first = (...s: TokenFlushStatus[]) => statuses.find((r) => s.includes(r.status));
    const ok = first('ok');
    const auth = first('auth_error', 'suspended');
    const failed = first('failed');
    const waiting = first('backoff', 'blocked');
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
  block: (run: TokenRun, status: 401 | 403, body: string) => void;
  fail: (run: TokenRun, status: 'failed', error: string, waitMs?: number | null) => void;
  sameToken: (a: TokenEntry, b: TokenEntry) => boolean;
}

/** Batch loop of one stream for one token (design §5.3 step 1b). 'replan' = the stream's resolution changed. */
async function sendStream(store: QueueStore, ref: StreamRef, identity: StreamIdentity, run: TokenRun, c: SendCtx): Promise<'done' | 'replan'> {
  const queue = store.stream(ref);
  const t = run.entry;
  const cc = run.cc!;
  while (!run.done) {
    if (run.result.batches >= c.maxBatches) {
      run.done = true; // budget of this token for this flush (C14)
      break;
    }
    const batch = queue.readBatch({ ...c.limits, maxEvents: run.maxEvents });
    if (!batch) break;
    if (!batch.events.length) {
      queue.ack(batch); // only corrupt / oversized lines were consumed
      continue;
    }
    // C17: `use --none`, a removed or blocked token must take effect for every batch not yet in flight.
    const view = c.view();
    const now = view ? resolveStream(view, identity) : null;
    if (!view || now?.kind !== 'token' || !c.sameToken(now.token, t)) return 'replan';
    if (!run.retryBlocked && Object.prototype.hasOwnProperty.call(view.blocked, t.name)) {
      // blocked since this flush started (another process saw a 401 / 403): stop sending with it
      if (run.result.status !== 'ok') run.result.status = 'blocked';
      run.done = true;
      break;
    }
    const config = view.config;
    const events = prepareForSend(batch.events, identity, { naming: cc.project_naming, salt: cc.project_salt ?? null, pathSecret: c.pathSecret });
    const body = gzipSync(Buffer.from(JSON.stringify(buildEnvelope(config, events, now.token))));
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
      c.fail(run, 'failed', `network: ${errorMessage(err)}`);
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
      queue.deadLetter(batch, `HTTP ${res.status}: ${res.body.slice(0, 200)}`, { token: t.name, project: loggableKey(ref.pk) });
      run.result.batches++;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      c.fail(run, 'failed', `HTTP ${res.status}`, res.status === 429 ? retryAfterMs(res.headers['retry-after']) : null);
      break;
    }

    const r = parseIngestResponse(res.body);
    for (const rej of r.rejected.slice(0, 20)) {
      c.log.warn('sender: event rejected by server', { event_id: rej.event_id, reason: String(rej.reason).slice(0, 200) });
    }
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
 * C9: with exactly one valid token (no malformed entry) and no company stored, a 2xx collector-config
 * that reports a company confirms it: `company` / `email` are written, and a provisional `default` is
 * renamed to the slug when that is a valid name (cache and delivery state follow). Bindings match by
 * fingerprint, so nothing else changes. The caller holds the worker lock.
 */
async function autoConfirm(
  deps: SenderDeps,
  routing: () => RoutingView | null,
  log: Logger,
  transport: Transport,
  now: () => number,
): Promise<FlushResult['confirmed'] | undefined> {
  const view = routing();
  const only = view?.config.tokens[0];
  if (!view || view.config.tokens.length !== 1 || view.config.invalidTokens.length || !only || only.company) return undefined;
  const cc = await getCollectorConfig({ token: only, paths: deps.paths, log, transport, now });
  const company = cc.source !== 'default' ? cc.value.company : undefined;
  if (!company) return undefined;
  try {
    const config = loadConfig(deps.paths);
    const i = config ? config.tokens.findIndex((t) => t.token === only.token && t.endpoint === only.endpoint) : -1;
    if (!config || i < 0 || config.tokens.length !== 1 || config.invalidTokens.length) return undefined;
    const entry = config.tokens[i]!;
    if (entry.company) return undefined;
    const rename = entry.provisional_name === true && isTokenName(company.slug) && company.slug !== entry.name;
    const email = cc.value.user?.email;
    const { provisional_name: _p, ...rest } = entry;
    const next: TokenEntry = { ...rest, name: rename ? company.slug : entry.name, company, ...(email ? { email } : {}) };
    config.tokens[i] = next;
    saveConfig(deps.paths, config, new Date(now()));
    if (rename) {
      renameCache(deps.paths, entry.name, next.name);
      renameTokenDelivery(deps.paths, entry.name, next.name);
    }
    log.info('sender: token confirmed by the server', { token: next.name, company: company.slug });
    return { from: entry.name, to: next.name, company };
  } catch (err) {
    log.error('sender: cannot confirm the token', { error: errorMessage(err) });
    return undefined;
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
 * Privacy-first fallback when the server was never reached: hash project keys, so a company in
 * `hashed` mode never receives a plain remote. The sender never sends with it (C4).
 */
export const DEFAULT_COLLECTOR_CONFIG: CollectorConfigResponse = { project_naming: 'hashed', min_collector_version: '0.0.0' };

/** Parses a collector-config response body (keeps `project_salt`, `company`, `user`); null when invalid. */
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
  /** the response's `error` field (e.g. "company is suspended") */
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
 * checkEndpoint for `init` / `token add` (contract §5.5): on 429 wait Retry-After (default 5 s) and
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
 * The token's collector config (per-token cache, design §3.4): from cache when younger than
 * `maxAgeMs`, else fetched (falling back to a stale cache, then the default). A failed fetch is
 * retried after 10 min unless forced.
 */
export async function getCollectorConfig(
  deps: { token: TokenEntry; paths: Pick<AiObsPaths, 'collectorConfigDir'>; log?: Logger; transport?: Transport; now?: () => number },
  opts: { maxAgeMs?: number; force?: boolean } = {},
): Promise<CollectorConfigResult> {
  const now = deps.now ?? Date.now;
  const cached = readCache(deps.paths, deps.token);
  const cachedValue = cached?.value ?? null;
  const fallback = (extra: Partial<CollectorConfigResult> = {}): CollectorConfigResult =>
    cachedValue
      ? { value: cachedValue, source: 'cache', fetchedAt: cached?.fetched_at ?? null, ...extra }
      : { value: DEFAULT_COLLECTOR_CONFIG, source: 'default', fetchedAt: null, ...extra };
  const age = cached?.fetched_at ? now() - Date.parse(cached.fetched_at) : Infinity;
  if (!opts.force && cachedValue && age >= 0 && age < (opts.maxAgeMs ?? DEFAULT_CONFIG_TTL_MS)) return fallback();
  const sinceFail = cached?.failed_at ? now() - Date.parse(cached.failed_at) : Infinity;
  if (!opts.force && sinceFail >= 0 && sinceFail < FAILED_FETCH_RETRY_MS) return fallback({ error: 'last fetch failed less than 10 min ago' });

  const check = await checkEndpoint({ endpoint: deps.token.endpoint, token: deps.token.token, ...(deps.transport ? { transport: deps.transport } : {}) });
  const save = (patch: Parameters<typeof writeCache>[2]) => {
    try {
      writeCache(deps.paths, deps.token, patch);
    } catch (err) {
      deps.log?.error('sender: cannot cache collector config', { error: errorMessage(err), token: deps.token.name });
    }
  };
  if (check.value) {
    const fetchedAt = new Date(now()).toISOString();
    save({ fetched_at: fetchedAt, value: check.value, failed_at: undefined }); // a fresh value clears an old failure
    return { value: check.value, source: 'fresh', fetchedAt, status: check.status };
  }
  const error = check.error ?? `HTTP ${check.status}${check.serverError ? `: ${check.serverError}` : ''}`;
  deps.log?.warn('sender: collector-config fetch failed', { token: deps.token.name, error });
  save({ failed_at: new Date(now()).toISOString() });
  return fallback({ status: check.status, error, ...(check.body !== undefined ? { body: check.body } : {}) });
}
