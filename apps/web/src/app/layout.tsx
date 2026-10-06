import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { themeScript } from './theme-script';

export const metadata: Metadata = {
  title: { default: 'ai-obs', template: '%s · ai-obs' },
  description: 'How your team uses AI coding agents',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
        {children}
      </body>
    </html>
  );
}
