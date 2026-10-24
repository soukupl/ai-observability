import type { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { isOAuthProvider, OAUTH_COOKIE, sessionSecret, type OAuthProvider } from '@/lib/auth/config';
import { expiredCookieOptions } from '@/lib/auth/cookies';
import { authFailure, loginError, respondToLogin } from '@/lib/auth/http';
import { defaultAuthDeps, resolveIdentity } from '@/lib/auth/login';
import { finishOAuth } from '@/lib/auth/oauth';
import { verifyPayload } from '@/lib/auth/tokens';

type OAuthCookie = { provider: OAuthProvider; state: string; verifier: string | null; next: string | null };

const sameString = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// GET /api/auth/<google|github>/callback — checks state, exchanges the code, links by verified e-mail.
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await ctx.params;
  const params = req.nextUrl.searchParams;
  const code = params.get('code');
  const state = params.get('state');

  const respond = (res: NextResponse) => {
    res.cookies.set(OAUTH_COOKIE, '', expiredCookieOptions());
    return res;
  };
  let saved: OAuthCookie | null;
  try {
    saved = verifyPayload<OAuthCookie>(req.cookies.get(OAUTH_COOKIE)?.value, sessionSecret());
  } catch (err) {
    return respond(authFailure(err, `${provider} login`, 'oauth_failed'));
  }
  if (!isOAuthProvider(provider) || !saved || saved.provider !== provider || !code || !state || !sameString(state, saved.state)) {
    return respond(loginError('oauth_failed'));
  }
  try {
    const identity = await finishOAuth(provider, code, saved.verifier);
    if (!identity) return respond(loginError('email_unverified'));
    const result = await resolveIdentity(
      defaultAuthDeps(),
      { email: identity.email, name: identity.name, method: provider, account: { provider, id: identity.accountId } },
      saved.next,
    );
    return respond(respondToLogin(result));
  } catch (err) {
    return respond(authFailure(err, `${provider} login`, 'oauth_failed'));
  }
}
