/** Tailwind class strings shared by the admin forms (light + dark). */
export const inputCls =
  'h-9 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-900 focus:outline-2 focus:outline-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';
export const selectCls = inputCls;
export const labelCls = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400';
const btn = 'inline-flex h-9 shrink-0 items-center justify-center rounded-md px-3 text-sm font-medium disabled:opacity-50';
export const buttonCls = {
  primary: `${btn} bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300`,
  subtle: `${btn} border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`,
  danger: `${btn} bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600`,
} as const;
export type ButtonTone = keyof typeof buttonCls;
export const noteCls = 'text-xs text-zinc-500 dark:text-zinc-400';
export const tableWrapCls = 'overflow-x-auto';
export const tableCls = 'w-full text-sm';
export const thCls = 'whitespace-nowrap px-2 py-2 text-left text-xs font-medium text-zinc-500 dark:text-zinc-400';
export const tdCls = 'px-2 py-2 align-top';
export const trCls = 'border-b border-zinc-100 last:border-0 dark:border-zinc-800/60';
