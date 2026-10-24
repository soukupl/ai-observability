'use server';

import { appUrl } from '../../auth/config';
import { formObject } from '../input';
import { messageAction, runAdmin } from '../run';
import { createOwnToken, createServiceToken, revokeToken, type CreatedToken } from '../tokens';
import type { ActionState } from '../types';

const endpoint = () => appUrl().toString().replace(/\/+$/, '');

function revealed(r: Awaited<ReturnType<typeof runAdmin<CreatedToken>>>, name: string): ActionState {
  if (!r.ok) return r.state;
  const { plaintext, command, expiresAt } = r.value;
  return {
    status: 'ok',
    message: `Token "${name}" created. Copy it now: it is shown only once.`,
    token: { plaintext, command, expiresAt },
  };
}

/** "My tokens": a manual token for the signed-in user with a lifetime of 30 / 90 / 365 days or none. */
export async function createOwnTokenAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await runAdmin('user', (tx, u) => createOwnToken(tx, u, formObject(fd), endpoint()));
  return revealed(r, String(fd.get('name') ?? ''));
}

/** Admin → Service users: a token for a service user (admins only; checked again in createServiceToken and RLS). */
export async function createServiceTokenAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const r = await runAdmin('admin', (tx, u) => createServiceToken(tx, u, formObject(fd), endpoint()));
  return revealed(r, String(fd.get('name') ?? ''));
}

/** Own tokens for everyone; every token for admins (canRevokeToken + RLS). */
export async function revokeTokenAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('user', (tx, u) => revokeToken(tx, u, formObject(fd)));
}
