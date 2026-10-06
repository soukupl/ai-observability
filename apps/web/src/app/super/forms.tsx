'use client';

import { useActionState, type ReactNode } from 'react';
import { changePlanAction, createCompanyAction, inviteAdminAction, setStatusAction, type FormState } from '@/lib/platform/actions';

/** Client forms of the console. They hold no data of their own: the server actions validate and audit. */
const INPUT =
  'h-9 w-full rounded-md border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-950';
const BUTTON =
  'inline-flex h-9 items-center justify-center rounded-md bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300';
const BUTTON_DANGER =
  'inline-flex h-9 items-center justify-center rounded-md bg-red-700 px-3 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50';

function Message({ state }: { state: FormState }) {
  if (!state) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className="space-y-1 text-sm">
      <p className={state.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>{state.message}</p>
      {state.warning && <p className="text-amber-700 dark:text-amber-400">{state.warning}</p>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  );
}

const PLAN_OPTIONS = [
  { id: 'free', name: 'Free' },
  { id: 'team', name: 'Team' },
  { id: 'business', name: 'Business' },
];

export function CreateCompanyForm() {
  const [state, action, pending] = useActionState(createCompanyAction, null);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <Field label="Company name">
        <input name="name" required minLength={2} maxLength={80} className={INPUT} autoComplete="off" />
      </Field>
      <Field label="Slug" hint="Optional; derived from the name when empty. a-z, 0-9, hyphen.">
        <input name="slug" maxLength={40} pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?" className={INPUT} autoComplete="off" />
      </Field>
      <Field label="Plan">
        <select name="plan" defaultValue="free" className={INPUT}>
          {PLAN_OPTIONS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="First admin e-mail" hint="Gets an invitation; signing in with this address makes them the company admin.">
        <input name="adminEmail" type="email" required maxLength={254} className={INPUT} autoComplete="off" />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={pending} className={BUTTON}>
          {pending ? 'Creating…' : 'Create company and invite admin'}
        </button>
        <Message state={state} />
      </div>
    </form>
  );
}

export function PlanForm({ companyId, plan }: { companyId: string; plan: string }) {
  const [state, action, pending] = useActionState(changePlanAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="companyId" value={companyId} />
      <select name="plan" defaultValue={plan} aria-label="Plan" className={`${INPUT} w-auto`}>
        {PLAN_OPTIONS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={BUTTON}>
        Save plan
      </button>
      <Message state={state} />
    </form>
  );
}

export function StatusForm({ companyId, status }: { companyId: string; status: 'active' | 'suspended' }) {
  const [state, action, pending] = useActionState(setStatusAction, null);
  const suspending = status === 'active';
  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        if (suspending && !window.confirm('Suspend this company? Ingest and sign-in stop immediately; data is kept.')) e.preventDefault();
      }}
    >
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="status" value={suspending ? 'suspended' : 'active'} />
      {suspending && <input name="reason" maxLength={200} placeholder="Reason (optional, audited)" aria-label="Reason" className={`${INPUT} w-64 max-w-full`} />}
      <button type="submit" disabled={pending} className={suspending ? BUTTON_DANGER : BUTTON}>
        {suspending ? 'Suspend company' : 'Reactivate company'}
      </button>
      <Message state={state} />
    </form>
  );
}

export function InviteAdminForm({ companyId }: { companyId: string }) {
  const [state, action, pending] = useActionState(inviteAdminAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="companyId" value={companyId} />
      <input name="email" type="email" required maxLength={254} placeholder="admin@company.example" aria-label="Admin e-mail" className={`${INPUT} w-64 max-w-full`} />
      <button type="submit" disabled={pending} className={BUTTON}>
        Invite admin
      </button>
      <Message state={state} />
    </form>
  );
}
