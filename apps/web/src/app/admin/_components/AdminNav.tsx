'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface AdminTab {
  href: string;
  label: string;
}

/** Sub-navigation of the admin console; scrolls horizontally on narrow screens. */
export function AdminNav({ tabs }: { tabs: AdminTab[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Admin" className="-mx-4 mb-4 overflow-x-auto border-b border-zinc-200 px-4 dark:border-zinc-800">
      <ul className="flex gap-1 whitespace-nowrap">
        {tabs.map((t) => {
          const active = t.href === '/admin' ? path === '/admin' : path === t.href || path.startsWith(`${t.href}/`);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={`inline-block border-b-2 px-3 py-2 text-sm font-medium ${
                  active
                    ? 'border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100'
                    : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
