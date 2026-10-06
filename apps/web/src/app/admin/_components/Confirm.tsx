import type { ReactNode } from 'react';
import { ActionForm, type FormAction } from './ActionForm';

/**
 * Two-step destructive action without window.confirm: the first click opens the panel, the second
 * (the red button) submits. Plain <details>, so it works without JavaScript.
 */
export function Confirm({
  label,
  warning,
  action,
  confirmLabel,
  children,
}: {
  label: string;
  warning: ReactNode;
  action: FormAction;
  confirmLabel: string;
  children: ReactNode;
}) {
  return (
    <details className="group">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-md border border-red-300 px-2 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950 [&::-webkit-details-marker]:hidden">
        {label}
      </summary>
      <div className="mt-2 max-w-sm rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        <p className="mb-2">{warning}</p>
        <ActionForm action={action} submitLabel={confirmLabel} tone="danger">
          {children}
        </ActionForm>
      </div>
    </details>
  );
}
