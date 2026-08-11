/** Widget — dispatches a WidgetSpec to its renderer (custom + views via
 *  their registries). */
import type { WidgetSpec } from '../types'
import { tokens } from '../tokens'
import type { WidgetRegistry } from '../registry'
import type { ViewRegistry } from '../views'
import type { ReportFilters } from '../filters'
import { DEFAULT_REPORT_FILTERS } from '../filters'
import { Metric } from './Metric'
import { DataGrid, type GridQueryDelta } from './DataGrid'
import { WidgetError } from './WidgetError'
import type { DrillEvent } from '../drill'
import { Chart } from './Chart'
import { Note } from './Note'
import { Pivot } from './Pivot'

const noop = () => {}

export function Widget({
  spec,
  registry,
  views,
  filters,
  onGridQuery,
  onDrill,
  onMeasureClick,
  onRefresh,
}: {
  spec: WidgetSpec
  registry?: WidgetRegistry
  /** Host view registry — required to render `view` widgets. */
  views?: ViewRegistry
  /** Report filters in effect (passed through to view components). */
  filters?: ReportFilters
  /** Server-driven grid handler: table sort/paging emit query deltas here.
   *  Omit for static rendering. */
  onGridQuery?: (delta: GridQueryDelta) => void
  /** Dimension-cell drill handler (tables + views). Omit = not drillable. */
  onDrill?: (event: DrillEvent) => void
  /** Measure-cell row-mode handler (tables). */
  onMeasureClick?: (row: Record<string, unknown>, columnKey: string) => void
  /** Re-resolve this widget's data (passed through to view components). */
  onRefresh?: () => void
}) {
  switch (spec.type) {
    case 'metric':
      return <Metric spec={spec} />
    case 'table':
      return <DataGrid spec={spec} onQuery={onGridQuery} onDrill={onDrill} onMeasureClick={onMeasureClick} />
    case 'chart':
      return <Chart spec={spec} />
    case 'note':
      return <Note spec={spec} />
    case 'pivot':
      // Cells share the table's measure-click contract: the source row
      // carries both axis dimensions, so the records drawer narrows to the
      // exact cell (e.g. one student's answers on one activity).
      return <Pivot spec={spec} onMeasureClick={onMeasureClick} />
    case 'view': {
      // An unmet contract or unknown component renders widget_error — NEVER
      // a blank cell.
      if (spec.error) {
        return (
          <WidgetError
            spec={{ type: 'custom', component: 'widget_error', title: spec.title, data: spec.error }}
          />
        )
      }
      const manifest = views?.[spec.component]
      if (!manifest) {
        return (
          <WidgetError
            spec={{
              type: 'custom',
              component: 'widget_error',
              title: spec.title,
              data: { message: `Unknown view \`${spec.component}\` — is it registered?` },
            }}
          />
        )
      }
      const View = manifest.component
      return (
        <View
          rows={spec.data?.rows ?? []}
          columns={spec.data?.columns ?? []}
          total={spec.data?.total}
          loading={false}
          filters={filters ?? DEFAULT_REPORT_FILTERS}
          drill={onDrill ?? noop}
          refresh={onRefresh ?? noop}
          props={spec.props}
        />
      )
    }
    case 'custom': {
      const Custom = registry?.[spec.component]
      if (!Custom) {
        return (
          <div style={{ color: tokens.textFaint, fontSize: 13 }}>
            Unknown widget: {spec.component}
          </div>
        )
      }
      return <Custom spec={spec} />
    }
    default:
      return null
  }
}
