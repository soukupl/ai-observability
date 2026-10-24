import type { NextRequest } from 'next/server';
import { magicLinkGet, magicLinkPost } from './handlers';

type Ctx = { params: Promise<{ token: string }> };

// GET /api/auth/magic/<token> — the e-mailed link: redirects to the confirm page, never consumes it.
export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  return magicLinkGet(req, (await ctx.params).token);
}

// POST /api/auth/magic/<token> — "Continue to sign in" (same-origin only): verifies (single use), then logs in.
export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  return magicLinkPost(req, (await ctx.params).token);
}
