'use server';

import { createBudget, deleteBudget, updateBudget } from '../budgets';
import { renameDeployment, updateSettings } from '../deployment';
import { formObject } from '../input';
import { deleteModelPrice, saveModelPrice } from '../model-prices';
import { setProjectName, setProjectTeam } from '../projects';
import { messageAction } from '../run';
import type { ActionState } from '../types';

export async function updateSettingsAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => updateSettings(tx, u, formObject(fd)));
}
export async function renameDeploymentAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => renameDeployment(tx, u, formObject(fd)));
}
export async function setProjectNameAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => setProjectName(tx, u, formObject(fd)));
}
export async function setProjectTeamAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => setProjectTeam(tx, u, formObject(fd)));
}
export async function createBudgetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => createBudget(tx, u, formObject(fd)));
}
export async function updateBudgetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => updateBudget(tx, u, formObject(fd)));
}
export async function deleteBudgetAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => deleteBudget(tx, u, formObject(fd)));
}
export async function saveModelPriceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => saveModelPrice(tx, u, formObject(fd)));
}
export async function deleteModelPriceAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return messageAction('admin', (tx, u) => deleteModelPrice(tx, u, formObject(fd)));
}
