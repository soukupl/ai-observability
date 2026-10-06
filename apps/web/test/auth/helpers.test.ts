import { describe, expect, it } from 'vitest';
import { appUrl, enabledOAuthProviders, isSecure, superAdminEmails } from '../../src/lib/auth/config';
import { expiredCookieOptions, sessionCookieOptions } from '../../src/lib/auth/cookies';
import { isSameOriginRequest } from '../../src/lib/auth/origin';
import { RateLimiter } from '../../src/lib/auth/rate-limit';
import { isPublicPath } from '../../src/lib/auth/routes';
import { hashToken, isWellFormedToken, newToken, normalizeEmail, safeNext, signPayload, verifyPayload } from '../../src/lib/auth/tokens';

describe('tokens', () => {
  it('creates 256-bit url-safe tokens and stores only a sha256 hash', () => {
    const t = newToken();
    expect(isWellFormedToken(t)).toBe(true);
    expect(newToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
    expect(isWellFormedToken('short')).toBe(false);
    expect(isWellFormedToken(`${t.slice(0, 42)}/`)).toBe(false);
  });

  it('normalizes e-mails', () => {
    expect(normalizeEmail('  Alice@Acme.Example ')).toBe('alice@acme.example');
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it('signs payloads with expiry and rejects tampering', () => {
    const v = signPayload({ email: 'a@b.example' }, 'secret-1234567890', 1000, 0);
    expect(verifyPayload<{ email: string }>(v, 'secret-1234567890', 999)?.email).toBe('a@b.example');
    expect(verifyPayload(v, 'secret-1234567890', 1000)).toBeNull();
    expect(verifyPayload(v, 'other-secret-12345', 1)).toBeNull();
    const [body, sig] = v.split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'evil@x.example', exp: 10 })).toString('base64url');
    expect(verifyPayload(`${forged}.${sig}`, 'secret-1234567890', 1)).toBeNull();
    expect(verifyPayload(`${body}.${sig}.x`, 'secret-1234567890', 1)).toBeNull();
    expect(verifyPayload(undefined, 'secret-1234567890')).toBeNull();
  });

  it('safeNext allows only same-site relative paths', () => {
    expect(safeNext('/turns?team=1#x')).toBe('/turns?team=1#x');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'evil', '/%0d%0aSet-Cookie', '/login', '/api/auth/logout', '', null, 42]) {
      const out = safeNext(bad);
      expect(out === null || (out.startsWith('/') && !out.startsWith('//')), String(bad)).toBe(true);
      if (bad !== '/%0d%0aSet-Cookie') expect(out, String(bad)).toBeNull();
    }
    expect(safeNext('/a\tb')).toBeNull();
  });
});

describe('cookies + config', () => {
  it('session cookie is httpOnly, SameSite=Lax, 30 days; Secure on https', () => {
    const http = sessionCookieOptions({ APP_URL: 'http://localhost:3000' });
    expect(http).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', secure: false, maxAge: 30 * 24 * 3600 });
    expect(sessionCookieOptions({ APP_URL: 'https://obs.example' }).secure).toBe(true);
    expect(expiredCookieOptions({}).maxAge).toBe(0);
  });

  it('reads env', () => {
    expect(appUrl({}).origin).toBe('http://localhost:3000');
    expect(isSecure({ APP_URL: 'https://x.example' })).toBe(true);
    expect([...superAdminEmails({ SUPER_ADMIN_EMAILS: ' Root@X.example, ,b@y.example' })]).toEqual(['root@x.example', 'b@y.example']);
    expect(enabledOAuthProviders({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's', GOOGLE_CLIENT_ID: 'id' })).toEqual(['github']);
  });
});

describe('origin check', () => {
  const allowed = ['http://localhost:3000'];
  const h = (init: Record<string, string>) => new Headers(init);
  it('accepts same origin', () => {
    expect(isSameOriginRequest(h({ origin: 'http://localhost:3000' }), allowed)).toBe(true);
    expect(isSameOriginRequest(h({ referer: 'http://localhost:3000/login' }), allowed)).toBe(true);
    expect(isSameOriginRequest(h({ 'sec-fetch-site': 'same-origin' }), allowed)).toBe(true);
  });
  it('rejects cross-site and missing evidence', () => {
    expect(isSameOriginRequest(h({ origin: 'https://evil.example' }), allowed)).toBe(false);
    expect(isSameOriginRequest(h({ origin: 'null' }), allowed)).toBe(false);
    expect(isSameOriginRequest(h({ origin: 'https://evil.example', referer: 'http://localhost:3000/' }), allowed)).toBe(false);
    expect(isSameOriginRequest(h({ referer: 'https://evil.example/x' }), allowed)).toBe(false);
    expect(isSameOriginRequest(h({ 'sec-fetch-site': 'cross-site' }), allowed)).toBe(false);
    expect(isSameOriginRequest(h({}), allowed)).toBe(false);
  });
});

describe('rate limiter', () => {
  it('limits per key per window', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect([rl.hit('a'), rl.hit('a'), rl.hit('a'), rl.hit('b')]).toEqual([true, true, false, true]);
    t = 1000;
    expect(rl.hit('a')).toBe(true);
  });
});

describe('route protection', () => {
  it('knows the public paths', () => {
    for (const p of ['/', '/login', '/login/sent', '/signup', '/logout', '/api/auth/magic', '/api/auth/github/callback', '/api/v1/ingest', '/api/v1/collector-config'])
      expect(isPublicPath(p), p).toBe(true);
    for (const p of ['/overview', '/turns', '/admin', '/super', '/api/export', '/loginx', '/api/v1/other'])
      expect(isPublicPath(p), p).toBe(false);
  });
});
