'use client';

import { useActionState } from 'react';
import { unflagFlowAction } from '@/lib/flows/actions';
import { IDLE } from '@/lib/admin/types';

/** Removes one flag from the "Flagged for later" list (ADR-0024); the list re-renders after revalidation. */
export function UnflagButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState(unflagFlowAction, IDLE);
  return (
    <form action={action} className="ml-auto flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      {state.status === 'error' && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-400">
          {state.message}
        </span>
      )}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-7 items-center rounded-md border border-zinc-300 px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {pending ? '…' : 'Remove'}
      </button>
    </form>
  );
}
