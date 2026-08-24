export function BoardSkeleton() {
  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4" aria-hidden="true">
      {[0, 1, 2].map((col) => (
        <div key={col} className="flex w-72 shrink-0 flex-col gap-3 rounded-lg bg-slate-100 p-3">
          <div className="h-5 w-24 animate-pulse rounded bg-slate-300" />
          {[0, 1].map((card) => (
            <div key={card} className="space-y-2 rounded-md bg-white p-3 shadow-sm">
              <div className="h-4 w-3/4 animate-pulse rounded bg-slate-200" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-slate-200" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
