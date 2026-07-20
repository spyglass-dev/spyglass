/**
 * FilterBar — a report-wide filter strip: a date-range picker, then one control
 * per host-supplied facet. A facet with a few options renders as a chip group;
 * one with many (e.g. Class) renders as a searchable multi-select menu. Facets
 * can be `required` (always shown, prompted until set); optional facets start
 * hidden behind "+ Add filter" so the bar stays uncluttered. Edits a
 * `ReportFilters` object; the host maps that onto its own queries. Tailwind
 * design tokens, so it sits natively in the host's chrome.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Check, ChevronDown, Plus, Search } from 'lucide-react'
import { DateRangePicker } from './DateRangePicker'
import { hasActiveFilters, type FilterFacet, type ReportFilters } from '../filters'

/** Close `ref`'s popup when a click lands outside it. */
function useClickAway(ref: React.RefObject<HTMLElement | null>, onAway: () => void) {
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [ref, onAway])
}

const facetIsMenu = (f: FilterFacet) => f.variant === 'menu' || (f.variant !== 'chips' && f.options.length > 6)

export function FilterBar({
  filters,
  onChange,
  facets = [],
  onReset,
}: {
  filters: ReportFilters
  onChange: (next: ReportFilters) => void
  /** Host-defined facets. Required ones always show; the rest live under "+ Add filter". */
  facets?: FilterFacet[]
  /** Called by "Clear" — host decides what "reset" means (usually defaults). */
  onReset?: () => void
}) {
  const selected = (key: string): string[] => filters.facets?.[key] ?? []
  const setValues = (key: string, next: string[]) => {
    const map = { ...(filters.facets ?? {}) }
    if (next.length) map[key] = next
    else delete map[key]
    onChange({ ...filters, facets: map })
  }
  const toggle = (key: string, value: string) => {
    const cur = selected(key)
    setValues(key, cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value])
  }

  // Optional facets the teacher has revealed via "+ Add filter" this session.
  const [revealed, setRevealed] = useState<string[]>([])
  const isVisible = (f: FilterFacet) =>
    f.required || f.alwaysOn || selected(f.key).length > 0 || revealed.includes(f.key)
  const visibleFacets = facets.filter(isVisible)
  const hiddenFacets = facets.filter((f) => !isVisible(f))

  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur sm:px-6">
      <DateRangePicker filters={filters} onChange={onChange} />

      {visibleFacets.map((facet) =>
        facetIsMenu(facet) ? (
          <FacetMenu
            key={facet.key}
            facet={facet}
            selected={selected(facet.key)}
            onToggle={(v) => toggle(facet.key, v)}
            onClear={() => setValues(facet.key, [])}
          />
        ) : (
          <div key={facet.key} className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {facet.label}
              {facet.required && <span className="ml-0.5 text-amber-500">*</span>}
            </span>
            {facet.options.map((o) => {
              const on = selected(facet.key).includes(o.value)
              const prompt = facet.required && selected(facet.key).length === 0
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(facet.key, o.value)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                    on
                      ? 'border-primary bg-primary/10 text-primary'
                      : prompt
                        ? 'border-amber-300 bg-amber-50/60 text-amber-700 hover:border-amber-400 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300'
                        : 'border-border bg-background text-muted-foreground hover:border-primary/50'
                  }`}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
        ),
      )}

      {hiddenFacets.length > 0 && (
        <AddFilterMenu facets={hiddenFacets} onAdd={(key) => setRevealed((r) => [...r, key])} />
      )}

      {onReset && hasActiveFilters(filters) && (
        <button
          type="button"
          onClick={() => {
            setRevealed([])
            onReset()
          }}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" /> Clear
        </button>
      )}
    </div>
  )
}

/** A searchable multi-select for a facet with many options (e.g. Class). */
function FacetMenu({
  facet,
  selected,
  onToggle,
  onClear,
}: {
  facet: FilterFacet
  selected: string[]
  onToggle: (value: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false))

  const opts = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? facet.options.filter((o) => o.label.toLowerCase().includes(s)) : facet.options
  }, [facet.options, q])

  const count = selected.length
  const prompt = facet.required && count === 0
  const label =
    count === 0
      ? facet.label
      : count === 1
        ? facet.options.find((o) => o.value === selected[0])?.label ?? `1 ${facet.label}`
        : `${count} ${facet.label}s`

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
          count > 0
            ? 'border-primary bg-primary/10 text-primary'
            : prompt
              ? 'border-amber-300 bg-amber-50/60 text-amber-700 hover:border-amber-400 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300'
              : 'border-border bg-background text-muted-foreground hover:border-primary/50'
        }`}
      >
        {label}
        {facet.required && count === 0 && <span className="text-amber-500">*</span>}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${facet.label.toLowerCase()}…`}
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {count > 0 && (
              <button type="button" onClick={onClear} className="text-[11px] text-muted-foreground hover:text-foreground">
                Clear
              </button>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {opts.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>}
            {opts.map((o) => {
              const on = selected.includes(o.value)
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => onToggle(o.value)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted"
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                    }`}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span className="truncate">{o.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** "+ Add filter" — reveals an optional facet that isn't on the bar yet. */
function AddFilterMenu({ facets, onAdd }: { facets: FilterFacet[]; onAdd: (key: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:border-primary/50 hover:text-foreground"
      >
        <Plus className="h-3 w-3" /> Filter
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-lg">
          {facets.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                onAdd(f.key)
                setOpen(false)
              }}
              className="block w-full px-3 py-1.5 text-left text-xs hover:bg-muted"
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
