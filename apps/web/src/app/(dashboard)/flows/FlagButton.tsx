'use client';

import { useActionState, useState } from 'react';
import { ActionMessage } from '@/app/admin/_components/ActionForm';
import { buttonCls, inputCls } from '@/app/admin/_components/ui';
import { flagFlowAction, unflagFlowAction } from '@/lib/flows/actions';
import { IDLE } from '@/lib/admin/types';

/**
 * "Flag for later" / "Remove flag" of one flow (ADR-0024). Flagging opens an optional note field first; the page re-renders with the flag
 * after the action (revalidatePath), so `flag` is the server's truth, not local state.
 */
export function FlagButton({
  turnId,
  flowKey,
  startedMs,
  flag,
}: {
  turnId: string;
  flowKey: string;
  startedMs: number;
  /** The viewer's flag of this flow, or null. */
  flag: { id: string; note: string | null } | null;
}) {
  const [flagState, flagAction, flagging] = useActionState(flagFlowAction, IDLE);
  const [unflagState, unflagAction, unflagging] = useActionState(unflagFlowAction, IDLE);
  const [open, setOpen] = useState(false);
  const state = flag ? unflagState : flagState;

  return (
    <div className="flex flex-col items-end gap-1">
      {flag ? (
        <form action={unflagAction} className="flex items-center gap-2">
          <input type="hidden" name="id" value={flag.id} />
          <span className="text-xs font-medium text-amber-700 dark:text-amber-400" title={flag.note ?? undefined}>
            ⚑ Flagged
          </span>
          <button type="submit" disabled={unflagging} className={buttonCls.subtle}>
            {unflagging ? '…' : 'Remove flag'}
          </button>
        </form>
      ) : open ? (
        <form action={flagAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="turnId" value={turnId} />
          <input type="hidden" name="key" value={flowKey} />
          <input type="hidden" name="startedMs" value={startedMs} />
          <input name="note" maxLength={500} placeholder="Note (optional)" aria-label="Note" className={`${inputCls} w-56`} autoFocus />
          <button type="submit" disabled={flagging} className={buttonCls.primary}>
            {flagging ? '…' : 'Flag for later'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className={buttonCls.subtle}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={buttonCls.subtle} title="Bookmark this flow for later (only you see it)">
          ⚑ Flag for later
        </button>
      )}
      <ActionMessage state={state} />
    </div>
  );
}
