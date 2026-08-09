/** Widget — dispatches a WidgetSpec to its renderer (custom via registry). */
import type { WidgetSpec } from '../types'
import type { WidgetRegistry } from '../registry'
import { Metric } from './Metric'
import { DataTable } from './DataTable'
import { Chart } from './Chart'
import { Note } from './Note'
import { Pivot } from './Pivot'

export function Widget({ spec, registry }: { spec: WidgetSpec; registry?: WidgetRegistry }) {
  switch (spec.type) {
    case 'metric':
      return <Metric spec={spec} />
    case 'table':
      return <DataTable spec={spec} />
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
          <div style={{ color: '#9ca3af', fontSize: 13 }}>
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
