import { dbFor, withRlsContext, type Tx } from '@ai-obs/db';
import type { CurrentUser } from './session';

/**
 * The only way dashboard code should touch the DB: one transaction as app_web with the signed-in user's RLS
 * context (ADR-0006, ADR-0028). Lead rights are not passed in (the DB derives them from team_memberships), and the
 * DB re-checks the role against memberships, so a stale 'admin' claim cannot escalate.
 */
export function withUserDb<T>(user: Pick<CurrentUser, 'id' | 'role'>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withRlsContext(dbFor('web'), { userId: user.id, role: user.role }, fn);
}
