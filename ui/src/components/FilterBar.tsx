/**
 * FilterBar — a report-wide filter strip: a date-range picker, then one control
 * per host-supplied facet, then the drill trail. A facet with a few options
 * renders as a chip group; one with many (e.g. Class) renders as a searchable
 * multi-select menu. Facets can be `required` (always shown, prompted until
 * set); optional facets start hidden behind "+ Add filter" so the bar stays
 * uncluttered. Edits a `ReportFilters` object; the host maps that onto its own
 * queries. Tailwind design tokens, so it sits natively in the host's chrome.
 *
 * THE DRILL TRAIL BELONGS HERE. A drill step and a facet compile to the same
 * thing — `applyDrillTrail` re-qualifies a step to the widget's cube "mirroring
 * how report facets apply", and both end up as an equality predicate on the
 * query. Rendering the trail as a separate strip below the bar made one of the
 * two invisible to "Clear" and split "what is narrowing this report?" across
 * two places. One row, one answer.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { X, Check, ChevronDown, Plus, Search } from 'lucide-react'
import { DateRangePicker } from './DateRangePicker'
import { hasActiveFilters, type FilterFacet, type ReportFilters } from '../filters'
import { drillStepLabel, type DrillTrail } from '../drill'

/** Host control for a facet: receives the current values + a setter, returns a
 *  node to render in place of the default chips/menu (e.g. a native combobox). */
export type FacetRenderer = (
  facet: FilterFacet,
  api: { values: string[]; setValues: (next: string[]) => void },
) => ReactNode | undefined

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

const facetIsMenu = (f: FilterFacet) =>
  f.variant === 'menu' || (f.variant !== 'chips' && (f.options?.length ?? 0) > 6)

export function FilterBar({
  filters,
  onChange,
  facets = [],
  drill = [],
  onPopDrill,
  onReset,
  renderFacet,
}: {
  filters: ReportFilters
  onChange: (next: ReportFilters) => void
  /** Host-defined facets. Required ones always show; the rest live under "+ Add filter". */
  facets?: FilterFacet[]
  /** The drill trail, rendered inline as removable chips — a drill step is a
   *  filter, so it belongs in the filter row rather than a strip of its own. */
  drill?: DrillTrail
  /** Truncate the trail to its first `length` steps (0 = clear the drill). */
  onPopDrill?: (length: number) => void
  /** Called by "Clear" — host decides what "reset" means (usually defaults,
   *  and it must also clear the drill trail, or Clear leaves the report
   *  narrowed by whatever the user last clicked). */
  onReset?: () => void
  /** Override the control for specific facets with a host component (e.g. a
   *  system combobox). Return `undefined` to keep the default chips/menu. */
  renderFacet?: FacetRenderer
}) {
  const selected = (key: string): string[] => filters.facets?.[key] ?? []
  const setValues = (key: string, next: string[]) => {
    const map = { ...(filters.facets ?? {}) }
    if (next.length) map[key] = next
    else delete map[key]
    onChange({ ...filters, facets: map })
  }
  const toggle = (facet: FilterFacet, value: string) => {
    const cur = selected(facet.key)
    if (facet.single) {
      setValues(facet.key, cur.includes(value) ? [] : [value])
      return
    }
    setValues(facet.key, cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value])
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

      {visibleFacets.map((facet) => {
        const custom = renderFacet?.(facet, {
          values: selected(facet.key),
          setValues: (next) => setValues(facet.key, next),
        })
        if (custom !== undefined && custom !== null) return <Fragment key={facet.key}>{custom}</Fragment>
        return facetIsMenu(facet) ? (
          <FacetMenu
            key={facet.key}
            facet={facet}
            selected={selected(facet.key)}
            onToggle={(v) => toggle(facet, v)}
            onClear={() => setValues(facet.key, [])}
            closeOnPick={facet.single}
          />
        ) : (
          <div key={facet.key} className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {facet.label}
              {facet.required && <span className="ml-0.5 text-amber-500">*</span>}
            </span>
            {(facet.options ?? []).map((o) => {
              const on = selected(facet.key).includes(o.value)
              const prompt = facet.required && selected(facet.key).length === 0
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(facet, o.value)}
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
        )
      })}

      {/* Drill steps, as removable chips. Clicking one pops the trail back to
          just before it — the same undo the breadcrumb gave, in the row that
          already answers "what is narrowing this report?". */}
      {drill.map((step, i) => (
        <button
          key={`${step.member}-${i}`}
          type="button"
          onClick={() => onPopDrill?.(i)}
          title={`Remove ${drillStepLabel(step)}`}
          className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:border-primary"
        >
          {drillStepLabel(step)}
          <X className="h-3 w-3" />
        </button>
      ))}

      {hiddenFacets.length > 0 && (
        <AddFilterMenu facets={hiddenFacets} onAdd={(key) => setRevealed((r) => [...r, key])} />
      )}

      {onReset && (hasActiveFilters(filters) || drill.length > 0) && (
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
  closeOnPick,
}: {
  facet: FilterFacet
  selected: string[]
  onToggle: (value: string) => void
  onClear: () => void
  closeOnPick?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useClickAway(ref, () => setOpen(false))

  const all = facet.options ?? []
  const opts = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? all.filter((o) => o.label.toLowerCase().includes(s)) : all
  }, [all, q])

  const count = selected.length
  const prompt = facet.required && count === 0
  const label =
    count === 0
      ? facet.label
      : count === 1
        ? all.find((o) => o.value === selected[0])?.label ?? `1 ${facet.label}`
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
                  onClick={() => {
                    onToggle(o.value)
                    if (closeOnPick) setOpen(false)
                  }}
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
