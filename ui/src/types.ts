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

export interface WidgetBase {
  id?: string
  title?: string
  /** Grid width (of 4). Defaults to full width (4). */
  w?: WidgetWidth
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

export type ChartMark = 'bar' | 'line' | 'area' | 'progress'

export interface ChartSpec extends WidgetBase {
  type: 'chart'
  chart: {
    mark: ChartMark
    /** Category/x field name within each series row. */
    x?: string
    /** Value/y field name within each series row. */
    y: string
    series: Record<string, unknown>[]
    /** For `progress`: the max value (defaults to 100). */
    max?: number
    format?: ValueFormat
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
