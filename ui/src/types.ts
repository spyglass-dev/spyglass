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

export type ValueFormat = 'number' | 'percent' | 'currency' | 'text' | 'date'

export interface MetricSpec extends WidgetBase {
  type: 'metric'
  value: number | string
  label?: string
  format?: ValueFormat
  delta?: { value: number; trend?: 'up' | 'down' | 'flat'; suffix?: string; label?: string }
}

/** Pill tone for categorical cell values (status columns). */
export type PillTone = 'positive' | 'warning' | 'negative' | 'neutral'

export interface TableColumn {
  key: string
  label: string
  format?: ValueFormat
  align?: 'left' | 'right' | 'center'
  /** Render cells as pills: `'band'` tones a percent value by score band
   *  (≥75 green, ≥50 amber, below rose); a map assigns tones to categorical
   *  values (e.g. a status column), unmapped values render neutral. */
  pill?: 'band' | Record<string, PillTone>
  /** Result-column kind (`dimension` | `measure` | `time` | `label` | …) —
   *  what makes a cell drillable (dimensions drill, measures open row mode). */
  kind?: string
  /** The dimension's `drill: { entity }` annotation, for host routing. */
  drillEntity?: string
}

export interface TableSpec extends WidgetBase {
  type: 'table'
  columns: TableColumn[]
  rows: Record<string, unknown>[]
  /** Total matching rows/groups across ALL pages (from the engine's
   *  `include_total`) — what makes "1–25 of 312" possible. */
  total?: number
  /** Set when the engine's row cap clamped the result — the table is a
   *  truncated view, and says so. */
  truncatedAt?: number
  /** The page this data represents (the query's offset/limit). */
  page?: { offset: number; limit?: number }
  /** Current sort, mirrored from the query's `order` (renders the caret). */
  sort?: { key: string; desc: boolean }
  /** Render proportional in-cell bars for this column key (a measure). */
  bars?: string
}

/**
 * `bar` columns · `hbar` bars on their side, for long category names and
 * rankings · `line` / `area` over time · `point` scatter · `arc` a donut for
 * part-to-whole (bounded: past six slices the tail folds into "Other") ·
 * `progress` a CSS meter against a ceiling.
 */
export type ChartMark = 'bar' | 'hbar' | 'line' | 'area' | 'point' | 'arc' | 'progress'

