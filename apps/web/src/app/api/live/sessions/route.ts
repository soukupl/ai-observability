import { getCurrentUser } from '@/lib/auth/session';
import { withDashboardContext } from '@/lib/queries/page';
import { liveSessionsGet } from './handlers';

export const dynamic = 'force-dynamic';

// GET /api/live/sessions?company=<id> — the "Active now" strip's poll (handlers.ts, ADR-0027).
export function GET(req: Request): Promise<Response> {
  return liveSessionsGet(req, { getUser: getCurrentUser, withCtx: withDashboardContext });
}
