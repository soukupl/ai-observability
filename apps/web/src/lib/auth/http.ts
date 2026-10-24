import { NextResponse, type NextRequest } from 'next/server';
import { appUrl, AuthConfigError, reportAuthConfigError, SESSION_COOKIE, trustedProxyHops } from './config';
import { sessionCookieOptions } from './cookies';
import type { LoginResult } from './login';
import { isSameOriginRequest } from './origin';

/** Helpers shared by the /api/auth/* route handlers. */

/** 303 to a path on APP_URL (never to a Host-header or user-supplied origin). */
export function redirectTo(path: string, env: NodeJS.ProcessEnv = process.env): NextResponse {
  return NextResponse.redirect(new URL(path, appUrl(env)), 303);
}

export function loginError(code: string, next?: string | null): NextResponse {
  const params = new URLSearchParams({ error: code });
  if (next) params.set('next', next);
  return redirectTo(`/login?${params}`);
}

/** CSRF: POSTs must come from our own origin (APP_URL, or the URL the request was served on). */
export function isTrustedPost(req: NextRequest): boolean {
  return isSameOriginRequest(req.headers, [appUrl().origin, req.nextUrl.origin]);
}

/**
 * Client IP for the per-IP magic-link limit. Proxies APPEND to X-Forwarded-For, so everything left of
 * the entries our own proxies added is whatever the client sent: with TRUSTED_PROXY_HOPS = n (default
 * 1) the client is the n-th entry from the right. n = 0 ignores X-Forwarded-For and uses X-Real-IP
 * (only safe when the proxy overwrites it). Without either header: null (no per-IP limit; the
 * per-e-mail limit still applies). Route handlers cannot see the socket address in Next.
 */
export function clientIp(req: Pick<NextRequest, 'headers'>, env: NodeJS.ProcessEnv = process.env): string | null {
  const hops = trustedProxyHops(env);
  const realIp = req.headers.get('x-real-ip')?.trim() || null;
  if (hops === 0) return realIp;
  const hopsSeen = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (hopsSeen.length === 0) return realIp;
  // Fewer entries than proxies: every entry came from a proxy; take the left-most.
  return hopsSeen[Math.max(0, hopsSeen.length - hops)]!;
}

/**
 * The response for a failed auth request: a server misconfiguration (AuthConfigError, logged once per
 * process) → /login?error=config; anything else is logged → /login?error=<fallback>.
 */
export function authFailure(err: unknown, what: string, fallback = 'failed', next?: string | null): NextResponse {
  if (err instanceof AuthConfigError) {
    reportAuthConfigError(err);
    return loginError('config');
  }
  console.error(`${what} failed`, (err as Error)?.message ?? err);
  return loginError(fallback, next);
}

/**
 * Turns a login outcome into the redirect: the session cookie and the landing path (`next`, or the one-time welcome
 * notice after joining), the refusal page for an e-mail no rule admits, or /login?error=.
 */
export function respondToLogin(result: LoginResult): NextResponse {
  if (result.kind === 'error') {
    if (result.code === 'not-invited' || result.code === 'removed') return redirectTo(`/login/refused?reason=${result.code}`);
    return loginError(result.code);
  }
  const res = redirectTo(result.landing);
  res.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions());
  return res;
}
