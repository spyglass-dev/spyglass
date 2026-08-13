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
export * from './drill'
export * from './urlstate'
export * from './digest'
export * from './validate'
export * from './views'
export * from './report'
export * from './report.schema'
export * from './distri'
export * from './reports/store'
export * from './reports/serverStore'
export * from './reports/edit-tools'
export * from './reports/references'
export * from './reports/session'
export * from './reports/guards'
export * from './reports/outcome'
export * from './reports/useReportModel'
export { Widget } from './components/Widget'
export { AllTimeChip } from './components/AllTimeChip'
export { ReportView } from './components/ReportView'
export { Metric } from './components/Metric'
export { DataTable } from './components/DataTable'
export {
  DataGrid,
  virtualWindow,
  visibleColumns,
  cellValue,
  pageLabel,
  tableToCsv,
  VIRTUALIZE_AT,
  type GridQueryDelta,
} from './components/DataGrid'
export { tokens, type Tokens } from './tokens'
export { DrillBreadcrumb } from './components/DrillBreadcrumb'
export { Explore, type ExploreProps } from './components/Explore'
export { Chart } from './components/Chart'
export { Note } from './components/Note'
export {
  Pivot,
  buildPivot,
  cellShade,
  MAX_PIVOT_ROWS,
  MAX_PIVOT_COLS,
  type BuiltPivot,
  type PivotCell,
  type PivotAxisItem,
} from './components/Pivot'
export { FilterBar, type FacetRenderer } from './components/FilterBar'
export { DateRangePicker } from './components/DateRangePicker'
export { QueryBuilder } from './components/QueryBuilder'
export { ReportCanvas, type ReportCanvasProps } from './components/ReportCanvas'
export { WidgetError, humanizeWidgetError, type WidgetErrorData } from './components/WidgetError'
export { ReportLoading } from './components/ReportLoading'
export {
  ReportEmptyState,
  type EmptyStateSuggestion,
  type ReportEmptyStateProps,
} from './components/ReportEmptyState'
export {
  WidgetPromptDialog,
  type WidgetPromptDialogProps,
  type WidgetPromptState,
} from './components/WidgetPromptDialog'
