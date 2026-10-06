import type { CompanyUser } from '../auth/session';
import { withUserDb } from '../auth/rls';
import { createQueryContext, type QueryCtx } from './scope';

/**
 * One RLS-bound transaction + price book for a whole page render:
 *   const data = await withDashboardContext(user, async (ctx) => ({ kpis: await getKpis(ctx, filters) }));
 */
export function withDashboardContext<T>(user: CompanyUser, fn: (ctx: QueryCtx) => Promise<T>): Promise<T> {
  return withUserDb(user, async (tx) => fn(await createQueryContext(tx, user)));
}
