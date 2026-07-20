/**
 * @spyglass/ui — JSON-expressible reporting widgets.
 *
 * Render a `ReportDoc` (or a single `WidgetSpec`) with standard widgets
 * (metric / table / chart / note) and a custom-component registry. Pairs with
 * the `reporting` engine, which produces the data these specs carry.
 */
export * from './types'
export * from './registry'
export * from './filters'
export * from './querybuilder'
export * from './report'
export * from './distri'
export { Widget } from './components/Widget'
export { ReportView } from './components/ReportView'
export { Metric } from './components/Metric'
export { DataTable } from './components/DataTable'
export { Chart } from './components/Chart'
export { Note } from './components/Note'
export { FilterBar } from './components/FilterBar'
export { DateRangePicker } from './components/DateRangePicker'
export { QueryBuilder } from './components/QueryBuilder'
export { ReportCanvas, type ReportCanvasProps } from './components/ReportCanvas'
export { WidgetError, humanizeWidgetError, type WidgetErrorData } from './components/WidgetError'
export { ReportLoading } from './components/ReportLoading'
export { ReportEmptyState, type ReportEmptyStateProps } from './components/ReportEmptyState'
