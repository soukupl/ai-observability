export default function Loading() {
  return (
    <div role="status" aria-label="Loading phases" className="animate-pulse space-y-4">
      <div className="h-7 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-10 w-full rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-72 w-full rounded-xl bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-40 w-full rounded-xl bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}
