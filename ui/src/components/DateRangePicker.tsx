/**
 * DateRangePicker — a relative-preset + custom date range control. Styled with
 * tailwind design tokens (border-border / bg-popover / text-foreground / …) so
 * it inherits the host app's theme. Self-contained popover (no radix): a
 * trigger button + an absolutely-positioned panel with click-outside close.
 */
import { useEffect, useRef, useState } from 'react'
import { CalendarDays, ChevronDown } from 'lucide-react'
import {
  DATE_PRESETS,
  dateRangeLabel,
  type DateRangePreset,
  type ReportFilters,
} from '../filters'

export function DateRangePicker({
  filters,
  onChange,
}: {
  filters: ReportFilters
  onChange: (next: ReportFilters) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const pickPreset = (p: DateRangePreset) => {
    onChange({ ...filters, datePreset: p, dateFrom: undefined, dateTo: undefined })
    setOpen(false)
  }
  const setCustom = (patch: { dateFrom?: string; dateTo?: string }) =>
    onChange({ ...filters, datePreset: undefined, ...patch })

  const isCustom = !filters.datePreset && (!!filters.dateFrom || !!filters.dateTo)

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
      >
        <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
        {dateRangeLabel(filters)}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg">
          {DATE_PRESETS.map((p) => {
            const on = filters.datePreset === p.value
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => pickPreset(p.value)}
                className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted ${
                  on ? 'bg-primary/10 font-medium text-primary' : 'text-foreground'
                }`}
              >
                {p.label}
              </button>
            )
          })}

          <div className="my-1 h-px bg-border" />
          <div className="px-1.5 pb-1 pt-0.5">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Custom range
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={filters.dateFrom ?? ''}
                onChange={(e) => setCustom({ dateFrom: e.target.value || undefined })}
                className={`w-full rounded-md border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary ${
                  isCustom ? 'border-primary/50' : 'border-border'
                }`}
              />
              <span className="text-xs text-muted-foreground">→</span>
              <input
                type="date"
                value={filters.dateTo ?? ''}
                onChange={(e) => setCustom({ dateTo: e.target.value || undefined })}
                className={`w-full rounded-md border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary ${
                  isCustom ? 'border-primary/50' : 'border-border'
                }`}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
