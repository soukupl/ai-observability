import type { ReactNode } from 'react';
import { logout } from '@/lib/auth/actions';
import { NavLinks } from './NavLinks';
import { ThemeToggle } from './ThemeToggle';
import { navFor } from './nav';
import { VisibilityBanner } from './VisibilityBanner';

/** What the shell needs from the signed-in user (CurrentUser satisfies it). */
export interface ShellUser {
  email: string;
  name: string | null;
  role: 'admin' | 'member';
  teams: { id: string; name: string; role: 'member' | 'lead' }[];
  deployment: { name: string; settings: { individualVisibility: 'aggregates-only' | 'full' } };
}

/**
 * Dashboard frame: sidebar (a menu on phones) under the deployment's name, top bar with the theme toggle and the user
 * menu, and the visibility-mode footer line (the banner itself is rendered by the dashboard layout). One deployment
 * = one company (ADR-0028), so there is no company switcher. Server component: only NavLinks / ThemeToggle are client
 * code.
 */
export function AppShell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const items = navFor(user);
  const mode = user.deployment.settings.individualVisibility;
  const name = user.deployment.name;
  const role = user.role === 'admin' ? 'admin' : user.teams.some((t) => t.role === 'lead') ? 'lead' : 'member';
  return (
    <div className="min-h-dvh md:flex">
      <aside className="hidden w-56 shrink-0 border-r border-zinc-200 bg-white p-3 md:block dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-4 px-3 pt-1">
          <div className="truncate text-base font-semibold tracking-tight" data-deployment-name>
            {name}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">ai-obs</div>
        </div>
        <nav aria-label="Main">
          <NavLinks items={items} />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-zinc-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
          <details className="relative md:hidden">
            <summary
              aria-label="Menu"
              className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-700 [&::-webkit-details-marker]:hidden"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </summary>
            <nav aria-label="Main" className="absolute left-0 top-11 w-56 rounded-lg border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
              <NavLinks items={items} closeMenu />
            </nav>
          </details>
          <span className="min-w-0 truncate font-semibold md:hidden">{name}</span>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <details className="relative">
              <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 [&::-webkit-details-marker]:hidden">
                <span className="max-w-32 truncate sm:max-w-48">{user.name || user.email}</span>
              </summary>
              <div className="absolute right-0 top-11 w-64 rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                <div className="truncate font-medium">{user.name || user.email}</div>
                {user.name && <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{user.email}</div>}
                <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {name} · {role}
                </div>
                <form action={logout} className="mt-3">
                  <button
                    type="submit"
                    className="w-full rounded-md border border-zinc-200 px-3 py-1.5 text-left text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </details>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
          {children}
        </main>

        <footer className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="mx-auto max-w-7xl">
            <VisibilityBanner mode={mode} variant="footer" />
          </div>
        </footer>
      </div>
    </div>
  );
}
