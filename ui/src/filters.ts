/**
 * Report filters — a small, host-agnostic model for scoping a whole report,
 * plus relative date-range presets. The `FilterBar` edits this object; a host
 * decides how to apply it to its own query engine (which cubes/dimensions a
 * filter touches, whether a widget opts out). Kept dependency-free.
 */

/** Relative date-range presets — resolve to a live window on each run. */
export type DateRangePreset =
  | 'last_1h'
  | 'last_24h'
  | 'last_7d'
  | 'last_30d'
  | 'last_90d'
  | 'this_week'
  | 'this_month'
  | 'ytd'
  | 'all'

/**
 * Report-wide filters. `datePreset` (relative) wins over `dateFrom`/`dateTo`
 * (absolute custom). `facets` maps a dimension key (e.g. `status`) to the
 * selected values — a host applies these to the widgets whose cube supports
 * the dimension.
 */
export interface ReportFilters {
  datePreset?: DateRangePreset
  dateFrom?: string
  dateTo?: string
  facets?: Record<string, string[]>
}

/** A pickable facet the FilterBar renders as a labelled chip group. */
export interface FilterFacet {
  /** Dimension key the host filters on (e.g. `status`, `class_id`). */
  key: string
  label: string
  options: { value: string; label: string }[]
}

/** The default filters a new report starts with — a bounded, recent window. */
export const DEFAULT_REPORT_FILTERS: ReportFilters = { datePreset: 'last_30d' }

/** Ordered presets + labels for the picker. */
export const DATE_PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'last_1h', label: 'Last hour' },
  { value: 'last_24h', label: 'Last 24 hours' },
  { value: 'last_7d', label: 'Last 7 days' },
  { value: 'last_30d', label: 'Last 30 days' },
  { value: 'last_90d', label: 'Last 90 days' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'all', label: 'All time' },
]

const PRESET_LABEL = Object.fromEntries(DATE_PRESETS.map((p) => [p.value, p.label])) as Record<
  DateRangePreset,
  string
>

/** Resolve a relative preset to a live `[fromISO, toISO]` window (or null for
 *  "all time"). Full timestamps, so sub-day ranges (last hour) work. */
export function resolveDatePreset(preset: DateRangePreset): [string, string] | null {
  if (preset === 'all') return null
  const now = new Date()
  const to = now.toISOString()
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const H = 3_600_000
  const D = 86_400_000
  switch (preset) {
    case 'last_1h':
      return [ago(H), to]
    case 'last_24h':
      return [ago(24 * H), to]
    case 'last_7d':
      return [ago(7 * D), to]
    case 'last_30d':
      return [ago(30 * D), to]
    case 'last_90d':
      return [ago(90 * D), to]
    case 'this_week': {
      const d = new Date(now)
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // Monday start
      return [d.toISOString(), to]
    }
    case 'this_month':
      return [new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), to]
    case 'ytd':
      return [new Date(now.getFullYear(), 0, 1).toISOString(), to]
    default:
      return null
  }
}

/** The effective `[from, to]` for a report's filters (preset or custom), or
 *  null when no date scope applies. */
export function resolveDateRange(f: ReportFilters): [string, string] | null {
  if (f.datePreset) return resolveDatePreset(f.datePreset)
  if (f.dateFrom || f.dateTo) return [f.dateFrom || '1970-01-01', f.dateTo || '2999-12-31']
  return null
}

/** Human label for the current date range (for the picker trigger). */
export function dateRangeLabel(f: ReportFilters): string {
  if (f.datePreset) return PRESET_LABEL[f.datePreset]
  if (f.dateFrom || f.dateTo) {
    const fmt = (s?: string) =>
      s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '…'
    return `${fmt(f.dateFrom)} – ${fmt(f.dateTo)}`
  }
  return 'All time'
}

/** True when any filter is set beyond the default. */
export function hasActiveFilters(f?: ReportFilters): boolean {
  if (!f) return false
  const facetsActive = Object.values(f.facets ?? {}).some((v) => v.length > 0)
  return !!f.datePreset || !!f.dateFrom || !!f.dateTo || facetsActive
}
