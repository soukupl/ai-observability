import type { CurrentUser } from '../../../../lib/auth/session';
import type { QueryCtx } from '../../../../lib/queries/scope';
import { getLiveSession, listActiveSessions } from '../../../../lib/queries/sessions';

/*
 * Live session JSON (ADR-0027): the "Active now" strip and the live session page poll these every 10 s. Same RLS
 * context and visibility as the pages; read-only, so no audit row. Relative imports keep this module importable from
 * the tests.
 */

export interface LiveDeps {
  getUser: () => Promise<CurrentUser | null>;
  withCtx: <T>(user: CurrentUser, fn: (ctx: QueryCtx) => Promise<T>) => Promise<T>;
}

export const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;

const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: NO_STORE });

/** 401 as a Response, else the user to read as. */
async function gate(deps: LiveDeps): Promise<Response | CurrentUser> {
  const user = await deps.getUser();
  if (!user) return json({ error: 'unauthorized' }, 401);
  return user;
}

/** GET /api/live/sessions → ActiveSessionsPayload */
export async function liveSessionsGet(_req: Request, deps: LiveDeps): Promise<Response> {
  const viewer = await gate(deps);
  if (viewer instanceof Response) return viewer;
  return json(await deps.withCtx(viewer, (ctx) => listActiveSessions(ctx)));
}

/** GET /api/live/sessions/<uuid> → LiveSessionPayload; 404 when missing or not visible. */
export async function liveSessionGet(_req: Request, id: string, deps: LiveDeps): Promise<Response> {
  const viewer = await gate(deps);
  if (viewer instanceof Response) return viewer;
  const live = await deps.withCtx(viewer, (ctx) => getLiveSession(ctx, id));
  return live ? json(live) : json({ error: 'not_found' }, 404);
}
