import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReportView } from '../components/ReportView'
import { Widget } from '../components/Widget'
import type { ReportDoc } from '../types'
import type { WidgetRegistry } from '../registry'

describe('reporting widgets', () => {
  it('renders a metric value with percent format', () => {
    render(<Widget spec={{ type: 'metric', value: 82, format: 'percent', label: 'Completion' }} />)
    expect(screen.getByText('82%')).toBeTruthy()
    expect(screen.getByText('Completion')).toBeTruthy()
  })

  it('renders a table cell from JSON rows', () => {
    render(
      <Widget
        spec={{
          type: 'table',
          columns: [{ key: 'name', label: 'Student' }, { key: 'avg', label: 'Avg', format: 'percent' }],
          rows: [{ name: 'Ada', avg: 88 }],
        }}
      />,
    )
    expect(screen.getByText('Ada')).toBeTruthy()
    expect(screen.getByText('88%')).toBeTruthy()
  })

  it('renders a full ReportDoc with title', () => {
    const doc: ReportDoc = {
      title: 'Term Review',
      widgets: [
        { type: 'metric', value: 5, label: 'To grade', w: 1 },
        { type: 'chart', title: 'Activity', chart: { mark: 'bar', x: 'k', y: 'v', series: [{ k: 'A', v: 3 }] } },
      ],
    }
    render(<ReportView doc={doc} />)
    expect(screen.getByText('Term Review')).toBeTruthy()
    expect(screen.getByText('To grade')).toBeTruthy()
    expect(screen.getByText('Activity')).toBeTruthy()
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
