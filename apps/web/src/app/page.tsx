import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">ai-obs</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        See how your team uses AI coding agents: projects, models, tokens, cost, phases and outcomes.
      </p>
      <Link href="/login" className="w-fit rounded-md bg-zinc-900 px-4 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">
        Sign in
      </Link>
    </main>
  );
}
