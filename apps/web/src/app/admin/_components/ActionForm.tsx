'use client';

import { useActionState, type ReactNode } from 'react';
import { IDLE, type ActionState } from '@/lib/admin/types';
import { buttonCls, type ButtonTone } from './ui';

export type FormAction = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** Shows the result of an action (success / error) next to the form. */
export function ActionMessage({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  const ok = state.status === 'ok';
  return (
    <p role={ok ? 'status' : 'alert'} className={`text-xs ${ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
      {state.message}
    </p>
  );
}

/**
 * A form posting to a server action (progressive enhancement: works before hydration too) with the
 * action's message underneath. Fields are passed as children.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  tone = 'primary',
  className = 'flex flex-wrap items-end gap-2',
}: {
  action: FormAction;
  submitLabel: string;
  children?: ReactNode;
  tone?: ButtonTone;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  return (
    <div className="min-w-0">
      <form action={formAction} className={className}>
        {children}
        <button type="submit" disabled={pending} className={buttonCls[tone]}>
          {pending ? '…' : submitLabel}
        </button>
      </form>
      <div className="mt-1">
        <ActionMessage state={state} />
      </div>
    </div>
  );
}
