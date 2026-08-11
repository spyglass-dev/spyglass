/**
 * The "all time" marker: a widget the report's date range could not reach
 * carries `applied.dateRangeSkipped`, and the frame must SHOW it — the silent
 * version of this state is the bug the receipt exists to prevent.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReportView } from '../components/ReportView'
import { applyFilters, type BoundWidget, type CubeCapsMap } from '../report'

describe('AllTimeChip in the widget frame', () => {
  it('marks a widget whose cube has no time field — even a title-less metric', () => {
    render(
      <ReportView
        doc={{
          widgets: [
            { type: 'metric', value: 42, label: 'Lifetime rentals', applied: { facets: [], dateRangeSkipped: 'no_time_field' } },
          ],
        }}
      />,
    )
    const chip = screen.getByText('All time')
    expect(chip).toBeTruthy()
    expect(chip.getAttribute('data-reason')).toBe('no_time_field')
    expect(chip.getAttribute('title')).toContain('no time field')
  })

  it('says "Pinned range" when the widget pins its own window', () => {
    render(
      <ReportView
        doc={{
          widgets: [
            {
              type: 'table',
              title: 'This quarter',
              columns: [{ key: 'x', label: 'X' }],
              rows: [],
              applied: { facets: [], dateRangeSkipped: 'widget_pinned' },
            },
          ],
        }}
      />,
    )
    expect(screen.getByText('Pinned range')).toBeTruthy()
    expect(screen.getByText('This quarter')).toBeTruthy()
  })

  it('renders NO chip when the range was applied or no range was active', () => {
    render(
      <ReportView
        doc={{
          widgets: [
            { type: 'metric', value: 1, label: 'Ranged', applied: { facets: [], dateRange: 'Rentals.rented_at' } },
            { type: 'metric', value: 2, label: 'Untouched' },
          ],
        }}
      />,
    )
    expect(screen.queryByText('All time')).toBeNull()
    expect(screen.queryByText('Pinned range')).toBeNull()
  })

  it('end to end: applyFilters receipt drives the chip', () => {
    const caps: CubeCapsMap = { Customers: { dims: ['store_id'] } }
    const widget: BoundWidget = { type: 'bound', as: 'metric', query: { measures: ['Customers.count'] } }
    const { applied } = applyFilters(widget, { datePreset: 'last_30d' }, caps)
    render(<ReportView doc={{ widgets: [{ type: 'metric', value: 599, label: 'Customers', applied }] }} />)
    expect(screen.getByText('All time').getAttribute('data-reason')).toBe('no_time_field')
  })
})
