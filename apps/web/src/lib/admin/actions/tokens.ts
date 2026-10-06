'use server';

import { appUrl } from '../../auth/config';
import { formObject } from '../input';
import { messageAction, runAdmin } from '../run';
import { createToken, revokeToken } from '../tokens';
import type { ActionState } from '../types';

/** Any signed-in user (own user token); team tokens: admins and leads of the team (checked in createToken + RLS). */
export async function createTokenAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const endpoint = appUrl().toString().replace(/\/+$/, '');
  const r = await runAdmin('user', (tx, u) => createToken(tx, u, formObject(fd), endpoint));
  if (!r.ok) return r.state;
  const { plaintext, command, kind, mdmJson, mdmFilename, name } = { ...r.value, name: String(fd.get('name') ?? '') };
  return {
    status: 'ok',
    message: `Token "${name}" created. Copy it now: it is shown only once.`,
    token: { kind, plaintext, command, ...(mdmJson ? { mdmJson, mdmFilename } : {}) },
  };
}

export async function revokeTokenAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('user', (tx, u) => revokeToken(tx, u, formObject(fd)));
}
