import type { NextRequest } from 'next/server';
import { signupPost } from './handlers';

// POST /api/auth/signup — the sign-up step: join a picked invitation, or solo sign-up (handlers.ts).
export function POST(req: NextRequest): Promise<Response> {
  return signupPost(req);
}
