'use server';

import { createBudget, deleteBudget, updateBudget } from '../budgets';
import { renameCompany, updateSettings } from '../company';
import { formObject } from '../input';
import { setProjectName, setProjectTeam } from '../projects';
import { messageAction } from '../run';
import type { ActionState } from '../types';

export async function updateSettingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', fd, (tx, u) => updateSettings(tx, u, formObject(fd)));
}
export async function renameCompanyAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', fd, (tx, u) => renameCompany(tx, u, formObject(fd)));
}
export async function setProjectNameAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', fd, (tx, u) => setProjectName(tx, u, formObject(fd)));
}
export async function setProjectTeamAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', fd, (tx, u) => setProjectTeam(tx, u, formObject(fd)));
}
export async function createBudgetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', fd, (tx, u) => createBudget(tx, u, formObject(fd)));
}
export async function updateBudgetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', fd, (tx, u) => updateBudget(tx, u, formObject(fd)));
}
export async function deleteBudgetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', fd, (tx, u) => deleteBudget(tx, u, formObject(fd)));
}
