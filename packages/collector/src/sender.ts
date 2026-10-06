import { platform } from 'node:os';
import { gzipSync } from 'node:zlib';
import type { CollectorConfig } from './config.js';
import { errorMessage, readJsonFile, writeJsonAtomic } from './fsutil.js';
import { nodeTransport, type Transport } from './http.js';
import { nullLogger, type Logger } from './log.js';
import type { AiObsPaths } from './paths.js';
import {
  MAX_BATCH_EVENTS,
  SCHEMA_VERSION,
  type CollectorConfigResponse,
  type IngestBatch,
  type IngestEvent,
  type IngestResponse,
} from './protocol-types.js';
import type { BatchLimits, EventQueue } from './queue.js';
import { COLLECTOR_NAME, COLLECTOR_VERSION } from './version.js';

export const INGEST_PATH = '/api/v1/ingest';
export const COLLECTOR_CONFIG_PATH = '/api/v1/collector-config';
const POST_TIMEOUT_MS = 15_000;
const GET_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 3600_000;
const BASE_BACKOFF_MS = 30_000;

export interface SenderDeps {
  config: CollectorConfig;
  paths: Pick<AiObsPaths, 'delivery' | 'collectorConfigCache'>;
  log?: Logger;
  transport?: Transport;
  now?: () => number;
}

/** Persisted in state/delivery.json; read by `status` and `doctor`. */
export interface DeliveryState {
  last_attempt_at?: string;
  last_success_at?: string;
  last_error?: string | null;
  consecutive_failures: number;
  /** automatic flushes (hooks) wait until this time after failures; `ai-obs flush` ignores it */
  next_attempt_at?: string | null;
  last_result?: { accepted: number; duplicates: number; rejected: number };
}

export type FlushStatus = 'ok' | 'empty' | 'backoff' | 'auth_error' | 'failed';

export interface FlushResult {
  status: FlushStatus;
  batches: number;
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  error?: string;
}

export interface FlushOptions {
  /** ignore the backoff window (manual `ai-obs flush`) */
  force?: boolean;
  /** safety stop (default 50 batches per flush) */
  maxBatches?: number;
  limits?: BatchLimits;
}