export interface ChartSpec extends WidgetBase {
  type: 'chart'
  chart: {
    mark: ChartMark
    /** Category/x field name within each series row. */
    x?: string
    /** Value/y field name within each series row. An ARRAY means "these
     *  measures on one chart": the rows are folded to long form, one series
     *  per measure. */
    y: string | string[]
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

/** How a pivot edge total aggregates. `avg`/`sum` fold the CELL values; a
 *  `ratio` total divides two OTHER measures summed over the same slice
 *  (`scale` multiplies the quotient, e.g. 100 for percent cells). The ratio
 *  form exists because a mean of per-cell percentages is not a weighted
 *  total — with uneven denominators it inflates small cells, the classic
 *  gradebook lie at the totals edge. */
export type PivotTotal = 'avg' | 'sum' | { ratio: { num: string; den: string; scale?: number } }

/** A pivot: rows × columns × one measure, rendered from an ordinary
 *  two-dimension group-by result. The pivot is a RENDERING — the engine knows
 *  nothing about it. The load-bearing rule: **a missing cell is not a zero.**
 *  An absent combination, a present-but-null value, and a scored zero are
 *  three different states and must look different — conflating them is the
 *  classic way a gradebook lies. */
export interface PivotSpec extends WidgetBase {
  type: 'pivot'
  /** Dimension member key(s) forming row headers (e.g. `["Scores.student_id"]`).
   *  Header text prefers the `"{key}__label"` column when the data carries one. */
  rows: string[]
  /** Dimension member key(s) forming column headers. */
  cols: string[]
  /** The measure member filling cells. */
  measure: string
  /** Flat group-by rows: each carries the row/col dimension values (+ optional
   *  `__label` companions) and the measure. For `ratio` totals the rows also
   *  carry the numerator/denominator measures. */
  data: Record<string, unknown>[]
  /** Edge totals: `row` aggregates across a row (right edge), `col` down a
   *  column (bottom edge). Absent = no totals. `rowLabel`/`colLabel` name the
   *  edges in the domain's words (e.g. "Average" / "Class average") instead
   *  of the generic Total/Avg. */
  totals?: { row?: PivotTotal; col?: PivotTotal; rowLabel?: string; colLabel?: string }
  /** Cell shading (off by default). `sequential` ramps min→max; `diverging`
   *  splits around the midpoint. */
  scale?: 'none' | 'sequential' | 'diverging'
  /** How an ABSENT combination renders: `dash` (default) or `zero`. A present
   *  null still renders as `n/a` — that's a third state, not a rendering
   *  option. */
  empty?: 'dash' | 'zero'
  format?: ValueFormat
}

/** A RESOLVED bound view: a host-registered component plus the data its
 *  query produced. Unlike `custom` (frozen data), a view is live — the
 *  resolver fills `data` from the query under the report's filters and drill
 *  trail, and the component receives the drill callback (`ViewProps`). */
export interface ViewSpec extends WidgetBase {
  type: 'view'
  /** View registry key (`ViewManifest.name`). */
  component: string
  /** Resolved query result (absent for a pure-props view). */
  data?: {
    rows: Record<string, unknown>[]
    columns: { key: string; kind: string }[]
    total?: number
  }
  props?: Record<string, unknown>
  /** Set when the query failed or the manifest's contract was unmet — the
   *  frame renders `widget_error`, never a blank cell. */
  error?: { message: string; detail?: string }
}

export type WidgetSpec =
  | MetricSpec
  | TableSpec
  | ChartSpec
  | NoteSpec
  | CustomSpec
  | PivotSpec
  | ViewSpec

/** A full report: ordered widgets laid out on the grid. */
export interface ReportDoc {
  title?: string
  description?: string
  widgets: WidgetSpec[]
}

/**
 * A stat tile's value is read at a glance, so it is COMPACT and never carries
 * float noise: an average of 2.5906976744 is "2.6", not "2.591". `toLocaleString`
 * with no options keeps three fraction digits and no grouping threshold, which
 * is how a dashboard ends up with `2.591` next to `1,284`.
 *
 * Counts stay exact up to 5 digits and compact above (`12.9K`, `4.2M`) — the
 * magnitude is the message at that size, and the exact figure lives in the
 * table underneath.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (!Number.isInteger(value) && abs < 1000) {
    // A ratio or an average: one decimal, and no trailing ".0".
    return String(Math.round(value * 10) / 10)
  }
  if (abs >= 100_000) {
    return value.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 })
  }
  return Math.round(value).toLocaleString()
}

/**
 * Parse an engine timestamp. Postgres renders `timestamptz::text` as
 * `2026-04-01 00:00:00+00` — a space instead of `T`, and a two-digit offset
 * that `Date.parse` rejects outright (`+00` must be `+00:00`). Both have to be
 * repaired or every date in every client is silently NaN.
 */
export function parseTimestamp(value: number | string): number {
  if (typeof value === 'number') return value
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  return Date.parse(iso)
}

/** A date/datetime cell (`kind: "time"`), rendered short. Engine time values
 *  are ISO-ish text; anything unparseable passes through untouched. */
export function formatDateValue(value: number | string): string {
  const d = new Date(parseTimestamp(value))
  if (Number.isNaN(d.getTime())) return String(value)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

export function formatValue(value: number | string, format?: ValueFormat): string {
  if (format === 'date') return formatDateValue(value)
  if (typeof value === 'string') return value
  if (format === 'percent') return `${Math.round(value * 10) / 10}%`
  if (format === 'currency') return value.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
  if (format === 'number') return formatNumber(value)
  return String(value)
}
