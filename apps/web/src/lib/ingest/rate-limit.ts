/**
 * Rate limits for the ingest API, all in memory and PER INSTANCE (every web replica keeps its own
 * state, so the effective limit is `replicas × limit`). Good enough to stop a runaway collector and
 * to blunt token guessing; not a billing control.
 *
 *  - TokenBucketLimiter, keyed by `token_id` AFTER a successful lookup, limits a valid token.
 *  - AuthGuard limits what happens BEFORE the lookup: a per-client-IP budget for failed
 *    authentications and a short negative cache of bad token hashes, so random bearers neither
 *    cost a DB lookup each nor push real tokens' buckets out of the limiter (SEC-9).
 */
export interface RateLimitOptions {
  /** Bucket size: requests allowed in a burst. */
  burst: number;
  /** Sustained requests per minute (refill rate). */
  perMinute: number;
  /** Upper bound on tracked keys; the least recently used key is evicted beyond it. */
  maxKeys?: number;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;
  private readonly maxKeys: number;

  constructor(private readonly opts: RateLimitOptions) {
    if (!(opts.burst >= 1) || !(opts.perMinute > 0)) throw new RangeError('burst must be >= 1 and perMinute > 0');
    this.refillPerMs = opts.perMinute / 60_000;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  /** Takes one request from `key`'s bucket. */
  take(key: string, nowMs: number = Date.now()): RateLimitResult {
    const prev = this.buckets.get(key);
    const tokens = prev
      ? Math.min(this.opts.burst, prev.tokens + Math.max(0, nowMs - prev.updatedMs) * this.refillPerMs)
      : this.opts.burst;
    // Re-insert so Map iteration order is least-recently-used first.
    this.buckets.delete(key);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedMs: nowMs });
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / this.refillPerMs / 1000)) };
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedMs: nowMs });
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return { ok: true };
  }

  /** Would `take(key)` succeed? Changes nothing. */
  peek(key: string, nowMs: number = Date.now()): RateLimitResult {
    const prev = this.buckets.get(key);
    const tokens = prev
      ? Math.min(this.opts.burst, prev.tokens + Math.max(0, nowMs - prev.updatedMs) * this.refillPerMs)
      : this.opts.burst;
    return tokens >= 1 ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / this.refillPerMs / 1000)) };
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** A bounded set whose members expire after `ttlMs`; the oldest member is evicted beyond `maxKeys`. */
class ExpiringSet {
  private readonly members = new Map<string, number>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys: number,
  ) {}

  has(key: string, nowMs: number): boolean {
    const expires = this.members.get(key);
    if (expires === undefined) return false;
    if (expires <= nowMs) {
      this.members.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, nowMs: number): void {
    this.members.delete(key);
    this.members.set(key, nowMs + this.ttlMs);
    while (this.members.size > this.maxKeys) {
      const oldest = this.members.keys().next().value;
      if (oldest === undefined) break;
      this.members.delete(oldest);
    }
  }

  delete(key: string): void {
    this.members.delete(key);
  }
}

export interface AuthGuardOptions {
  /** Failed authentications one client IP may burst, and sustain per minute. */
  failures: RateLimitOptions;
  /** How long a token hash that failed lookup is answered 401 without a DB call. */
  negativeTtlMs?: number;
  /** How long a hash that authenticated stays exempt from the IP block (NAT: one bad client must not lock out a good one). */
  goodTtlMs?: number;
  maxKeys?: number;
}

export type AdmitResult = { action: 'lookup' } | { action: 'reject-401' } | { action: 'reject-429'; retryAfterSec: number };

/**
 * Pre-lookup defence against invalid bearers. A request is admitted to the DB lookup unless
 *  - its hash failed recently (negative cache) → 401 without a lookup, or
 *  - its client IP used up its failed-authentication budget and the hash was not seen valid recently → 429.
 * Valid tokens never spend the IP budget, so a busy office behind one IP is not throttled by itself.
 */
export class AuthGuard {
  private readonly failures: TokenBucketLimiter;
  private readonly bad: ExpiringSet;
  private readonly good: ExpiringSet;

  constructor(opts: AuthGuardOptions) {
    const maxKeys = opts.maxKeys ?? 10_000;
    this.failures = new TokenBucketLimiter({ ...opts.failures, maxKeys });
    this.bad = new ExpiringSet(opts.negativeTtlMs ?? 30_000, maxKeys);
    this.good = new ExpiringSet(opts.goodTtlMs ?? 300_000, maxKeys);
  }

  admit(ip: string, hash: string, nowMs: number = Date.now()): AdmitResult {
    if (this.bad.has(hash, nowMs)) {
      this.failures.take(ip, nowMs);
      return { action: 'reject-401' };
    }
    if (!this.good.has(hash, nowMs)) {
      const budget = this.failures.peek(ip, nowMs);
      if (!budget.ok) return { action: 'reject-429', retryAfterSec: budget.retryAfterSec };
    }
    return { action: 'lookup' };
  }

  failed(ip: string, hash: string, nowMs: number = Date.now()): void {
    this.failures.take(ip, nowMs);
    this.good.delete(hash);
    this.bad.add(hash, nowMs);
  }

  succeeded(hash: string, nowMs: number = Date.now()): void {
    this.bad.delete(hash);
    this.good.add(hash, nowMs);
  }
}

/**
 * The client address for the failed-auth budget. Behind `hops` trusted reverse proxies the address the
 * nearest proxy appended is the `hops`-th entry from the right of X-Forwarded-For (a client can only
 * add entries to the left). Without the header (no proxy) all callers share the key "unknown", which
 * only ever limits failed authentications.
 */
export function clientIp(headers: Headers, hops = 1): string {
  const forwarded = headers.get('x-forwarded-for');
  if (!forwarded) return headers.get('x-real-ip')?.trim() || 'unknown';
  const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
  return parts[Math.max(0, parts.length - Math.max(1, hops))] ?? 'unknown';
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** INGEST_RATE_LIMIT_PER_MINUTE (default 60) and INGEST_RATE_LIMIT_BURST (default 20). */
export function rateLimitOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitOptions {
  return {
    perMinute: positiveNumber(env.INGEST_RATE_LIMIT_PER_MINUTE, 60),
    burst: Math.max(1, Math.floor(positiveNumber(env.INGEST_RATE_LIMIT_BURST, 20))),
  };
}

/** INGEST_FAILED_AUTH_PER_MINUTE (default 10) and INGEST_FAILED_AUTH_BURST (default 20) per client IP. */
export function authGuardOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AuthGuardOptions {
  return {
    failures: {
      perMinute: positiveNumber(env.INGEST_FAILED_AUTH_PER_MINUTE, 10),
      burst: Math.max(1, Math.floor(positiveNumber(env.INGEST_FAILED_AUTH_BURST, 20))),
    },
  };
}

/** INGEST_TRUSTED_PROXY_HOPS (default 1): reverse proxies in front of the app that append to X-Forwarded-For. */
export function trustedProxyHopsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Math.floor(positiveNumber(env.INGEST_TRUSTED_PROXY_HOPS, 1)));
}

let shared: TokenBucketLimiter | undefined;
let sharedGuard: AuthGuard | undefined;

/** Process-wide pre-lookup guard used by the route handlers. */
export function ingestAuthGuard(): AuthGuard {
  sharedGuard ??= new AuthGuard(authGuardOptionsFromEnv());
  return sharedGuard;
}

/** Process-wide limiter used by the route handlers. */
export function ingestRateLimiter(): TokenBucketLimiter {
  shared ??= new TokenBucketLimiter(rateLimitOptionsFromEnv());
  return shared;
}
