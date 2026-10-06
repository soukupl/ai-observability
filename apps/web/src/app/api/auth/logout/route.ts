import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/config';
import { expiredCookieOptions } from '@/lib/auth/cookies';
import { isTrustedPost, redirectTo } from '@/lib/auth/http';
import { defaultAuthDeps, endSession } from '@/lib/auth/login';

// POST /api/auth/logout — plain-form logout (the `logout` server action does the same).
export async function POST(req: NextRequest): Promise<Response> {
  if (!isTrustedPost(req)) return new Response('forbidden', { status: 403 });
  await endSession(defaultAuthDeps(), req.cookies.get(SESSION_COOKIE)?.value);
  const res = redirectTo('/login');
  res.cookies.set(SESSION_COOKIE, '', expiredCookieOptions());
  return res;
}
