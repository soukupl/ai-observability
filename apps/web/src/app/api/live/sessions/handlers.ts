import type { CompanyUser, CurrentUser } from '../../../../lib/auth/session';
import type { QueryCtx } from '../../../../lib/queries/scope';
import { getLiveSession, listActiveSessions } from '../../../../lib/queries/sessions';

/*
 * Live session JSON (ADR-0027): the "Active now" strip and the live session page poll these every 10 s. Same RLS
 * context and visibility as the pages; read-only, so no audit row. `?company=` must name the active company, so a tab
 * left open on another company stops instead of showing this one's sessions. Relative imports keep this module
 * importable from the tests.
 */

export interface LiveDeps {
  getUser: () => Promise<CurrentUser | null>;
  withCtx: <T>(user: CompanyUser, fn: (ctx: QueryCtx) => Promise<T>) => Promise<T>;
}

export const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: NO_STORE });

/** 401 / 403 / 409 as a Response, else the company user to read as. */
async function gate(req: Request, deps: LiveDeps): Promise<Response | CompanyUser> {
  const user = await deps.getUser();
  if (!user) return json({ error: 'unauthorized' }, 401);
  if (!user.companyId || !user.company) return json({ error: 'forbidden' }, 403);
  const company = new URL(req.url).searchParams.get('company');
  if (!company || company !== user.companyId) return json({ error: 'company_changed' }, 409);
  return { ...user, companyId: user.companyId, company: user.company };
}

/** GET /api/live/sessions?company=<id> → ActiveSessionsPayload */
export async function liveSessionsGet(req: Request, deps: LiveDeps): Promise<Response> {
  const viewer = await gate(req, deps);
  if (viewer instanceof Response) return viewer;
  return json(await deps.withCtx(viewer, (ctx) => listActiveSessions(ctx)));
}

/** GET /api/live/sessions/<uuid>?company=<id> → LiveSessionPayload; 404 when missing or not visible. */
export async function liveSessionGet(req: Request, id: string, deps: LiveDeps): Promise<Response> {
  const viewer = await gate(req, deps);
  if (viewer instanceof Response) return viewer;
  const live = await deps.withCtx(viewer, (ctx) => getLiveSession(ctx, id));
  return live ? json(live) : json({ error: 'not_found' }, 404);
}
