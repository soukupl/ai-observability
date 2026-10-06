import { NextResponse, type NextRequest } from 'next/server';
import { isOAuthProvider, OAUTH_COOKIE, OAUTH_TTL_MS, sessionSecret } from '../../../../../lib/auth/config';
import { oauthCookieOptions } from '../../../../../lib/auth/cookies';
import { authFailure, loginError, redirectTo } from '../../../../../lib/auth/http';
import { startOAuth } from '../../../../../lib/auth/oauth';
import { safeNext, signPayload } from '../../../../../lib/auth/tokens';

/**
 * GET /api/auth/<google|github>/start — state (+ PKCE verifier) in a signed httpOnly cookie, then the
 * provider. A missing SESSION_SECRET in production → /login?error=config (not a bare 500).
 * Relative imports keep this module importable from the tests.
 */
export function oauthStartGet(req: NextRequest, provider: string): Response {
  if (!isOAuthProvider(provider)) return redirectTo('/login');
  try {
    const secret = sessionSecret();
    const start = startOAuth(provider);
    if (!start) return loginError('provider_disabled');
    const next = safeNext(req.nextUrl.searchParams.get('next'));
    const res = NextResponse.redirect(start.url, 302);
    const payload = { provider, state: start.state, verifier: start.codeVerifier, next };
    res.cookies.set(OAUTH_COOKIE, signPayload(payload, secret, OAUTH_TTL_MS), oauthCookieOptions());
    return res;
  } catch (err) {
    return authFailure(err, `${provider} login start`, 'oauth_failed');
  }
}
