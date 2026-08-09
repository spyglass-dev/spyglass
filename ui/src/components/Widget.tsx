/** Widget — dispatches a WidgetSpec to its renderer (custom via registry). */
import type { WidgetSpec } from '../types'
import { tokens } from '../tokens'
import type { WidgetRegistry } from '../registry'
import { Metric } from './Metric'
import { DataGrid, type GridQueryDelta } from './DataGrid'
import { Chart } from './Chart'
import { Note } from './Note'
import { Pivot } from './Pivot'

export function Widget({
  spec,
  registry,
  onGridQuery,
}: {
  spec: WidgetSpec
  registry?: WidgetRegistry
  /** Server-driven grid handler: table sort/paging emit query deltas here.
   *  Omit for static rendering. */
  onGridQuery?: (delta: GridQueryDelta) => void
}) {
  switch (spec.type) {
    case 'metric':
      return <Metric spec={spec} />
    case 'table':
      return <DataGrid spec={spec} onQuery={onGridQuery} />
    case 'chart':
      return <Chart spec={spec} />
    case 'note':
      return <Note spec={spec} />
    case 'pivot':
      return <Pivot spec={spec} />
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
