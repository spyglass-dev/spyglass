/**
 * The reporting widget spec — every widget is fully expressible as JSON.
 *
 * The package is presentational: a widget carries the DATA it renders (value,
 * rows, series). The host/studio resolves a bound query (against the reporting
 * engine) into one of these data-bearing specs, then hands it here. This keeps
 * rendering portable and the data layer swappable.
 */

/** 1–4 column span in the report grid. */
export type WidgetWidth = 1 | 2 | 3 | 4

/** Why an active report date range did not reach a widget's query. */
export type DateRangeSkipReason =
  /** The cube declares no time field, so there is nothing to filter on. */
  | 'no_time_field'
  /** The widget opted out (`filters.ignore` or `filters.dateField: null`). */
  | 'opted_out'
  /** The widget's own query already pins a filter on the time member. */
  | 'widget_pinned'
  /** The host declared no capabilities for the query's cube. */
  | 'unknown_cube'

/**
 * Which report-wide filters actually reached a widget's query — the receipt
 * `applyFilters` hands back so nothing is ever skipped silently. A widget
 * frame renders an "all time" marker from `dateRangeSkipped`.
 */
export interface AppliedFilters {
  /** Facet keys pushed into the query as IN filters. */
  facets: string[]
  /** Member the report date range was applied on (e.g. `Orders.created_at`). */
  dateRange?: string
  /** Set when the report had an active date range this widget did not receive.
   *  Absent when the range was applied — or no range was active at all. */
  dateRangeSkipped?: DateRangeSkipReason
}

export interface WidgetBase {
  id?: string
  title?: string
  /** Grid width (of 4). Defaults to full width (4). */
  w?: WidgetWidth
  /** Which report filters reached this widget's query (set by the resolver
   *  on bound widgets; absent on static specs). */
  applied?: AppliedFilters
}

export type ValueFormat = 'number' | 'percent' | 'currency' | 'text'

export interface MetricSpec extends WidgetBase {
  type: 'metric'
  value: number | string
  label?: string
  format?: ValueFormat
  delta?: { value: number; trend?: 'up' | 'down' | 'flat'; suffix?: string }
}

export interface TableColumn {
  key: string
  label: string
  format?: ValueFormat
  align?: 'left' | 'right' | 'center'
}

export interface TableSpec extends WidgetBase {
  type: 'table'
  columns: TableColumn[]
  rows: Record<string, unknown>[]
}

export type ChartMark = 'bar' | 'line' | 'area' | 'point' | 'progress'

export interface ChartSpec extends WidgetBase {
  type: 'chart'
  chart: {
    mark: ChartMark
    /** Category/x field name within each series row. */
    x?: string
    /** Value/y field name within each series row. */
    y: string
    series: Record<string, unknown>[]
    /** Optional field to split into colored series — grouped/stacked bars,
     *  multi-line charts, etc. */
    color?: string
    /** For bar/area with `color`: stack the series (default). `false` groups
     *  them side-by-side instead. */
    stack?: boolean
    /** For `progress`: the max value (defaults to 100). */
    max?: number
    format?: ValueFormat
    /** Escape hatch: a full Vega-Lite spec. When present it renders directly
     *  (with `series` injected as the default `data.values` if the spec omits
     *  its own data) and `mark`/`x`/`y`/`color` are ignored. Use for charts the
     *  compact encoding can't express (layered, faceted, heatmaps, dual-axis). */
    vlSpec?: Record<string, unknown>
  }
}

export interface NoteSpec extends WidgetBase {
  type: 'note'
  /** Markdown source. The base renderer shows it as text; hosts can register
   *  a richer `note` via the custom registry. */
  markdown: string
}

/** A widget rendered by a host-registered custom component. The `data` is
 *  whatever the custom component declares it needs — "components that define
 *  the data format." */
export interface CustomSpec extends WidgetBase {
  type: 'custom'
  component: string
  data?: unknown
  props?: Record<string, unknown>
}

export type WidgetSpec =
  | MetricSpec
  | TableSpec
  | ChartSpec
  | NoteSpec
  | CustomSpec

/** A full report: ordered widgets laid out on the grid. */
export interface ReportDoc {
  title?: string
  description?: string
  widgets: WidgetSpec[]
}

export function formatValue(value: number | string, format?: ValueFormat): string {
  if (typeof value === 'string') return value
  if (format === 'percent') return `${Math.round(value)}%`
  if (format === 'currency') return value.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
  if (format === 'number') return value.toLocaleString()
  return String(value)
}
