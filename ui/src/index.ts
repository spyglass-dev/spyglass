/**
 * @spyglass/ui — JSON-expressible reporting widgets.
 *
 * Render a `ReportDoc` (or a single `WidgetSpec`) with standard widgets
 * (metric / table / chart / note) and a custom-component registry. Pairs with
 * the `reporting` engine, which produces the data these specs carry.
 */
export * from './types'
export * from './registry'
export { Widget } from './components/Widget'
export { ReportView } from './components/ReportView'
export { Metric } from './components/Metric'
export { DataTable } from './components/DataTable'
export { Chart } from './components/Chart'
export { Note } from './components/Note'
