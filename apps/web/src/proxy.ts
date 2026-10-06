import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './lib/auth/config';
import { sessionCookieOptions } from './lib/auth/cookies';
import { isPublicPath } from './lib/auth/routes';
import { isWellFormedToken } from './lib/auth/tokens';

/**
 * Optimistic route protection (Next 16 `proxy`, Node runtime): no session cookie → /login?next=…
 * (401 for API calls). It does not hit the DB; requireUser() etc. do the real check. It also
 * refreshes the cookie's 30-day Max-Age on page loads so the browser expiry slides with the DB one.
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const hasSession = isWellFormedToken(token);

  if (!hasSession && !isPublicPath(pathname)) {
    if (pathname.startsWith('/api/')) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const login = new URL('/login', req.url);
    if (pathname !== '/') login.searchParams.set('next', pathname + search);
    return NextResponse.redirect(login, 307);
  }

  const res = NextResponse.next();
  if (hasSession && req.method === 'GET' && req.headers.get('sec-fetch-dest') === 'document') {
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)'],
};
