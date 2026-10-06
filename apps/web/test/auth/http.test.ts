import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { oauthStartGet } from '../../src/app/api/auth/[provider]/start/handlers';
import { signupPost } from '../../src/app/api/auth/signup/handlers';
import { AuthConfigError, sessionSecret, trustedProxyHops } from '../../src/lib/auth/config';
import { clientIp } from '../../src/lib/auth/http';

const req = (headers: Record<string, string>) => new NextRequest('http://localhost:3000/api/auth/magic', { headers });

describe('clientIp (SEC-8: per-IP limit must not trust client-sent X-Forwarded-For hops)', () => {
  it('takes the address our proxy appended (right-most by default), not the spoofable first hop', () => {
    // Client sent "X-Forwarded-For: 6.6.6.6"; our one proxy appended the real peer.
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }), {})).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1,2.2.2.2, 203.0.113.7' }), {})).toBe('203.0.113.7');
    // A random spoofed hop per request no longer yields a new rate-limit key.
    const keys = new Set([1, 2, 3].map((i) => clientIp(req({ 'x-forwarded-for': `10.0.0.${i}, 203.0.113.7` }), {})));
    expect([...keys]).toEqual(['203.0.113.7']);
  });

  it('honours TRUSTED_PROXY_HOPS', () => {
    const xff = { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.2' };
    expect(clientIp(req(xff), { TRUSTED_PROXY_HOPS: '2' })).toBe('203.0.113.7');
    // Fewer entries than proxies: all entries came from proxies; take the left-most.
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7' }), { TRUSTED_PROXY_HOPS: '2' })).toBe('203.0.113.7');
    // 0 = X-Forwarded-For is not trusted at all; X-Real-IP (set by the proxy) or nothing.
    expect(clientIp(req({ ...xff, 'x-real-ip': '198.51.100.9' }), { TRUSTED_PROXY_HOPS: '0' })).toBe('198.51.100.9');
    expect(clientIp(req(xff), { TRUSTED_PROXY_HOPS: '0' })).toBeNull();
  });

  it('falls back to X-Real-IP, then null', () => {
    expect(clientIp(req({ 'x-real-ip': '198.51.100.9' }), {})).toBe('198.51.100.9');
    expect(clientIp(req({}), {})).toBeNull();
  });

  it('parses TRUSTED_PROXY_HOPS defensively', () => {
    expect([undefined, '', '1', '3', '0', '-1', 'x', '2.5', '11'].map((v) => trustedProxyHops({ TRUSTED_PROXY_HOPS: v }))).toEqual([
      1, 1, 1, 3, 0, 1, 1, 1, 1,
    ]);
  });
});

describe('placeholder SESSION_SECRET in production (known issue: bare 500)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('throws a typed AuthConfigError only in production', () => {
    expect(() => sessionSecret({ NODE_ENV: 'production', SESSION_SECRET: 'change-me-to-a-long-random-string' })).toThrow(AuthConfigError);
    expect(() => sessionSecret({ NODE_ENV: 'production' })).toThrow(AuthConfigError);
    expect(sessionSecret({ NODE_ENV: 'development' })).toBe('ai-obs-insecure-dev-secret');
  });

  it('OAuth start and the sign-up POST redirect to /login?error=config and log once', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    vi.stubEnv('SESSION_SECRET', 'change-me-to-a-long-random-string');
    vi.stubEnv('GITHUB_CLIENT_ID', 'id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'secret');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const start = () => oauthStartGet(new NextRequest('http://localhost:3000/api/auth/github/start'), 'github');
    const signup = () =>
      signupPost(
        new NextRequest('http://localhost:3000/api/auth/signup', {
          method: 'POST',
          headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded', cookie: 'ai_obs_signup=x.y' },
          body: 'name=A&company=B',
        }),
        () => {
          throw new Error('deps must not be reached');
        },
      );
    for (const res of [start(), start(), await signup()]) {
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:3000/login?error=config');
      expect(res.headers.get('set-cookie') ?? '').not.toMatch(/ai_obs_oauth=[^;]/);
    }
    const configLogs = errors.mock.calls.filter((c) => String(c[0]).includes('SESSION_SECRET'));
    expect(configLogs.length).toBe(1); // logged once, not per request
    expect(errors.mock.calls.length).toBe(configLogs.length);
  });
});