export function readDeliveryState(paths: Pick<AiObsPaths, 'delivery'>): DeliveryState {
  return readJsonFile<DeliveryState>(paths.delivery) ?? { consecutive_failures: 0 };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildEnvelope(config: CollectorConfig, events: IngestEvent[]): IngestBatch {
  const email = config.git_email && EMAIL_RE.test(config.git_email) && config.git_email.length <= 320 ? config.git_email : undefined;
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

function retryAfterMs(header: string | string[] | undefined): number | null {
  const v = Array.isArray(header) ? header[0] : header;
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * Sends the queue in batches (≤ 500 events / 1 MB, gzip JSON, Bearer token). Delivered batches are
 * acked; on network / 5xx / 429 / auth errors everything stays queued and a backoff is recorded.
 * Server-side duplicates count as delivered (ADR-0011). Never throws.
 */
export async function flushQueue(queue: EventQueue, deps: SenderDeps, opts: FlushOptions = {}): Promise<FlushResult> {
  const log = deps.log ?? nullLogger;
  const now = deps.now ?? Date.now;
  const transport = deps.transport ?? nodeTransport;
  const state = readDeliveryState(deps.paths);
  const result: FlushResult = { status: 'empty', batches: 0, sent: 0, accepted: 0, duplicates: 0, rejected: 0 };

  if (!opts.force && state.next_attempt_at && Date.parse(state.next_attempt_at) > now()) {
    return { ...result, status: 'backoff' };
  }

  let maxEvents = opts.limits?.maxEvents ?? MAX_BATCH_EVENTS;
  const maxBatches = opts.maxBatches ?? 50;
  const save = (patch: Partial<DeliveryState>) => {
    try {
      writeJsonAtomic(deps.paths.delivery, { ...state, ...patch });
      Object.assign(state, patch);
    } catch (err) {
      log.error('sender: cannot write delivery state', { error: errorMessage(err) });
    }
  };
  const fail = (status: 'failed' | 'auth_error', error: string, waitMs?: number | null) => {
    const failures = state.consecutive_failures + 1;
    const backoff = waitMs ?? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
    save({
      last_attempt_at: new Date(now()).toISOString(),
      last_error: error,
      consecutive_failures: failures,
      next_attempt_at: new Date(now() + backoff).toISOString(),
    });
    log.warn('sender: delivery failed, events stay queued', { error, failures });
    return { ...result, status, error };
  };

  while (result.batches < maxBatches) {
    const batch = queue.readBatch({ ...opts.limits, maxEvents });
    if (!batch) break;
    if (!batch.events.length) {
      queue.ack(batch); // only corrupt / oversized lines were consumed
      continue;
    }
    const body = gzipSync(Buffer.from(JSON.stringify(buildEnvelope(deps.config, batch.events))));
    let res;
    try {
      res = await transport({
        method: 'POST',
        url: deps.config.endpoint + INGEST_PATH,
        headers: {
          authorization: `Bearer ${deps.config.token}`,
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'user-agent': `${COLLECTOR_NAME}/${COLLECTOR_VERSION}`,
        },
        body,
        timeoutMs: POST_TIMEOUT_MS,
      });
    } catch (err) {
      return fail('failed', `network: ${errorMessage(err)}`);
    }

    if (res.status === 401 || res.status === 403) return fail('auth_error', `HTTP ${res.status}: token rejected`);
    if (res.status === 413 && batch.events.length > 1) {
      maxEvents = Math.max(1, Math.floor(batch.events.length / 2));
      continue;
    }
    if (res.status === 400 || res.status === 413 || res.status === 422) {
      queue.deadLetter(batch, `HTTP ${res.status}: ${res.body.slice(0, 200)}`);
      result.batches++;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      return fail('failed', `HTTP ${res.status}`, res.status === 429 ? retryAfterMs(res.headers['retry-after']) : null);
    }

    const r = parseIngestResponse(res.body);
    for (const rej of r.rejected.slice(0, 20)) {
      log.warn('sender: event rejected by server', { event_id: rej.event_id, reason: String(rej.reason).slice(0, 200) });
    }
    queue.ack(batch);
    result.batches++;
    result.sent += batch.events.length;
    result.accepted += r.accepted;
    result.duplicates += r.duplicates;
    result.rejected += r.rejected.length;
    result.status = 'ok';
  }

  if (result.batches) {
    save({
      last_attempt_at: new Date(now()).toISOString(),
      last_success_at: new Date(now()).toISOString(),
      last_error: null,
      consecutive_failures: 0,
      next_attempt_at: null,
      last_result: { accepted: result.accepted, duplicates: result.duplicates, rejected: result.rejected },
    });
  }
  return result;
}

// ---------------------------------------------------------------- collector config

export const DEFAULT_CONFIG_TTL_MS = 6 * 3600_000;

interface CachedCollectorConfig {
  fetched_at?: string;
  value?: CollectorConfigResponse;
  /** last failed fetch; further fetches wait FAILED_FETCH_RETRY_MS (unless forced) */
  failed_at?: string;
}

const FAILED_FETCH_RETRY_MS = 10 * 60_000;

export interface CollectorConfigResult {
  value: CollectorConfigResponse;
  /** fresh = fetched now; cache = cached (fresh or stale after a failed fetch); default = never fetched */
  source: 'fresh' | 'cache' | 'default';
  fetchedAt: string | null;
}

/**
 * Privacy-first fallback when the server was never reached: hash project keys, so a company in
 * `hashed` mode never receives a plain remote.
 */
export const DEFAULT_COLLECTOR_CONFIG: CollectorConfigResponse = { project_naming: 'hashed', min_collector_version: '0.0.0' };

function parseCollectorConfig(body: string): CollectorConfigResponse | null {
  try {
    const r = JSON.parse(body) as Partial<CollectorConfigResponse>;
    if (r.project_naming !== 'plain' && r.project_naming !== 'hashed') return null;
    const salt = typeof r.project_salt === 'string' && r.project_salt.length >= 16 && r.project_salt.length <= 256 ? r.project_salt : null;
    return {
      project_naming: r.project_naming,
      min_collector_version: String(r.min_collector_version ?? '0.0.0'),
      ...(salt ? { project_salt: salt } : {}),
    };
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
}

/** GET /api/v1/collector-config with the token: reachability + token validity in one call. */
export async function checkEndpoint(deps: Pick<SenderDeps, 'config' | 'transport'>): Promise<EndpointCheck> {
  const transport = deps.transport ?? nodeTransport;
  try {
    const res = await transport({
      method: 'GET',
      url: deps.config.endpoint + COLLECTOR_CONFIG_PATH,
      headers: { authorization: `Bearer ${deps.config.token}`, accept: 'application/json', 'user-agent': `${COLLECTOR_NAME}/${COLLECTOR_VERSION}` },
      timeoutMs: GET_TIMEOUT_MS,
    });
    const tokenValid = res.status === 401 || res.status === 403 ? false : res.status >= 200 && res.status < 300 ? true : null;
    const value = tokenValid ? parseCollectorConfig(res.body) : null;
    return { reachable: true, tokenValid, status: res.status, value, ...(value || tokenValid === false ? {} : { error: `HTTP ${res.status}` }) };
  } catch (err) {
    return { reachable: false, tokenValid: null, status: null, value: null, error: errorMessage(err) };
  }
}

/** Collector config from cache when younger than `maxAgeMs`, else fetched (falling back to stale cache, then default). */
export async function getCollectorConfig(
  deps: SenderDeps,
  opts: { maxAgeMs?: number; force?: boolean } = {},
): Promise<CollectorConfigResult> {
  const now = deps.now ?? Date.now;
  const cached = readJsonFile<CachedCollectorConfig>(deps.paths.collectorConfigCache) ?? {};
  const cachedValue = cached.value ? parseCollectorConfig(JSON.stringify(cached.value)) : null;
  const fallback = (): CollectorConfigResult =>
    cachedValue
      ? { value: cachedValue, source: 'cache', fetchedAt: cached.fetched_at ?? null }
      : { value: DEFAULT_COLLECTOR_CONFIG, source: 'default', fetchedAt: null };
  const age = cached.fetched_at ? now() - Date.parse(cached.fetched_at) : Infinity;
  if (!opts.force && cachedValue && age >= 0 && age < (opts.maxAgeMs ?? DEFAULT_CONFIG_TTL_MS)) return fallback();
  const sinceFail = cached.failed_at ? now() - Date.parse(cached.failed_at) : Infinity;
  if (!opts.force && sinceFail >= 0 && sinceFail < FAILED_FETCH_RETRY_MS) return fallback();

  const check = await checkEndpoint(deps);
  const save = (c: CachedCollectorConfig) => {
    try {
      writeJsonAtomic(deps.paths.collectorConfigCache, c);
    } catch (err) {
      deps.log?.error('sender: cannot cache collector config', { error: errorMessage(err) });
    }
  };
  if (check.value) {
    const fetchedAt = new Date(now()).toISOString();
    save({ fetched_at: fetchedAt, value: check.value });
    return { value: check.value, source: 'fresh', fetchedAt };
  }
  deps.log?.warn('sender: collector-config fetch failed', { error: check.error ?? `HTTP ${check.status}` });
  save({ ...cached, failed_at: new Date(now()).toISOString() });
  return fallback();
}
