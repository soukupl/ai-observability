import type { ReactNode } from 'react';

/** Auth pages: login, magic-link confirm, refusal, the one-time welcome notice, sign out. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">{children}</main>;
}
