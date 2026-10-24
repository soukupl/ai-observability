import type { NextRequest } from 'next/server';
import { authFailure, isTrustedPost, loginError, redirectTo, respondToLogin } from '../../../../../lib/auth/http';
import { defaultAuthDeps, resolveIdentity, verifyMagicLink, type AuthDeps } from '../../../../../lib/auth/login';
import { isWellFormedToken, safeNext } from '../../../../../lib/auth/tokens';

/*
 * The e-mailed magic link (ADR-0013). Mail scanners and link previewers fetch links with GET, so GET
 * never consumes the token: it only sends the browser to the confirm page (/login/magic/<token>),
 * whose "Continue to sign in" button POSTs back here. Only a same-origin POST verifies and consumes
 * the single-use token. Relative imports keep this module importable from the tests.
 */

/** GET /api/auth/magic/<token>[?next=] → 303 to the confirm page. Touches nothing. */
export function magicLinkGet(req: NextRequest, token: string): Response {
  if (!isWellFormedToken(token)) return loginError('link_invalid');
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  const query = next ? `?${new URLSearchParams({ next })}` : '';
  return redirectTo(`/login/magic/${token}${query}`);
}

/** POST /api/auth/magic/<token> (confirm form) → verifies + consumes, then logs in (provisioning a new member when a rule admits the e-mail). */
export async function magicLinkPost(req: NextRequest, token: string, deps: () => AuthDeps = defaultAuthDeps): Promise<Response> {
  if (!isTrustedPost(req)) return new Response('forbidden', { status: 403 });
  const form = await req.formData().catch(() => null);
  const next = safeNext(form?.get('next') ?? req.nextUrl.searchParams.get('next'));
  try {
    const d = deps();
    const identity = await verifyMagicLink(d, token);
    if (!identity) return loginError('link_invalid');
    return respondToLogin(await resolveIdentity(d, identity, next));
  } catch (err) {
    return authFailure(err, 'magic link login');
  }
}
