import type { Tx } from '@ai-obs/db';
import { revalidatePath } from 'next/cache';
import { withUserDb } from '../auth/rls';
import { requireAdmin, requireUser, type CompanyUser } from '../auth/session';
import { userMessage } from './errors';
import { AdminError, type ActionState } from './types';

/**
 * D10: the form must have been rendered for the session's active company. The active company lives
 * on the session row, which all browser tabs share, so a form left open for company A must not act
 * on company B after a switch in another tab. A missing field counts as stale (fail closed). Pure.
 */
export function staleCompany(fd: FormData, activeCompanyId: string): ActionState | null {
  return fd.get('_companyId') === activeCompanyId ? null : { status: 'error', message: 'The active company changed in another tab. Reload this page.' };
}

/**
 * Runs one admin operation for a server action: session gate (`admin` = requireAdmin(), `user` =
 * any signed-in company user; the operation itself checks lead rights), the D10 company binding of
 * the form (`fd`), one RLS transaction as the user (withUserDb), user-safe error messages, and
 * cache revalidation of the admin pages.
 */
export async function runAdmin<T>(
  gate: 'admin' | 'user',
  fd: FormData,
  fn: (tx: Tx, user: CompanyUser) => Promise<T>,
): Promise<{ ok: true; value: T; user: CompanyUser } | { ok: false; state: ActionState }> {
  const user = gate === 'admin' ? await requireAdmin() : await requireUser();
  const stale = staleCompany(fd, user.companyId);
  if (stale) return { ok: false, state: stale };
  try {
    const value = await withUserDb(user, (tx) => fn(tx, user));
    revalidatePath('/admin', 'layout');
    revalidatePath('/tokens');
    return { ok: true, value, user };
  } catch (err) {
    if (!(err instanceof AdminError)) console.error('[admin] action failed', err);
    return { ok: false, state: { status: 'error', message: userMessage(err) } };
  }
}

/** For operations that return their success message. */
export async function messageAction(gate: 'admin' | 'user', fd: FormData, fn: (tx: Tx, user: CompanyUser) => Promise<string>): Promise<ActionState> {
  const r = await runAdmin(gate, fd, fn);
  return r.ok ? { status: 'ok', message: r.value } : r.state;
}
