'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { IDLE, type TokenReveal } from '@/lib/admin/types';
import { ActionMessage, type FormAction } from './ActionForm';
import { CompanyField } from './CompanyScope';
import { buttonCls } from './ui';

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={buttonCls.subtle}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/** The new token, shown exactly once (it lives only in this component's state). */
function Reveal({ token }: { token: TokenReveal }) {
  return (
    <div className="mt-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
      <p className="font-medium text-amber-900 dark:text-amber-200">Copy this now. It will not be shown again.</p>
      <pre className="overflow-x-auto rounded bg-white p-2 text-xs dark:bg-zinc-950">
        <code>{token.plaintext}</code>
      </pre>
      <p className="text-xs text-zinc-700 dark:text-zinc-300">Run on the developer machine:</p>
      <pre className="overflow-x-auto rounded bg-white p-2 text-xs dark:bg-zinc-950">
        <code>{token.command}</code>
      </pre>
      <div className="flex flex-wrap gap-2">
        <Copy text={token.plaintext} label="Copy token" />
        <Copy text={token.command} label="Copy command" />
        {token.mdmJson && (
          <a
            className={buttonCls.subtle}
            download={token.mdmFilename}
            href={`data:application/json;charset=utf-8,${encodeURIComponent(token.mdmJson)}`}
          >
            Download config (MDM)
          </a>
        )}
      </div>
    </div>
  );
}

/** Token creation (user or company token): fields as children, the plaintext + install command appear after success. */
export function TokenCreateForm({ action, children, submitLabel }: { action: FormAction; children: ReactNode; submitLabel: string }) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  return (
    <div className="min-w-0">
      <form action={formAction} className="flex flex-wrap items-end gap-2">
        <CompanyField />
        {children}
        <button type="submit" disabled={pending} className={buttonCls.primary}>
          {pending ? '…' : submitLabel}
        </button>
      </form>
      <div className="mt-1">
        <ActionMessage state={state} />
      </div>
      {state.status === 'ok' && state.token && <Reveal token={state.token} />}
    </div>
  );
}
