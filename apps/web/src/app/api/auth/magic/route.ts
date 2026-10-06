import type { NextRequest } from 'next/server';
import { authFailure, clientIp, isTrustedPost, loginError, redirectTo } from '@/lib/auth/http';
import { defaultAuthDeps, requestMagicLink } from '@/lib/auth/login';
import { safeNext } from '@/lib/auth/tokens';

// POST /api/auth/magic — form post from /login: e-mails a single-use sign-in link (ADR-0013).
export async function POST(req: NextRequest): Promise<Response> {
  if (!isTrustedPost(req)) return new Response('forbidden', { status: 403 });
  const form = await req.formData().catch(() => null);
  const next = safeNext(form?.get('next'));
  try {
    const result = await requestMagicLink(defaultAuthDeps(), { email: form?.get('email'), ip: clientIp(req), next });
    if (!result.ok) return loginError(result.error, next);
  } catch (err) {
    return authFailure(err, 'magic link send', 'send_failed', next);
  }
  return redirectTo('/login/sent');
}
