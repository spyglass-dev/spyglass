/**
 * FilterBar — a report-wide filter strip: a date-range picker plus one chip
 * group per host-supplied facet (e.g. Status). Edits a `ReportFilters` object;
 * the host maps that onto its own queries. Tailwind design tokens, so it sits
 * natively in the host's chrome.
 */
import { X } from 'lucide-react'
import { DateRangePicker } from './DateRangePicker'
import { hasActiveFilters, type FilterFacet, type ReportFilters } from '../filters'

export function FilterBar({
  filters,
  onChange,
  facets = [],
  onReset,
}: {
  filters: ReportFilters
  onChange: (next: ReportFilters) => void
  /** Host-defined facets rendered as chip groups (e.g. Status). */
  facets?: FilterFacet[]
  /** Called by "Clear" — host decides what "reset" means (usually defaults). */
  onReset?: () => void
}) {
  const selected = (key: string): string[] => filters.facets?.[key] ?? []
  const toggle = (key: string, value: string) => {
    const cur = selected(key)
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
    const facetsMap = { ...(filters.facets ?? {}) }
    if (next.length) facetsMap[key] = next
    else delete facetsMap[key]
    onChange({ ...filters, facets: facetsMap })
  }

  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur sm:px-6">
      <DateRangePicker filters={filters} onChange={onChange} />

      {facets.map((facet) => (
        <div key={facet.key} className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{facet.label}</span>
          {facet.options.map((o) => {
            const on = selected(facet.key).includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => toggle(facet.key, o.value)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  on
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-background text-muted-foreground hover:border-primary/50'
                }`}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      ))}

      {onReset && hasActiveFilters(filters) && (
        <button
          type="button"
          onClick={onReset}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" /> Clear
        </button>
      )}
    </div>
  )
}
