import { dbFor, withRlsContext, type Tx } from '@ai-obs/db';
import type { CurrentUser } from './session';

/**
 * The only way dashboard code should touch the DB: one transaction as app_web with the signed-in
 * user's RLS context (ADR-0006). Lead rights are not passed in — the DB derives them from
 * team_memberships — so the context role is the company role ('admin' | 'member').
 * Super admins have no company and no telemetry access: use dbFor('platform') for the console.
 */
export function withUserDb<T>(user: CurrentUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!user.companyId) throw new Error('withUserDb: user has no company (super admins use dbFor("platform"))');
  return withRlsContext(dbFor('web'), { companyId: user.companyId, userId: user.id, role: user.companyRole }, fn);
}
