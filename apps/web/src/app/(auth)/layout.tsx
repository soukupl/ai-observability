import type { ReactNode } from 'react';

/** Unauthenticated pages: login, magic-link callback, invitation accept. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">{children}</main>;
}
