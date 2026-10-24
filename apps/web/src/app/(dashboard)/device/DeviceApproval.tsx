'use client';

import { useActionState, type ReactNode } from 'react';
import { Card } from '@/components/Card';
import { deviceAction } from '@/lib/auth/device-actions';
import type { DeviceState } from '@/lib/auth/device';
import { buttonCls, inputCls, labelCls, noteCls } from '../../admin/_components/ui';

function Message({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
      : 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200';
  return (
    <p role={tone === 'ok' ? 'status' : 'alert'} className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
      {children}
    </p>
  );
}

const START: DeviceState = { step: 'enter' };

/**
 * The code entry and the confirm card of `/device`, driven by one POST server action (deviceAction). The code is
 * never read from the URL, so the person always types it (brief Appendix B).
 */
export function DeviceApproval({ origin }: { origin: string }) {
  const [state, formAction, busy] = useActionState(deviceAction, START);

  if (state.step === 'confirm') {
    return (
      <Card title={`Code ${state.code.slice(0, 4)}-${state.code.slice(4)}`}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-zinc-500 dark:text-zinc-400">Computer</dt>
          <dd className="font-medium" data-device-client>{state.clientName}</dd>
          {state.clientVersion && (
            <>
              <dt className="text-zinc-500 dark:text-zinc-400">Collector</dt>
              <dd>ai-obs {state.clientVersion}</dd>
            </>
          )}
          <dt className="text-zinc-500 dark:text-zinc-400">Requested from</dt>
          <dd className="font-mono text-xs leading-5">{state.requesterIp ?? 'unknown address'}</dd>
          <dt className="text-zinc-500 dark:text-zinc-400">Requested</dt>
          <dd>{state.age}</dd>
        </dl>
        <p className={`mt-3 ${noteCls}`}>
          Approve only if you just ran <code className="font-mono">ai-obs login</code> on this computer. If you did not, deny it.
        </p>
        <form action={formAction} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="code" value={state.code} />
          <button type="submit" name="intent" value="approve" disabled={busy} className={buttonCls.primary}>
            Approve
          </button>
          <button type="submit" name="intent" value="deny" disabled={busy} className={buttonCls.danger}>
            Deny
          </button>
        </form>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {state.tone === 'ok' && state.message && <Message tone="ok">{state.message}</Message>}
      <Card title="Enter the code from your terminal">
        {state.tone === 'error' && state.message && (
          <div className="mb-3">
            <Message tone="error">{state.message}</Message>
          </div>
        )}
        <form action={formAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="intent" value="lookup" />
          <label className={`${labelCls} grow sm:max-w-xs`}>
            Code
            <input
              name="code"
              required
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={12}
              placeholder="XXXX-XXXX"
              defaultValue={state.typed ?? ''}
              key={state.typed ?? ''}
              className={`${inputCls} font-mono uppercase tracking-widest`}
            />
          </label>
          <button type="submit" disabled={busy} className={buttonCls.primary}>
            {busy ? '…' : 'Continue'}
          </button>
        </form>
        <p className={`mt-3 ${noteCls}`}>
          Start with <code className="font-mono">npx @soukupl/ai-obs login --server {origin}</code>. Prefer a pasted token? Create one on My tokens.
        </p>
      </Card>
    </div>
  );
}
