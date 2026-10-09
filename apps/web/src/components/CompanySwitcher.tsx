import { switchCompany } from '@/lib/auth/actions';
import type { SwitcherModel } from './company-switcher-model';

type Items = Extract<SwitcherModel, { mode: 'switcher' }>['items'];

const rowClass = 'flex w-full flex-col items-start rounded-md px-3 py-1.5 text-left text-sm';

/**
 * One row per company: a form posting `switchCompany` with a hidden `companyId`; the active company is
 * marked `aria-current` and is not a button. Server component (no client JS): the server action does the
 * switch and redirects to /overview.
 */
export function CompanySwitchList({ items }: { items: Items }) {
  return (
    <ul className="flex flex-col gap-0.5" aria-label="Switch company">
      {items.map((item) => {
        const label = (
          <>
            <span className="max-w-full truncate font-medium">{item.name}</span>
            <span className="max-w-full truncate text-xs text-zinc-500 dark:text-zinc-400">
              {item.slug} · {item.role}
            </span>
          </>
        );
        return (
          <li key={item.companyId}>
            {item.active ? (
              <div aria-current="true" className={`${rowClass} bg-zinc-100 dark:bg-zinc-800`}>
                {label}
              </div>
            ) : (
              <form action={switchCompany}>
                <input type="hidden" name="companyId" value={item.companyId} />
                <button type="submit" className={`${rowClass} hover:bg-zinc-100 dark:hover:bg-zinc-800`}>
                  {label}
                </button>
              </form>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The company in the header (md and up): "Platform" for super admins, the plain name for one company,
 * and a dropdown of every company for two or more (ADR-0022). Rendered only from companySwitcherModel.
 * Keyed by the active company so the layout's re-render after a switch remounts it closed.
 */
export function CompanySwitcher({ model }: { model: SwitcherModel }) {
  if (model.mode !== 'switcher') {
    return (
      <span className="hidden truncate text-sm text-zinc-500 md:inline dark:text-zinc-400">
        {model.mode === 'platform' ? 'Platform' : model.name}
      </span>
    );
  }
  return (
    <details key={model.active.companyId} className="relative hidden md:block">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 [&::-webkit-details-marker]:hidden">
        <span className="max-w-48 truncate">{model.active.name}</span>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="absolute left-0 top-11 w-64 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
        <CompanySwitchList items={model.items} />
      </div>
    </details>
  );
}
