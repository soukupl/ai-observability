export default function Loading() {
  return (
    <div aria-busy="true" className="animate-pulse space-y-3">
      <div className="h-6 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-10 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-80 rounded-xl bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}
