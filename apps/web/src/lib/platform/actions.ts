'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { changePlan, createCompany, inviteAdmin, setStatus, type ActionResult } from './companies';
import { platformDeps } from './deps';
import { requireSuperAdminOr404 } from './guard';
import { isUuid } from './validate';

/**
 * Server actions of the super-admin console. Each one re-checks the super-admin flag (404 otherwise),
 * runs on the app_platform connection and writes its audit_log row inside the same transaction.
 * They return a serializable result for useActionState forms; createCompany redirects on success.
 */
export type FormState = { ok: boolean; message: string; warning?: string } | null;

const str = (fd: FormData, k: string) => fd.get(k);

function toState(r: ActionResult): FormState {
  return r.ok ? { ok: true, message: r.notice ?? 'Done.', ...(r.warning ? { warning: r.warning } : {}) } : { ok: false, message: r.error };
}

export async function createCompanyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await requireSuperAdminOr404();
  const r = await createCompany(platformDeps(), actor, {
    name: str(fd, 'name'),
    slug: str(fd, 'slug'),
    plan: str(fd, 'plan'),
    adminEmail: str(fd, 'adminEmail'),
  });
  revalidatePath('/super');
  if (r.ok && r.companyId) redirect(`/super/companies/${r.companyId}?created=1${r.warning ? '&mail=failed' : ''}`);
  return toState(r);
}

async function onCompany(fd: FormData, run: (id: string, actor: Awaited<ReturnType<typeof requireSuperAdminOr404>>) => Promise<ActionResult>): Promise<FormState> {
  const actor = await requireSuperAdminOr404();
  const id = str(fd, 'companyId');
  if (!isUuid(id)) return { ok: false, message: 'Unknown company.' };
  const r = await run(id, actor);
  revalidatePath('/super');
  revalidatePath(`/super/companies/${id}`);
  return toState(r);
}

export async function changePlanAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return onCompany(fd, (id, actor) => changePlan(platformDeps(), actor, id, str(fd, 'plan')));
}

export async function setStatusAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const status = str(fd, 'status');
  if (status !== 'active' && status !== 'suspended') return { ok: false, message: 'Unknown status.' };
  return onCompany(fd, (id, actor) => setStatus(platformDeps(), actor, id, status, str(fd, 'reason')));
}

export async function inviteAdminAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return onCompany(fd, (id, actor) => inviteAdmin(platformDeps(), actor, id, str(fd, 'email')));
}
