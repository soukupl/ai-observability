import type { Tx } from '@ai-obs/db';
import { revalidatePath } from 'next/cache';
import { withUserDb } from '../auth/rls';
import { requireAdmin, requireUser, type CurrentUser } from '../auth/session';
import { userMessage } from './errors';
import { AdminError, type ActionState } from './types';

/**
 * Runs one admin operation for a server action: session gate (`admin` = requireAdmin(), `user` = any signed-in
 * member; the operation itself checks finer rights), one RLS transaction as the user (withUserDb), user-safe error
 * messages, and cache revalidation of the admin pages and "My tokens".
 */
export async function runAdmin<T>(
  gate: 'admin' | 'user',
  fn: (tx: Tx, user: CurrentUser) => Promise<T>,
): Promise<{ ok: true; value: T; user: CurrentUser } | { ok: false; state: ActionState }> {
  const user = gate === 'admin' ? await requireAdmin() : await requireUser();
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
export async function messageAction(gate: 'admin' | 'user', fn: (tx: Tx, user: CurrentUser) => Promise<string>): Promise<ActionState> {
  const r = await runAdmin(gate, fn);
  return r.ok ? { status: 'ok', message: r.value } : r.state;
}
