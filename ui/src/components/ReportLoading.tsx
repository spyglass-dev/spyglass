/**
 * ReportLoading — a shimmering skeleton for the report surface (KPI row → chart
 * → tables), shown while a report builds or widgets resolve. Tailwind tokens.
 */
export function ReportLoading({ message = 'Loading…' }: { message?: string }) {
  const shimmer =
    'relative overflow-hidden rounded-xl border border-border bg-muted/40 ' +
    "before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_1.6s_infinite] " +
    'before:bg-gradient-to-r before:from-transparent before:via-background/60 before:to-transparent'
  return (
    <div className="w-full" aria-busy="true" aria-live="polite">
      <style>{`@keyframes shimmer{100%{transform:translateX(100%)}}`}</style>
      <div className="mb-6 flex items-center gap-3">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        <span className="text-sm font-medium text-muted-foreground">{message}</span>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${shimmer} h-24`} style={{ animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
      <div className={`${shimmer} mt-4 h-64`} />
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className={`${shimmer} h-52`} />
        <div className={`${shimmer} h-52`} />
      </div>
    </div>
  )
}
