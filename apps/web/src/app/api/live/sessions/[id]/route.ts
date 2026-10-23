import { getCurrentUser } from '@/lib/auth/session';
import { withDashboardContext } from '@/lib/queries/page';
import { liveSessionGet } from '../handlers';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// GET /api/live/sessions/<uuid>?company=<id> — the live session page's poll (../handlers.ts, ADR-0027).
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const { id } = await params;
  return liveSessionGet(req, id, { getUser: getCurrentUser, withCtx: withDashboardContext });
}
