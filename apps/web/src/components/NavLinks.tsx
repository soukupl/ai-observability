'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavItem } from './nav';

/** Sidebar links with the current section highlighted. `closeMenu` collapses the phone <details> after a tap. */
export function NavLinks({ items, closeMenu = false }: { items: NavItem[]; closeMenu?: boolean }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              title={item.title}
              aria-current={active ? 'page' : undefined}
              onClick={(e) => {
                if (closeMenu) e.currentTarget.closest('details')?.removeAttribute('open');
              }}
              className={`block rounded-md px-3 py-2 text-sm font-medium ${
                active
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
              }`}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
