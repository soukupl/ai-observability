const bar = 'animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800';

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading overview" className="space-y-4">
      <div className={`${bar} h-8 w-48`} />
      <div className={`${bar} h-14`} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`${bar} h-24`} />
        ))}
      </div>
      <div className={`${bar} h-24`} />
      <div className={`${bar} h-80`} />
      <div className={`${bar} h-20`} />
    </div>
  );
}
