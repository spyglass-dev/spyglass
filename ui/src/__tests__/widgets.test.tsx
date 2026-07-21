import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReportView } from '../components/ReportView'
import { Widget } from '../components/Widget'
import type { ReportDoc } from '../types'
import type { WidgetRegistry } from '../registry'

describe('reporting widgets', () => {
  it('renders a metric value with percent format', () => {
    render(<Widget spec={{ type: 'metric', value: 82, format: 'percent', label: 'Return rate' }} />)
    expect(screen.getByText('82%')).toBeTruthy()
    expect(screen.getByText('Return rate')).toBeTruthy()
  })

  it('renders a table cell from JSON rows', () => {
    render(
      <Widget
        spec={{
          type: 'table',
          columns: [{ key: 'name', label: 'Customer' }, { key: 'spend', label: 'Spend', format: 'currency' }],
          rows: [{ name: 'Karl Seal', spend: 221 }],
        }}
      />,
    )
    expect(screen.getByText('Karl Seal')).toBeTruthy()
    expect(screen.getByText('$221.00')).toBeTruthy()
  })

  it('renders a full ReportDoc with title', () => {
    const doc: ReportDoc = {
      title: 'Store performance',
      widgets: [
        { type: 'metric', value: 599, label: 'Active customers', w: 1 },
        { type: 'chart', title: 'Revenue by store', chart: { mark: 'bar', x: 'store', y: 'revenue', series: [{ store: 'Store 1', revenue: 3 }] } },
      ],
    }
    render(<ReportView doc={doc} />)
    expect(screen.getByText('Store performance')).toBeTruthy()
    expect(screen.getByText('Active customers')).toBeTruthy()
    expect(screen.getByText('Revenue by store')).toBeTruthy()
  })

  it('dispatches custom widgets through the registry', () => {
    const registry: WidgetRegistry = {
      gauge: ({ spec }) => <div>gauge:{String((spec.data as { v: number }).v)}</div>,
    }
    render(<Widget spec={{ type: 'custom', component: 'gauge', data: { v: 7 } }} registry={registry} />)
    expect(screen.getByText('gauge:7')).toBeTruthy()
  })

  it('shows a fallback for an unregistered custom widget', () => {
    render(<Widget spec={{ type: 'custom', component: 'nope' }} />)
    expect(screen.getByText(/Unknown widget/)).toBeTruthy()
  })
})
