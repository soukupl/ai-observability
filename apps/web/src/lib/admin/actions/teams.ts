'use server';

import { formObject } from '../input';
import { messageAction } from '../run';
import { addMember, createTeam, deleteTeam, removeMember, renameTeam, setMemberRole, setPrimaryTeam } from '../teams';
import type { ActionState } from '../types';

export async function createTeamAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => createTeam(tx, u, formObject(fd)));
}
export async function renameTeamAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => renameTeam(tx, u, formObject(fd)));
}
export async function deleteTeamAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => deleteTeam(tx, u, formObject(fd)));
}
export async function addMemberAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => addMember(tx, u, formObject(fd)));
}
export async function removeMemberAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => removeMember(tx, u, formObject(fd)));
}
export async function setMemberRoleAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => setMemberRole(tx, u, formObject(fd)));
}
export async function setPrimaryTeamAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => setPrimaryTeam(tx, u, formObject(fd)));
}
