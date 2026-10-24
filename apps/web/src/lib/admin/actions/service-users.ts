'use server';

import { formObject } from '../input';
import { messageAction } from '../run';
import { createServiceUser, disableServiceUser, renameServiceUser, setServicePrimaryTeam } from '../service-users';
import type { ActionState } from '../types';

export async function createServiceUserAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => createServiceUser(tx, u, formObject(fd)));
}
export async function renameServiceUserAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => renameServiceUser(tx, u, formObject(fd)));
}
export async function setServicePrimaryTeamAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => setServicePrimaryTeam(tx, u, formObject(fd)));
}
export async function disableServiceUserAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => disableServiceUser(tx, u, formObject(fd)));
}
