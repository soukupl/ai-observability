import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { sessionSecret, SIGNUP_COOKIE } from '../../../../lib/auth/config';
import { authFailure, isTrustedPost, loginError, redirectTo, respondToLogin } from '../../../../lib/auth/http';
import { acceptPendingInvitation, completeSignup, defaultAuthDeps, type AuthDeps, type PendingSignup } from '../../../../lib/auth/login';
import { verifyPayload } from '../../../../lib/auth/tokens';

/*
 * The sign-up step after a verified login with no account (ADR-0013). The form either joins one
 * pending invitation the user picked (`invitation=<id>`; never chosen for them, SEC-1) or creates a
 * solo workspace (`name`, `company`). Relative imports keep this module importable from the tests.
 */

const Details = z.object({
  name: z.string().trim().min(1).max(100),
  company: z.string().trim().min(1).max(100),
});
const InvitationId = z.uuid();

type SignupCookie = PendingSignup & { next: string | null };

/** POST /api/auth/signup */
export async function signupPost(req: NextRequest, deps: () => AuthDeps = defaultAuthDeps): Promise<Response> {
  if (!isTrustedPost(req)) return new Response('forbidden', { status: 403 });
  try {
    const pending = verifyPayload<SignupCookie>(req.cookies.get(SIGNUP_COOKIE)?.value, sessionSecret());
    if (!pending) return loginError('signup_expired');
    const form = await req.formData().catch(() => null);
    const identity: PendingSignup = { email: pending.email, name: pending.name, method: pending.method, account: pending.account };

    const invitation = form?.get('invitation');
    if (invitation !== null && invitation !== undefined) {
      const id = InvitationId.safeParse(invitation);
      if (!id.success) return redirectTo('/signup?error=invitation');
      const result = await acceptPendingInvitation(deps(), identity, id.data);
      // Still 'signup': the invitation is gone (expired, revoked, not for this e-mail); keep the cookie.
      if (result.kind === 'signup') return redirectTo('/signup?error=invitation');
      return respondToLogin(result, pending.next);
    }

    const details = Details.safeParse({ name: form?.get('name'), company: form?.get('company') });
    if (!details.success) return redirectTo('/signup?error=invalid');
    return respondToLogin(await completeSignup(deps(), identity, details.data), pending.next);
  } catch (err) {
    return authFailure(err, 'sign-up');
  }
}
