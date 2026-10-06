import type { NextRequest } from 'next/server';
import { oauthStartGet } from './handlers';

// GET /api/auth/<google|github>/start — see handlers.ts.
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await ctx.params;
  return oauthStartGet(req, provider);
}
