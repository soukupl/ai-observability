export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading projects" className="animate-pulse space-y-4">
      <div className="h-7 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-24 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-64 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}
