import { describe, expect, it } from 'vitest';
import { AuthGuard, TokenBucketLimiter, clientIp, rateLimitOptionsFromEnv } from '../../src/lib/ingest/rate-limit';

describe('TokenBucketLimiter', () => {
  it('allows a burst, then refills at the sustained rate', () => {
    const l = new TokenBucketLimiter({ burst: 3, perMinute: 60 }); // 1 per second
    const t0 = 1_000_000;
    expect([l.take('a', t0), l.take('a', t0), l.take('a', t0)].every((r) => r.ok)).toBe(true);
    const denied = l.take('a', t0);
    expect(denied).toEqual({ ok: false, retryAfterSec: 1 });
    expect(l.take('a', t0 + 500).ok).toBe(false);
    expect(l.take('a', t0 + 1_100).ok).toBe(true);
    expect(l.take('a', t0 + 1_100).ok).toBe(false);
  });

  it('never refills beyond the burst', () => {
    const l = new TokenBucketLimiter({ burst: 2, perMinute: 60 });
    l.take('a', 0);
    const later = 3_600_000;
    expect(l.take('a', later).ok).toBe(true);
    expect(l.take('a', later).ok).toBe(true);
    expect(l.take('a', later).ok).toBe(false);
  });

  it('keeps separate buckets per key', () => {
    const l = new TokenBucketLimiter({ burst: 1, perMinute: 1 });
    expect(l.take('a', 0).ok).toBe(true);
    expect(l.take('a', 0).ok).toBe(false);
    expect(l.take('b', 0).ok).toBe(true);
  });

  it('reports retry-after for slow refill rates', () => {
    const l = new TokenBucketLimiter({ burst: 1, perMinute: 2 }); // one per 30 s
    l.take('a', 0);
    expect(l.take('a', 0)).toEqual({ ok: false, retryAfterSec: 30 });
  });

  it('evicts least recently used keys beyond maxKeys', () => {
    const l = new TokenBucketLimiter({ burst: 1, perMinute: 1, maxKeys: 2 });
    l.take('a', 0);
    l.take('b', 0);
    l.take('a', 0); // a is now most recent
    l.take('c', 0); // evicts b
    expect(l.size).toBe(2);
    expect(l.take('b', 0).ok).toBe(true); // fresh bucket again
  });

  it('reads options from env with sane defaults', () => {
    expect(rateLimitOptionsFromEnv({})).toEqual({ perMinute: 60, burst: 20 });
    expect(rateLimitOptionsFromEnv({ INGEST_RATE_LIMIT_PER_MINUTE: '120', INGEST_RATE_LIMIT_BURST: '5' })).toEqual({
      perMinute: 120,
      burst: 5,
    });
    expect(rateLimitOptionsFromEnv({ INGEST_RATE_LIMIT_PER_MINUTE: 'x', INGEST_RATE_LIMIT_BURST: '-1' })).toEqual({
      perMinute: 60,
      burst: 20,
    });
    expect(() => new TokenBucketLimiter({ burst: 0, perMinute: 1 })).toThrow(RangeError);
  });
});

describe('TokenBucketLimiter.peek', () => {
  it('reports without consuming', () => {
    const l = new TokenBucketLimiter({ burst: 1, perMinute: 60 });
    expect(l.peek('a', 0).ok).toBe(true);
    expect(l.peek('a', 0).ok).toBe(true);
    expect(l.size).toBe(0);
    l.take('a', 0);
    expect(l.peek('a', 0)).toEqual({ ok: false, retryAfterSec: 1 });
    expect(l.peek('a', 1_000).ok).toBe(true);
  });
});

describe('AuthGuard', () => {
  const guard = () => new AuthGuard({ failures: { burst: 2, perMinute: 60 }, negativeTtlMs: 1_000, goodTtlMs: 10_000, maxKeys: 3 });

  it('answers a recently failed hash with 401 and no lookup, until the negative entry expires', () => {
    const g = guard();
    expect(g.admit('ip', 'h', 0)).toEqual({ action: 'lookup' });
    g.failed('ip', 'h', 0);
    expect(g.admit('ip2', 'h', 500)).toEqual({ action: 'reject-401' });
    expect(g.admit('ip2', 'h', 1_500)).toEqual({ action: 'lookup' });
  });

  it('blocks lookups of unseen hashes from an IP that exhausted its failure budget, but not known-good hashes or other IPs', () => {
    const g = guard();
    g.succeeded('good', 0);
    g.failed('ip', 'b1', 0);
    g.failed('ip', 'b2', 0);
    expect(g.admit('ip', 'b3', 0)).toMatchObject({ action: 'reject-429', retryAfterSec: 1 });
    expect(g.admit('ip', 'good', 0)).toEqual({ action: 'lookup' });
    expect(g.admit('other', 'b3', 0)).toEqual({ action: 'lookup' });
    expect(g.admit('ip', 'b3', 2_000)).toEqual({ action: 'lookup' }); // refilled
  });

  it('a hash that authenticates leaves the negative cache; one that fails leaves the good set', () => {
    const g = guard();
    g.failed('ip', 'h', 0);
    g.succeeded('h', 10);
    expect(g.admit('ip', 'h', 20)).toEqual({ action: 'lookup' });
    g.failed('ip', 'h', 30);
    expect(g.admit('ip', 'h', 40)).toEqual({ action: 'reject-401' });
  });

  it('is bounded: bogus hashes cannot grow it without limit', () => {
    const g = guard();
    for (let i = 0; i < 50; i++) g.failed(`ip${i}`, `h${i}`, 0);
    expect(g.admit('x', 'h0', 1)).toEqual({ action: 'lookup' }); // evicted
    expect(g.admit('x', 'h49', 1)).toEqual({ action: 'reject-401' });
  });
});

describe('clientIp', () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it('takes the hops-th entry from the right of X-Forwarded-For', () => {
    expect(clientIp(h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }))).toBe('3.3.3.3');
    expect(clientIp(h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }), 2)).toBe('2.2.2.2');
    expect(clientIp(h({ 'x-forwarded-for': '9.9.9.9' }), 5)).toBe('9.9.9.9');
  });
  it('falls back to X-Real-IP, then "unknown"', () => {
    expect(clientIp(h({ 'x-real-ip': '4.4.4.4' }))).toBe('4.4.4.4');
    expect(clientIp(h({}))).toBe('unknown');
  });
});
